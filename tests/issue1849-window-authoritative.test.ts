// #1849: window credibility as first-class state. When no authoritative
// context window reaches the proxy (plugin header / runtime-info / launcher /
// operator-configured / tier negotiation), sizing falls back to published
// guesses (registry-peek / built-in table / default) — and every percentage
// the proxy shows (acp panel, Web UI, stats) is estimate-grade without saying
// so. These tests pin the contract on every surface:
//   - session.metadata.lastWindowAuthoritative persists the verdict
//   - /__bili/plugin/status exposes windowSource + windowAuthoritative and the
//     panel carries an ESTIMATE banner exactly when non-authoritative
//   - /__bili/stats carries the same fields per session
//   - the log splits: plugin-present-but-silent escalates to warn; a plain
//     client stays info-grade with guess wording
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { sessionWindowAuthoritative } from "../src/server/context-window.ts";
import { setLogCapture } from "../src/logger.ts";

// ---- Unit: the classification helper ----

describe("sessionWindowAuthoritative (#1849)", () => {
    it("explicit flag wins over the source-derived fallback, both ways", () => {
        assert.equal(sessionWindowAuthoritative({ lastWindowAuthoritative: true, lastWindowSource: "registry-peek" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowAuthoritative: false, lastWindowSource: "plugin" }), false);
    });
    it("legacy sessions (no flag) are classified by their persisted source", () => {
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "plugin" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "runtime-info" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "launcher" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "configured" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "anthropic-beta" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "model-suffix" }), true);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "registry-peek" }), false);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "table-or-registry" }), false);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: "default" }), false);
    });
    it("sessions with no source at all read as non-authoritative", () => {
        assert.equal(sessionWindowAuthoritative({}), false);
        assert.equal(sessionWindowAuthoritative({ lastWindowSource: null }), false);
    });
});

// ---- E2E: the verdict on every visible surface ----

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    // isolate the state dir: prefix-affinity hydration reattaches anonymous
    // sessions from disk, which would defeat fresh-session preconditions
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1849-state-"));
    const prevStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: {} } },
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        // the log-split assertions need the request pipeline's log lines:
        // logMsg() early-returns when opts.log is false
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");

    return {
        proxyPort: proxy.address().port,
        upstreamPort,
        close: async () => {
            proxy.close();
            upstream.close();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
            if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevStateHome;
            fs.rmSync(stateHome, { recursive: true, force: true });
        },
    };
}

interface StatusJson {
    ok: boolean;
    conversationId: string;
    windowSource: string | null;
    windowAuthoritative: boolean;
    contextLimit: number | null;
    panel: string | null;
}

async function chat(h: Harness, model: string, conversationId: string, extraHeaders: Record<string, string> = {}): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin-conversation": conversationId, ...extraHeaders },
        body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(resp.status, 200);
}

async function status(h: Harness, conversationId: string, fallbackLatest = false): Promise<StatusJson> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conversationId}${fallbackLatest ? "&fallback=latest" : ""}`);
    assert.equal(resp.status, 200);
    return await resp.json() as StatusJson;
}

const GUESS_SOURCES = new Set(["registry-peek", "table-or-registry", "default"]);

describe("window-authoritative end to end (#1849)", () => {
    let h: Harness | undefined;
    let lines: string[] = [];
    beforeEach(async () => {
        h = await startHarness();
        lines = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
    });
    afterEach(async () => {
        setLogCapture(null);
        await h?.close();
        h = undefined;
    });

    it("a plain client sized by a published guess is marked estimate-grade on every surface", async () => {
        // distinct model per test: windowSourceLogged dedupes per model
        await chat(h!, "guess-model-1849-a", "conv-1849-a");

        // plain client (no x-bili-plugin marker): the conversation map only
        // binds plugin-marked requests, so resolve via the #404 latest-session
        // fallback — exactly how a status bar probes an anonymous session
        const st = await status(h!, "conv-1849-a", true);
        assert.ok(GUESS_SOURCES.has(st.windowSource ?? ""), `windowSource=${st.windowSource}`);
        assert.equal(st.windowAuthoritative, false);
        assert.ok((st.contextLimit ?? 0) > 0, "a guess window still sizes the session");
        assert.match(st.panel ?? "", /is an ESTIMATE/);
        assert.match(st.panel ?? "", /#1849/);

        const stats = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/stats`)).json() as { sessions: Array<{ windowSource?: string; windowAuthoritative?: boolean }> };
        const mine = stats.sessions.find((s) => s.windowSource !== undefined || s.windowAuthoritative !== undefined);
        assert.ok(mine, "stats carries window fields");
        assert.equal(mine!.windowAuthoritative, false);
        assert.ok(GUESS_SOURCES.has(mine!.windowSource ?? ""));

        // plain client, designed fallback: info-grade with guess wording
        const info = lines.find((l) => l.includes("guess-model-1849-a") && l.includes("no cooperative plugin"));
        assert.ok(info, "info line names the guess: " + lines.filter((l) => l.includes("guess-model-1849-a")).join(" | "));
        assert.match(info!, /published guess/);
        const warn = lines.find((l) => l.includes("guess-model-1849-a") && l.includes("sent no context window"));
        assert.equal(warn, undefined, "plain clients do not escalate to warn");
    });

    it("a plugin present but silent escalates to warn", async () => {
        await chat(h!, "silent-plugin-model-1849-b", "conv-1849-b", { "x-bili-plugin": "dsh" });

        const st = await status(h!, "conv-1849-b");
        assert.equal(st.windowAuthoritative, false);
        assert.match(st.panel ?? "", /is an ESTIMATE/);

        const warn = lines.find((l) => l.includes("silent-plugin-model-1849-b") && l.includes("sent no context window"));
        assert.ok(warn, "warn line fires for a present-but-silent plugin: " + lines.filter((l) => l.includes("silent-plugin-model-1849-b")).join(" | "));
        assert.match(warn!, /agent=dsh/);
        assert.match(warn!, /#1849/);
    });

    it("a plugin window header is authoritative: no banner, true verdict", async () => {
        await chat(h!, "plugin-window-model-1849-c", "conv-1849-c", { "x-bili-plugin": "dsh", "x-bili-plugin-context-window": "222222" });

        const st = await status(h!, "conv-1849-c");
        assert.equal(st.windowSource, "plugin");
        assert.equal(st.windowAuthoritative, true);
        assert.equal(st.contextLimit, 222222);
        assert.doesNotMatch(st.panel ?? "", /is an ESTIMATE/);
    });

    it("a runtime-info report sizes the window authoritatively", async () => {
        const report = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "runtime-model-1849-d", contextWindow: 262144, source: "client-config" }),
        });
        assert.equal(report.status, 200);
        await chat(h!, "runtime-model-1849-d", "conv-1849-d", { "x-bili-plugin": "dsh" });

        const st = await status(h!, "conv-1849-d");
        assert.equal(st.windowSource, "runtime-info");
        assert.equal(st.windowAuthoritative, true);
        assert.doesNotMatch(st.panel ?? "", /is an ESTIMATE/);
    });
});
