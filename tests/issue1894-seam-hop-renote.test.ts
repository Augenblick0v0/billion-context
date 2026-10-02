// #1894: proxy-initiated re-send hops replace upstreamResult with MODIFIED
// bytes without re-noting the outbound body, so when the turn settles the
// seam-forensic pair compared the FIRST-ATTEMPT bytes against the previous
// baseline. Fix: forward() tracks the effective outbound bytes — each hop
// (compat-role ladder, overflow refold, fake-completion retry, JSON-loop
// re-fetch) re-notes its own bytes on success, and the non-streaming settle
// site no longer re-pins first-attempt bytes after the hops.
//
// This fixture drives the compat-role ladder end-to-end on the Responses
// lane (where client-sent "developer" items reach the wire, hoisted at
// input[0]): the upstream accepts turn 1, then starts rejecting role
// "developer" mid-session (learned-compat-roles kicking in). Turn 2's
// attempt 1 is 400'd, the ladder rewrites developer→system, attempt 2 lands
// with the cache collapsed — and the settled pair must carry the POST-HOP
// bytes, not the rejected first attempt.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { getCacheLedger } from "../src/cache-ledger.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function lcpLen(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

const msg = (role: string, text: string): Record<string, unknown> => ({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });

test("#1894: compat-ladder hop pairs the settled sample with the post-hop bytes", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const received: string[] = [];
    let reqNo = 0;
    let okResponses = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            reqNo += 1;
            received.push(text);
            // Mid-session policy flip: after the baseline turn, role
            // "developer" is rejected — the #552 learn-on-failure shape.
            if (reqNo > 1 && text.includes('"role":"developer"')) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Invalid role: developer" } }));
                return;
            }
            okResponses += 1;
            // Baseline turn: healthy cache. Post-hop turn: cache collapse
            // large enough to trip detectSeam's residual gates (same shape
            // as the #1891 fixture, scaled up).
            const cached = okResponses === 1 ? 199_000 : 20_000;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: `resp_${reqNo}`,
                object: "response",
                status: "completed",
                output: [{ type: "message", id: `msg_${reqNo}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `ok ${reqNo}` }] }],
                usage: { input_tokens: 200_000, output_tokens: 5, input_tokens_details: { cached_tokens: cached } },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        // Tool injection ON: the non-streaming settle branch is only reached
        // through the rewriter path (compressInjected), same as the #1891
        // fixture. Messages stay far below any nudge threshold, so the
        // injected surface is byte-stable across turns.
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const sessionId = "issue-1894-hop-renote";
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
    const post = (input: Array<Record<string, unknown>>): Promise<Response> =>
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model: "gpt-test", input }),
        });

    try {
        // Turn 1: clean baseline — the "developer" item rides at input[0].
        const resp1 = await post([
            msg("user", "u1"),
            { role: "developer", content: "s1" },
        ]);
        assert.equal(resp1.status, 200);
        await resp1.text();

        // Turn 2: same head plus a new tail; the upstream now rejects the
        // "developer" role. Attempt 1 is 400'd, the learn-on-failure ladder
        // rewrites developer→system, attempt 2 lands with the cache collapsed.
        const resp2 = await post([
            msg("user", "u1"),
            { role: "developer", content: "s1" },
            msg("assistant", "a1"),
            msg("user", "u2"),
        ]);
        assert.equal(resp2.status, 200);
        await resp2.text();

        assert.equal(received.length, 3, "baseline send + rejected attempt + accepted hop");
        const [base, preHop, postHop] = received as [string, string, string];
        assert.ok(preHop.includes('"role":"developer"'), "fixture: attempt 1 carries the rejected role");
        assert.ok(!postHop.includes('"role":"developer"'), "fixture: the hop rewrote the role");
        const expectedLcp = lcpLen(base, postHop);
        const buggyLcp = lcpLen(base, preHop);
        assert.notEqual(expectedLcp, buggyLcp, "fixture: the two variants diverge from the baseline at different positions");

        const s = getSession(sessionId);
        const led = getCacheLedger(s);
        const line = led.lines[led.lines.length - 1]!;
        assert.equal(line.seam, 1, "cache collapse after the hop still flags a seam");
        const ev = led.seamEvents?.[led.seamEvents.length - 1];
        assert.ok(ev, "forensic event recorded");
        // Pre-fix the pair carried preHop (lcpBytes == buggyLcp); the settled
        // sample must pair with the bytes the accepted hop actually sent.
        assert.equal(ev!.lcpBytes, expectedLcp, "settled pair carries the POST-HOP bytes, not the rejected first attempt");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
