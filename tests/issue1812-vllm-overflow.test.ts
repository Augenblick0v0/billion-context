import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1812: a vLLM server behind a relay rejects oversized requests with
// "prompt (N tokens) + max tokens (M) exceeds the context (W); requests are
// never truncated" — a phrasing the pre-#1812 detector did not recognize (no
// word "window"), so the 400 passed through verbatim and the client retried
// into a hard loop even though the payload was rescuable. Two defects had to
// be fixed together for the rescue to actually land:
//   1. recognition — inspectContextOverflow must parse this dialect, including
//      the stated window W and the stated prompt size N;
//   2. the refold rebuild's output clamp — it ran against the DECLARED window
//      while lastInputTokens was armed to the STATED window, which either left
//      the client's max_tokens untouched (input alone fit) or zeroed the cap.
// This e2e pins the full chain on the OpenAI wire: reject → arm → refold
// clamps max_tokens to the stated window using a fresh input estimate floored
// by the upstream's own prompt count → re-send ONCE in the same request → 200.
const REAL_WINDOW = 131_072;
const DECLARED_WINDOW = 200_000;

function vllmOverflowBody(promptTokens: number, maxTokens: number): string {
    return JSON.stringify({
        error: {
            type: "invalid_request_error",
            message: `prompt (${promptTokens} tokens) + max tokens (${maxTokens}) exceeds the context (${REAL_WINDOW}); requests are never truncated`,
        },
    });
}

interface RecordedUpstream {
    server: http.Server;
    port: number;
    bodies: string[];
}

async function recordedUpstream(): Promise<RecordedUpstream> {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const parsed = JSON.parse(raw) as { max_tokens?: number; max_completion_tokens?: number };
            const requested = typeof parsed.max_tokens === "number" ? parsed.max_tokens : typeof parsed.max_completion_tokens === "number" ? parsed.max_completion_tokens : 0;
            const promptTokens = defaultCountTokens(raw);
            if (promptTokens + requested > REAL_WINDOW) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(vllmOverflowBody(promptTokens, requested));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const chunk = (choices: unknown): void =>
                res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "local-model", choices })}\n\n`);
            chunk([{ index: 0, delta: { role: "assistant", content: "" } }]);
            chunk([{ index: 0, delta: { content: "ok" } }]);
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as { port: number }).port, bodies };
}

function proxyBaseOptions(upstreamPort: number): ProxyOptions {
    // The operator declared 200k (table-or-registry fallback); the upstream's
    // real window is 131072 — exactly the #1812 mis-sizing.
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "local-model": { context: DECLARED_WINDOW } } } },
        modelContextLimit: DECLARED_WINDOW,
        kernelConfig: defaultConfig(DECLARED_WINDOW),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

test("e2e #1812: vLLM-stated-window overflow is rescued in-request — refold clamps max_tokens to the REAL window, client sees 200", async (t) => {
    const upstream = await recordedUpstream();

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstream.port));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        await once(proxy, "close");
        upstream.server.close();
        await once(upstream.server, "close");
    });

    // Three ~100k-char messages ≈ 75k tokens: the INPUT alone fits under the
    // real 131072 window, but input + the client's 65536 max_tokens does not.
    // Nothing is foldable (all three sit inside preserveRecentMessages), so the
    // ONLY possible rescue is the output-clamp path fixed by #1812.
    const messages = [0, 1, 2].map((i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `MARKER_${i}_content_`.repeat(5882) }));
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
    const body = JSON.stringify({ model: "local-model", max_tokens: 65_536, stream: true, messages });
    const headers = { "content-type": "application/json", "x-acp-session": "issue1812-a" };

    const r = await fetch(url, { method: "POST", headers, body });
    assert.equal(r.status, 200, "the client never sees the 400 — the turn is rescued in-request");
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await r.text();
    assert.ok(text.includes('"ok"'), "the retry's SSE stream is delivered");
    assert.ok(text.includes("[DONE]"), "the stream terminates cleanly");

    assert.equal(upstream.bodies.length, 2, `one rejected forward + one clamped retry, no summary side-call: ${upstream.bodies.length}`);
    const first = JSON.parse(upstream.bodies[0]) as { max_tokens?: number };
    const second = JSON.parse(upstream.bodies[1]) as { max_tokens?: number };
    assert.equal(first.max_tokens, 65_536, "the first forward carried the client's requested output budget");
    assert.ok(typeof second.max_tokens === "number" && second.max_tokens < 65_536, `the retry's max_tokens was clamped down: ${second.max_tokens}`);
    assert.ok(
        defaultCountTokens(upstream.bodies[1]) + (second.max_tokens ?? 0) <= REAL_WINDOW,
        `the retried body provably fits the real window (${defaultCountTokens(upstream.bodies[1])} + ${second.max_tokens})`,
    );

    const s = listSessions().find((x) => x.id === "issue1812-a");
    assert.ok(s, "session exists");
    assert.equal(s!.stats.lastInputTokens, REAL_WINDOW, "armed at the stated window");
    assert.equal(s!.stats.lastInputTokensSource, "usage");
    assert.equal(s!.stats.overflowArmTokens, REAL_WINDOW, "#1110 arm record at the stated window");
    assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned — the declared window keeps governing");
});
