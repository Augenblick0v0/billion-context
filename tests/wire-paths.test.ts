import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { findRoute, loadRoutes, parseRouteEntry, resolveCustomWireProtocol, type ProviderRoutes } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

test("parseRouteEntry: wirePaths round-trips and coexists with other fields", () => {
    const route = parseRouteEntry({
        models: { "m1": { context: 100000 } },
        passthrough: false,
        wirePaths: [
            { suffix: "/v1/code/sessions", protocol: "openai" },
            { suffix: "/custom/messages", protocol: "anthropic" },
        ],
    });
    assert.deepEqual(route?.wirePaths, [
        { suffix: "/v1/code/sessions", protocol: "openai" },
        { suffix: "/custom/messages", protocol: "anthropic" },
    ]);
    assert.equal(route?.passthrough, false);
    assert.ok(route?.models);
});

test("parseRouteEntry: absent wirePaths leaves the field absent", () => {
    const route = parseRouteEntry({ models: { "m": { context: 128000 } } });
    assert.equal(route?.wirePaths, undefined);
});

for (const [label, value] of [
    ["non-array", { wirePaths: {} }],
    ["empty array", { wirePaths: [] }],
    ["entry not an object", { wirePaths: ["/foo"] }],
    ["suffix without leading slash", { wirePaths: [{ suffix: "foo", protocol: "openai" }] }],
    ["missing suffix", { wirePaths: [{ protocol: "openai" }] }],
    ["unknown protocol", { wirePaths: [{ suffix: "/foo", protocol: "mistral" }] }],
    ["protocol not a string", { wirePaths: [{ suffix: "/foo", protocol: 42 }] }],
] as const) {
    test(`parseRouteEntry: malformed wirePaths throw loudly (${label})`, () => {
        assert.throws(() => parseRouteEntry(value), /\[acp-config\]/);
    });
}

test("resolveCustomWireProtocol: longest-prefix route key wins", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": { wirePaths: [{ suffix: "/shallow", protocol: "openai" }] },
        "https://relay.example.com/api": { wirePaths: [{ suffix: "/deep", protocol: "responses" }] },
    };
    assert.equal(resolveCustomWireProtocol(routes, "https://relay.example.com/api/deep?q=1", "/api/deep"), "responses");
    assert.equal(resolveCustomWireProtocol(routes, "https://relay.example.com/shallow", "/shallow"), "openai");
});

test("resolveCustomWireProtocol: first matching rule in array order wins", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": {
            wirePaths: [
                { suffix: "/sessions", protocol: "responses" },
                { suffix: "/sessions", protocol: "openai" },
            ],
        },
    };
    assert.equal(resolveCustomWireProtocol(routes, "https://relay.example.com/v1/sessions", "/v1/sessions"), "responses");
});

test("resolveCustomWireProtocol: no match / no route / no rules → null (builtin fallback)", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": { wirePaths: [{ suffix: "/only-this", protocol: "openai" }] },
        "https://other.example.com": {},
    };
    assert.equal(resolveCustomWireProtocol(routes, "https://relay.example.com/something-else", "/something-else"), null);
    assert.equal(resolveCustomWireProtocol(routes, "https://other.example.com/x", "/x"), null);
    assert.equal(resolveCustomWireProtocol(routes, "https://unconfigured.example.com/x", "/x"), null);
    assert.equal(resolveCustomWireProtocol(routes, undefined, "/x"), null);
});

test("resolveCustomWireProtocol: mitm:// keys match only mitm-form lookups (same keying as other provider fields)", () => {
    const routes: ProviderRoutes = {
        "mitm://desktop.example.com": { wirePaths: [{ suffix: "/v1/code/sessions", protocol: "openai" }] },
    };
    assert.equal(resolveCustomWireProtocol(routes, "mitm://desktop.example.com/v1/code/sessions", "/v1/code/sessions"), "openai");
    assert.equal(resolveCustomWireProtocol(routes, "https://desktop.example.com/v1/code/sessions", "/v1/code/sessions"), null);
    assert.equal(findRoute(routes, "https://desktop.example.com/v1/code/sessions")?.wirePaths, undefined);
});

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface SeenRequest {
    path: string;
    body: string;
    headers: http.IncomingHttpHeaders;
}

function upstreamServer(response: Record<string, unknown>, onBody: (req: SeenRequest) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            onBody({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(response));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness {
    proxyPort: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstreamPort: number, providers: Record<string, unknown>, injectTool: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-wire-paths-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, JSON.stringify({ providers }), "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const opts = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct" as const,
        proxySource: "direct" as const,
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool, injectNudge: false },
        promptCache: { routing: "auto" as const },
        compat: { roles: {} },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        },
    };
}

const OPENAI_BODY = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ping" }] });
const OPENAI_RESPONSE = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const ANTHROPIC_BODY = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "ping" }] });
const ANTHROPIC_RESPONSE = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "pong" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
};

test("wirePaths: custom-path POST enters the compression pipeline (was verbatim passthrough)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(OPENAI_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}`]: { wirePaths: [{ suffix: "/v1/code/sessions", protocol: "openai" }] },
    }, true);
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/code/sessions`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200, "processed request must still reach the client cleanly");
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/v1/code/sessions");
        assert.ok(seen[0].headers["x-bili-hop"], "pipeline-processed requests carry the x-bili-hop marker — proof this was NOT a verbatim passthrough");
        const forwarded = JSON.parse(seen[0].body) as { tools?: Array<{ function?: { name?: string } }> };
        assert.ok(forwarded.tools?.some((t) => t.function?.name === "compress"), "recognized openai endpoint gets the compress tool injected");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("control: same custom path without wirePaths stays a verbatim passthrough", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(OPENAI_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {}, true);
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/code/sessions`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/v1/code/sessions");
        assert.equal(seen[0].headers["x-bili-hop"], undefined, "unrecognized path must stay a passthrough (no hop marker)");
        assert.equal(seen[0].body, OPENAI_BODY, "passthrough relays the original bytes untouched");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("wirePaths outranks the built-in table: anthropic rule on a /chat/completions-shaped path", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(ANTHROPIC_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}`]: { wirePaths: [{ suffix: "/chat/completions", protocol: "anthropic" }] },
    }, true);
    try {
        // Without the rule the built-in table would claim this path as openai and the
        // anthropic-shaped body would be relayed verbatim by the #1284 guard (no hop
        // marker). With the rule the anthropic pipeline must own it end-to-end.
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: ANTHROPIC_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"], "the user-declared rule must win over the built-in openai claim");
        const forwarded = JSON.parse(seen[0].body) as { system?: unknown; messages?: unknown };
        assert.ok(Array.isArray(forwarded.messages), "forwarded through the anthropic wire shape (messages preserved)");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
