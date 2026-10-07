import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, MAX_SUMMARY_CALLS_PER_PREFLIGHT } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";

process.env.NODE_ENV = "test";

// #2313: the preflight entry meter (the "[preflight] payload ~N tok" reading
// and the #1933 depth-budget scaling) was measured on the RAW inbound message
// list plus an UNPROVENANCED floor on stats.lastInputTokens. Two defects made
// it lie about the work actually left:
//
//   1. Prior server-side folds hide content behind blocks, but the raw list
//      still carries it — so the entry reading stayed pinned at full-history
//      scale forever while the folded view the gate judges drains underneath
//      (incident #2313: trigger stuck ~10.3M for 12 h against a real payload
//      near the window; the raised budgets rode along at the cap the whole
//      time).
//   2. An estimate-sourced lastInputTokens (a one-way ratchet written by
//      failed turns / post-rebuild anchors, NOT upstream evidence) floored
//      the entry meter while the per-round baselineFloor already refused it
//      (#1492 provenance discipline) — internal inconsistency inside one
//      function.
//
// The fix measures the entry overshoot on the FOLDED view after the first
// pipeline pass and gates the baseline floor on source
// ("usage"/"overflow-arm"), mirroring the per-round floor. These tests pin:
//   - an estimate-grade phantom must not cap the budgets (folded scale wins);
//   - a usage-grade baseline still floors the entry meter (legacy ceiling);
//   - a converged payload (folded view under the window) pays nothing.

const WINDOW = 100_000;
const PHANTOM = 50_000_000;
const SUMMARY =
    "PREFLIGHT ENTRY METER SUMMARY: the segment covered earlier implementation work. " +
    "Key decisions and remaining tasks are preserved for the next turn.";

interface Fixture {
    core: ReturnType<typeof createCore>;
    messages: CoreMessage[];
    state: ReturnType<typeof createInitialState>;
}

// A tiny opening user message (the first-user pin — prune keeps it even when
// covered), one huge early assistant message pre-folded behind a block (so
// the RAW list stays at full-history scale while the rendered view carries
// only its summary), ten foldable middle messages sized by midRepeats, and a
// protected recent tail.
function buildFixture(midRepeats: number): Fixture {
    const core = createCore();
    const config = defaultConfig(WINDOW);
    config.preserveRecentMessages = 5;
    config.preserveRecentTokens = 5000;
    config.compress.minCompressRange = 5000;
    const messages: CoreMessage[] = [
        { id: "start", role: "user", contentType: "text", text: "Start of session." },
        { id: "hidden", role: "assistant", contentType: "text", text: "HIDDEN_RAW ".repeat(400_000) },
        ...Array.from({ length: 10 }, (_, i): CoreMessage => ({ id: `mid-${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `MID_${i} `.repeat(midRepeats) })),
        { id: "recent-a", role: "user", contentType: "text", text: "RECENT_A ".repeat(1_000) },
        { id: "recent-b", role: "assistant", contentType: "text", text: "RECENT_B ".repeat(1_000) },
    ];
    const turn = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: WINDOW * 100 }, tokenCount: WINDOW, renderTags: "text-only" });
    const hiddenRef = turn.state.messageRefs.byRaw.hidden;
    const folded = core.applyCompression({ messages, state: turn.state, config: { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 }, ranges: [{ startRef: hiddenRef, endRef: hiddenRef, summary: SUMMARY }] });
    assert.equal(folded.result.blocksCreated, 1, "fixture must carry one active block hiding the raw history");
    return { core, messages, state: folded.state };
}

async function runPreflight(fixture: Fixture, source: "usage" | "estimate"): Promise<{ result: Awaited<ReturnType<typeof preflightCompress>>; logs: string[]; summaryCalls: number }> {
    const session: Session = {
        id: "entry-meter", meta: {}, metadata: {}, state: fixture.state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: PHANTOM, lastInputTokensSource: source, compressCreditTokens: 0, contextTokens: PHANTOM, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
    };
    const config = defaultConfig(WINDOW);
    config.preserveRecentMessages = 5;
    config.preserveRecentTokens = 5000;
    config.compress.minCompressRange = 5000;
    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            summaryCalls += 1;
            void Buffer.concat(chunks);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ output_text: SUMMARY }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const logs: string[] = [];
    try {
        const result = await preflightCompress({
            core: fixture.core, session, config, prompts: defaultPrompts, protocol: "responses",
            url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, headers: {}, model: "test",
            log: (_level, message) => logs.push(message),
        }, fixture.messages);
        return { result, logs, summaryCalls };
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeAllConnections();
        await closed;
    }
}

test("#2313: an estimate-grade phantom baseline must not cap the preflight depth budgets — the folded view decides", async () => {
    // Folded view ~117k vs a 100k window (~1.2x): a modest overshoot whose
    // honest budget is well below the 2x cap. The raw list is ~1.2M tokens —
    // the old meter read THAT (plus the 50M phantom floor) and capped at 32.
    const { result, logs, summaryCalls } = await runPreflight(buildFixture(7_500), "estimate");
    const raises = logs.filter((m) => m.includes("raising summarization budget"));
    assert.ok(raises.length === 1, `exactly one budget-decision log expected, got: ${JSON.stringify(logs)}`);
    assert.ok(!logs.some((m) => m.includes(`-> ${MAX_SUMMARY_CALLS_PER_PREFLIGHT * 2}`)), `the phantom must not cap the budgets at 2x base:\n${logs.join("\n")}`);
    assert.match(raises[0], /~1\.\d+x/, `the reading must sit on the folded scale (~1.2x), got: ${raises[0]}`);
    assert.equal(result.fitsWindow, true, JSON.stringify(result));
    assert.ok(result.compressedRanges >= 1, "the middle range must fold under the honest budget");
    assert.ok(summaryCalls >= 1 && summaryCalls <= MAX_SUMMARY_CALLS_PER_PREFLIGHT, `base budget suffices (got ${summaryCalls} calls)`);
});

test("#2313: a usage-grade baseline still floors the entry meter (legacy conservative ceiling)", async () => {
    const { result, logs } = await runPreflight(buildFixture(7_500), "usage");
    const raises = logs.filter((m) => m.includes("raising summarization budget"));
    assert.ok(raises.length === 1, `exactly one budget-decision log expected, got: ${JSON.stringify(logs)}`);
    assert.match(raises[0], new RegExp(`-> ${MAX_SUMMARY_CALLS_PER_PREFLIGHT * 2}\\b`), `a trusted 50M baseline caps the budgets at 2x base, got: ${raises[0]}`);
    // The trusted floor keeps driving the walk past the fit point until the
    // ranges run out — the conservative direction is preserved.
    assert.equal(result.fitsWindow, true, JSON.stringify(result));
    assert.equal(result.failure?.kind, "exhausted", `floor-pinned walk ends in an honest exhaustion receipt, got: ${JSON.stringify(result.failure)}`);
});

test("#2313: a converged payload (folded view under the window) pays nothing despite a phantom baseline", async () => {
    const { result, logs, summaryCalls } = await runPreflight(buildFixture(200), "estimate");
    assert.ok(!logs.some((m) => m.includes("raising summarization budget")), `no budget raise for a fitting payload:\n${logs.join("\n")}`);
    assert.equal(summaryCalls, 0, "no summarization calls");
    assert.equal(result.compressedRanges, 0, "no folds");
    assert.equal(result.fitsWindow, true, JSON.stringify(result));
});
