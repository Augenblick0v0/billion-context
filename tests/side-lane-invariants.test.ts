import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest, SPLIT_CANARY_FRESH_MS, splitSessionWarnings, type Session } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

// #2170 measure 2: behavioral invariants of the #388 side lane, on the dsh
// plugin wire (the host whose regression started this — #2156/#2157/#2164).
//   (A) transparency: side requests are OBSERVATION-transparent — upstream hit,
//       kernel state (requests / parentRevision / usage baseline / snapshot
//       contents) bit-for-bit unchanged.
//   (B) ordering-independence: interleavings of main and side traffic converge
//       to the same kernel state as the main-only baseline (#2164 class: the
//       bug only manifested when a side request arrived AFTER a fork anchor).
//   (C) split-session canary unit: the #2165 detection helper fires only on a
//       genuinely live split.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-side-inv-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                    ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                    : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const request = async (path: string, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    };
    // dsh-shaped request sender (anthropic wire: system TOP-LEVEL, messages replay raw)
    const dshSend = async (conversationId: string, msgs: unknown[], agent: string | undefined, system: string, maxTokens = 1024) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, stream: false, system, messages: msgs }) });
        assert.equal(response.status, 200, await response.text());
    };
    return { request, forwarded, dshSend, origin, upstreamUrl: upstream.url, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

const mainMsg = (n: number) => ({ role: "user", content: `main turn ${n} `.repeat(120) });

test("(A) side requests are observation-transparent: kernel state and upstream traffic", async () => {
    const h = await harness();
    try {
        const conv = "plain";
        await h.dshSend(conv, [mainMsg(0)], "main", "MAIN OPERATING SYSTEM", 256);
        const session = resolveConversation(conv).session!;
        const requests0 = session.stats.requests;
        const rev0 = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
        const status0 = (await h.request("/__bili/plugin/status?conversationId=" + conv)).body as { contextTokens: number | null; inputTokens: number };

        // side shape 1: declared side agent, full-history replay (dsh title-gen)
        const hits0 = h.forwarded.length;
        await h.dshSend(conv, [mainMsg(0), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024);
        assert.equal(h.forwarded.length, hits0 + 1, "title request reaches the upstream");
        // side shape 2: budget heuristic, NO agent header (max_tokens <= 200)
        await h.dshSend(conv, [mainMsg(0), { role: "user", content: "summarize" }], undefined, "MAIN OPERATING SYSTEM", 64);
        assert.equal(h.forwarded.length, hits0 + 2, "tiny-budget side request reaches the upstream");
        // side shape 3: title again after the second main turn (post-anchor ordering)
        await h.dshSend(conv, [mainMsg(0), { role: "assistant", content: "a" }, mainMsg(1), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024);
        assert.equal(h.forwarded.length, hits0 + 3, "second title request reaches the upstream");

        const requests1 = session.stats.requests;
        const rev1 = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
        const status1 = (await h.request("/__bili/plugin/status?conversationId=" + conv)).body as { contextTokens: number | null; inputTokens: number };
        assert.equal(requests1, requests0, `side requests must not count as main requests (${requests0} -> ${requests1})`);
        assert.equal(rev1, rev0, `side requests must not grow the snapshot (${rev0} -> ${rev1})`);
        assert.equal(status1.inputTokens, status0.inputTokens, "side requests must not touch the usage baseline");
        assert.equal(status1.contextTokens, status0.contextTokens, "side requests must not touch the context estimate");
        assert.ok(!JSON.stringify(session.pluginSnapshot).includes("Generate a title."), "title instruction never lands in the kernel session");
        const titleForward = h.forwarded.at(-1)! as { messages?: { content: unknown }[] };
        assert.ok(titleForward.messages?.some((m) => JSON.stringify(m.content).includes("Generate a title.")), "the forwarded title request carries the title instruction");
        // the side-effect canary (#2170 measure 4) stays silent: no leak counted
        assert.equal(session.metadata.sideEffectLeaks, undefined, "no side-effect leak may be counted on a healthy lane");
    } finally {
        await h.close();
    }
});

test("(B) main/side interleavings converge to the main-only baseline (ordering independence)", async () => {
    // deterministic LCG so a failure is reproducible from the seed in the log
    const runScenario = async (seed: number, includeSide: boolean) => {
        const h = await harness();
        try {
            let s = seed;
            const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
            const conv = "fuzz";
            // main turn stream = fixed; side pool = 3 requests; rnd only picks
            // WHEN each side request fires (between main turns), not its shape.
            const sidePool = [
                () => h.dshSend(conv, [mainMsg(0), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024),
                () => h.dshSend(conv, [mainMsg(0), { role: "user", content: "summarize" }], undefined, "MAIN OPERATING SYSTEM", 64),
                () => h.dshSend(conv, [mainMsg(0), mainMsg(1), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024),
            ];
            let sideCursor = 0;
            const mainTurn = async (n: number) => {
                await h.dshSend(conv, [mainMsg(n)], "main", "MAIN OPERATING SYSTEM", 256);
                if (includeSide && sideCursor < sidePool.length && rnd() < 0.45) {
                    await sidePool[sideCursor++]();
                }
            };
            await mainTurn(0);
            await mainTurn(1);
            // drain any remaining side requests so every scenario forwards 4 main + 3 side
            if (includeSide) while (sideCursor < sidePool.length) await sidePool[sideCursor++]();
            await mainTurn(2);
            await mainTurn(3);
            const session = resolveConversation(conv).session!;
            const rev = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
            const status = (await h.request("/__bili/plugin/status?conversationId=" + conv)).body as { contextTokens: number | null; inputTokens: number };
            return { requests: session.stats.requests, rev, inputTokens: status.inputTokens, contextTokens: status.contextTokens, forwards: h.forwarded.length, expectedForwards: includeSide ? 7 : 4 };
        } finally {
            await h.close();
        }
    };
    const baseline = await runScenario(1, false);
    assert.deepEqual({ requests: baseline.requests, forwards: baseline.forwards, expectedForwards: baseline.expectedForwards }, { requests: 4, forwards: 4, expectedForwards: 4 }, "baseline sanity: 4 main turns, 4 forwards");
    for (const seed of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
        const r = await runScenario(seed, true);
        assert.equal(r.forwards, 7, `seed ${seed}: every side request still reaches the upstream`);
        assert.equal(r.requests, baseline.requests, `seed ${seed}: side traffic must not change the request count (${baseline.requests} != ${r.requests})`);
        assert.equal(r.rev, baseline.rev, `seed ${seed}: side traffic must not change the snapshot revision`);
        assert.equal(r.inputTokens, baseline.inputTokens, `seed ${seed}: side traffic must not change the usage baseline`);
        assert.equal(r.contextTokens, baseline.contextTokens, `seed ${seed}: side traffic must not change the context estimate`);
    }
});

test("(C) splitSessionWarnings fires only on a live same-base split (#2165 shape)", () => {
    const now = 1_000_000;
    const mk = (id: string, requests: number, ageMs: number): Session => ({ id, lastSeen: now - ageMs, createdAt: now - ageMs - 1000, stats: { requests }, metadata: {} } as unknown as Session);
    const mkSub = (base: string, sub: string, requests: number, ageMs: number) => mk(`${base}|sub:${sub}`, requests, ageMs);
    // live split: raw id + fork, both carried traffic, both fresh
    const warnings = splitSessionWarnings([mk("A", 3, 60_000), mkSub("A", "fp1", 5, 60_000)], now);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].base, "A");
    assert.equal(warnings[0].sessions.length, 2);
    // single session: never warns
    assert.equal(splitSessionWarnings([mk("B", 3, 60_000)], now).length, 0);
    // split but the raw twin never carried traffic (#2165's A had requests=0 counts... A had old traffic; the empty twin must NOT warn)
    assert.equal(splitSessionWarnings([mk("C", 0, 60_000), mkSub("C", "fp1", 5, 60_000)], now).length, 0, "a traffic-less twin is an idle leftover, not a live split");
    // split but stale (older than the freshness window)
    assert.equal(splitSessionWarnings([mk("D", 3, SPLIT_CANARY_FRESH_MS + 1), mkSub("D", "fp1", 5, 60_000)], now).length, 0, "stale twins are history, not a live split");
    // unrelated sessions never group together
    assert.equal(splitSessionWarnings([mk("E", 3, 1_000), mkSub("F", "x", 3, 1_000)], now).length, 0);
});
