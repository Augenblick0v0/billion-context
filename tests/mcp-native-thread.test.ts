// #2024: consume Codex's per-call _meta.threadId in the MCP shim. Codex >=0.160
// stamps the REAL thread id on every tools/call (codex-rs core/src/mcp_tool_call.rs
// with_mcp_tool_call_ids_meta); the shim used to ignore it and kept routing on the
// stale BILI_CONVERSATION_ID baked into the generated MCP config, so in Code Mode
// (no outbound witness) every compress/decompress/status/cache/search call failed
// with "unknown plugin conversation". Three layers pin the fix:
//   layer 1  shim contract — the REAL src/mcp.ts over stdio against a mock proxy
//            capturing the exact POST bodies (nativeCaller flag, routing key, the
//            #841 search-target exception, malformed-metadata safety, no clobber);
//   layer 2  proxy routing policy — the REAL startServer: a flagged nativeCaller
//            outranks a conflicting unique witness, while an unflagged call keeps
//            the byte-for-byte #1685 ladder (witness still wins);
//   layer 3  incident-shape e2e — real server + real shim over stdio with a stale
//            env id: interleaved main/child threads route natively, and a
//            meta-less call still fails against the untouched residue.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (auto-restart.test.ts pattern): otherwise
// loadConversations() at boot would read the developer's production
// plugin-conversations.json and count live sessions toward arbitration.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-mcp-native-thread-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

// ── layer 1: mock proxy that records every POST body verbatim ────────────────
type Post = { url: string; body: Record<string, unknown> };

async function startMock(): Promise<{ port: number; posts: Post[]; stop(): Promise<void> }> {
    const posts: Post[] = [];
    const mock = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            if (req.method === "POST") posts.push({ url: req.url ?? "", body });
            res.writeHead(200, { "content-type": "application/json" });
            if ((req.url ?? "").startsWith("/__bili/plugin/manifest")) {
                res.end(JSON.stringify({
                    ok: true, version: "t", protocolVersion: 1, toolNames: [],
                    tools: {
                        anthropic: [
                            { name: "acp_status", description: "", input_schema: { type: "object", properties: {}, required: [] } },
                            { name: "search_context", description: "", input_schema: { type: "object", properties: { query: { type: "string" }, conversation_id: { type: "string" } }, required: ["query"] } },
                        ],
                        openai: [], responses: [],
                    },
                    headers: {}, toolEndpoint: "/__bili/plugin/tool", statusEndpoint: "/__bili/plugin/status",
                }));
            } else if ((req.url ?? "").startsWith("/__bili/plugin/register")) {
                res.end(JSON.stringify({ ok: true }));
            } else if ((req.url ?? "").startsWith("/__bili/plugin/status")) {
                res.end(JSON.stringify({ ok: false, error: "not found" }));
            } else if (body.conversationId === "GHOST") {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: 'unknown plugin conversation id "GHOST" (no model request has arrived with this conversation id yet)' }));
            } else {
                res.end(JSON.stringify({ ok: true, result: "fine" }));
            }
        });
    });
    mock.listen(0, "127.0.0.1");
    await listen(mock);
    const port = (mock.address() as { port: number }).port;
    return { port, posts, stop: async () => { await close(mock); } };
}

// Persistent stdio harness for the REAL shim (issue760 spawnShell pattern). Env
// is spread from process.env so PATH/SystemRoot survive on every platform.
interface ShellHarness {
    send(msg: unknown): void;
    lines: string[];
    kill(): void;
}

function spawnShell(env: Record<string, string>): ShellHarness {
    const shell = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    shell.stdout.on("data", (d: Buffer) => {
        for (const l of d.toString().split("\n")) if (l.trim()) lines.push(l.trim());
    });
    shell.stderr.on("data", () => {});
    return {
        send: (msg) => shell.stdin.write(JSON.stringify(msg) + "\n"),
        lines,
        kill: () => shell.kill(),
    };
}

function hasId(lines: string[], n: number): boolean {
    return lines.some((l) => { try { return (JSON.parse(l) as { id?: number }).id === n; } catch { return false; } });
}

function byId(lines: string[], n: number): { result?: { content?: Array<{ text?: string }>; isError?: boolean } } {
    const hit = lines.find((l) => { try { return (JSON.parse(l) as { id?: number }).id === n; } catch { return false; } });
    return hit ? (JSON.parse(hit) as ReturnType<typeof byId>) : {};
}

function textOf(lines: string[], n: number): string {
    return byId(lines, n).result?.content?.map((c) => c.text ?? "").join("") ?? "";
}

function handshake(h: ShellHarness): void {
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

test("layer 1: a host-stamped _meta.threadId is forwarded as nativeCaller and becomes the routing key", async () => {
    const m = await startMock();
    const h = spawnShell({ BILI_MCP_PROXY: `http://127.0.0.1:${m.port}`, BILI_CONVERSATION_ID: "", CLAUDE_CODE_SESSION_ID: "" });
    try {
        handshake(h);
        h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "acp_status", arguments: {}, _meta: { threadId: "thread-one" } } });
        await waitFor(() => hasId(h.lines, 2), "native acp_status reply");
        assert.equal(byId(h.lines, 2).result?.isError, false, `native call succeeded: ${textOf(h.lines, 2)}`);
        const post = m.posts.find((p) => p.url.startsWith("/__bili/plugin/tool"));
        assert.equal(post?.body.conversationId, "thread-one", "routes on the host-stamped thread id, not the (empty) env binding");
        assert.equal(post?.body.nativeCaller, true, "flags the host-stamped origin for the proxy");
    } finally {
        h.kill();
        await m.stop();
    }
});

test("layer 1: a native search_context keeps args.conversation_id read-only even with no default binding", async () => {
    const m = await startMock();
    const h = spawnShell({ BILI_MCP_PROXY: `http://127.0.0.1:${m.port}`, BILI_CONVERSATION_ID: "", CLAUDE_CODE_SESSION_ID: "" });
    try {
        handshake(h);
        h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_context", arguments: { query: "probe", conversation_id: "other-thread" }, _meta: { threadId: "thread-one" } } });
        await waitFor(() => hasId(h.lines, 2), "native search_context reply");
        assert.equal(byId(h.lines, 2).result?.isError, false, `native search succeeded: ${textOf(h.lines, 2)}`);
        const post = m.posts.find((p) => p.url.startsWith("/__bili/plugin/tool"));
        assert.equal(post?.body.conversationId, "thread-one", "routes to the caller's own thread");
        assert.equal(post?.body.nativeCaller, true, "native flag present");
        assert.deepEqual(post?.body.args, { query: "probe", conversation_id: "other-thread" }, "#841 extended: the cross-session target stays in args (read-only) instead of being mistaken for the caller");
    } finally {
        h.kill();
        await m.stop();
    }
});

test("layer 1: a malformed _meta.threadId is treated as ABSENT — legacy per-call routing, no nativeCaller", async () => {
    const m = await startMock();
    const h = spawnShell({ BILI_MCP_PROXY: `http://127.0.0.1:${m.port}`, BILI_CONVERSATION_ID: "", CLAUDE_CODE_SESSION_ID: "" });
    try {
        handshake(h);
        // Non-string threadId (a number) must be ignored so a bad host payload
        // can never shadow the legacy per-call conversation_id channel.
        h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: "legacy-x" }, _meta: { threadId: 42 } } });
        await waitFor(() => hasId(h.lines, 2), "malformed-meta reply");
        assert.equal(byId(h.lines, 2).result?.isError, false, `legacy call succeeded: ${textOf(h.lines, 2)}`);
        const post = m.posts.find((p) => p.url.startsWith("/__bili/plugin/tool"));
        assert.equal(post?.body.conversationId, "legacy-x", "falls back to the per-call conversation_id");
        assert.equal(post?.body.nativeCaller, undefined, "malformed metadata never sets the native flag");
    } finally {
        h.kill();
        await m.stop();
    }
});

test("layer 1: a per-call threadId never overwrites the shim's global binding (main/sub-agent clobber guard)", async () => {
    const m = await startMock();
    const h = spawnShell({ BILI_MCP_PROXY: `http://127.0.0.1:${m.port}`, BILI_CONVERSATION_ID: "default-env", CLAUDE_CODE_SESSION_ID: "" });
    try {
        handshake(h);
        h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "acp_status", arguments: {}, _meta: { threadId: "child-t" } } });
        await waitFor(() => hasId(h.lines, 2), "child-threaded reply");
        const childPost = m.posts.find((p) => p.url.startsWith("/__bili/plugin/tool") && p.body.conversationId === "child-t");
        assert.ok(childPost, "child call routed on the per-call thread id");
        assert.equal(childPost?.body.nativeCaller, true, "child call is flagged native");

        // A subsequent META-LESS call on the SAME process must still use the
        // original env binding — proving the child's threadId was per-call only.
        h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acp_status", arguments: {} } });
        await waitFor(() => hasId(h.lines, 3), "meta-less reply");
        const envPost = m.posts.find((p) => p.url.startsWith("/__bili/plugin/tool") && p.body.conversationId === "default-env");
        assert.ok(envPost, "meta-less call still routes on the untouched global env binding");
        assert.equal(envPost?.body.nativeCaller, undefined, "meta-less call is not native");
    } finally {
        h.kill();
        await m.stop();
    }
});

// ── layers 2 & 3: real proxy upstream (WITNESS marker relay) + startServer ────
type Relay = { server: http.Server; requests: { conv: string | undefined; body: string }[] };

function startRelay(): Relay {
    const requests: { conv: string | undefined; body: string }[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const conv = req.headers["x-bili-plugin-conversation"];
            requests.push({ conv: Array.isArray(conv) ? conv[0] : conv, body });
            const marker = /WITNESS:([a-z_]+)/.exec(body)?.[1];
            res.writeHead(200, { "content-type": "application/json" });
            if (marker) {
                // Non-stream JSON carrying a tool_call: recording lane 5 (#1692)
                // stamps an outbound witness for (name, arguments).
                res.end(JSON.stringify({
                    id: "r1", object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: marker, arguments: "{}" } }] }, finish_reason: "tool_calls" }],
                    usage: { prompt_tokens: 100, completion_tokens: 2 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    server.listen(0, "127.0.0.1");
    return { server, requests };
}

type Harness = { baseUrl: string; chatUrl: string; stop(): Promise<void> };

async function boot(): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    const relay = startRelay();
    await listen(relay.server);
    const relayPort = (relay.server.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {}),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        chatUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
        stop: async () => {
            await close(proxy);
            await close(relay.server);
        },
    };
}

async function modelTurn(h: Harness, conv: string, userText: string): Promise<void> {
    const res = await fetch(h.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv, "x-bili-plugin-model": "gpt-test" },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: userText }] }),
    });
    assert.equal(res.status, 200, `model turn for ${conv} must succeed`);
    await res.json();
}

async function toolPost(h: Harness, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

test("layer 2: an UNMARKED differing body id still loses to a unique outbound witness (#1685 control)", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "conv-b", "WITNESS:acp_status streamed by this turn");
        // Body id differs from the witness owner and carries NO nativeCaller flag:
        // the #1685 ladder must be byte-for-byte unchanged, so the witness wins.
        const r = await toolPost(h, { tool: "acp_status", conversationId: "decoy-unmarked" });
        assert.equal(r.status, 200, "unmarked call routes by the unique outbound witness (#1685 preserved)");
        assert.equal(r.json?.ok, true);
    } finally {
        await h.stop();
    }
});

test("layer 2: a flagged nativeCaller outranks a conflicting unique witness — unresolvable id fails loudly, no witness rescue", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "conv-b", "WITNESS:acp_status streamed by this turn");
        // Identical body to the control plus the host-stamped flag: rung 0 now
        // owns the decision, tries to resolve the id, and must NOT fall back to
        // the conflicting witness (a collision, not truth).
        const r = await toolPost(h, { tool: "acp_status", conversationId: "decoy-native", nativeCaller: true });
        assert.equal(r.status, 404, "flagged call must not be rescued by the conflicting witness");
        assert.match(String(r.json?.error), /no model request has arrived/, "#1158 diagnostic, no silent adoption");
    } finally {
        await h.stop();
    }
});

test("layer 3: stale env id + interleaved main/child threads route natively; a meta-less call still fails on the untouched residue", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "thread-main", "plain main-thread turn");
        await modelTurn(h, "thread-child", "plain child-thread turn");
        resetToolRingForTest();
        // The shim is spawned with a STALE baked-in env id (the incident shape:
        // the generated MCP config points at a conversation that never reached this
        // proxy). Only the per-call _meta.threadId should make the calls work.
        const mcp = spawnShell({ BILI_MCP_PROXY: h.baseUrl, BILI_CONVERSATION_ID: "stale-env-id", CLAUDE_CODE_SESSION_ID: "" });
        try {
            handshake(mcp);
            mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "acp_status", arguments: {}, _meta: { threadId: "thread-main" } } });
            await waitFor(() => hasId(mcp.lines, 2), "main-threaded reply");
            assert.equal(byId(mcp.lines, 2).result?.isError, false, `main thread routed: ${textOf(mcp.lines, 2)}`);
            assert.match(textOf(mcp.lines, 2), /CONTEXT BREAKDOWN/, "real acp_status came back through the shim");

            mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acp_status", arguments: {}, _meta: { threadId: "thread-child" } } });
            await waitFor(() => hasId(mcp.lines, 3), "child-threaded reply");
            assert.equal(byId(mcp.lines, 3).result?.isError, false, `child thread routed (same process, no clobber): ${textOf(mcp.lines, 3)}`);

            // Meta-less: falls back to the stale env binding, which is not a live
            // session — proving the per-call threadIds did not overwrite it.
            mcp.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "acp_status", arguments: {} } });
            await waitFor(() => hasId(mcp.lines, 4), "meta-less reply");
            assert.equal(byId(mcp.lines, 4).result?.isError, true, "meta-less call fails against the untouched stale env binding");
            assert.match(textOf(mcp.lines, 4), /unknown plugin conversation/, "the loud 404 surfaces through the shim");
        } finally {
            mcp.kill();
        }
    } finally {
        await h.stop();
    }
});
