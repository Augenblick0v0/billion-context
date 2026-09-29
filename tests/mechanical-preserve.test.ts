// #1702 (subtask of #1563): mechanical identifier fidelity at fold commit.
// Regression pin for the invariant: subagent dispatch ids (ses_*) survive ANY
// fold VERBATIM inside the block summary, regardless of what the model's
// summary says — the model channel is probabilistic (#1563 A/B probe: 20% id
// loss for weak models; #475 prompt-naming still truncated commit hashes), so
// the assertions here are mechanical (includes full-string match), never
// "the model probably kept it".
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { MECHANICAL_PRESERVE_MARKER, MAX_IDS_PER_BLOCK, extractMechanicalIds, pinMechanicalIds, stripMechanicalPreserve } from "../src/mechanical-preserve.ts";

const FULL_ID = "ses_f195c333effeabcd1234567890";
const TRUNCATED_ID = "ses_f195c333effe";

// ---------- unit: extract / strip / pin ----------

test("#1702 unit: extract dedupes and preserves first-seen order across texts", () => {
    const ids = extractMechanicalIds([
        `dispatched subagent ${FULL_ID} and resumed ses_def456`,
        undefined,
        "",
        `{"sessionID":"${FULL_ID}"} again ses_zz9`,
    ]);
    assert.deepEqual(ids, [FULL_ID, "ses_def456", "ses_zz9"]);
});

test("#1702 unit: extract matches nothing on id-free text", () => {
    assert.deepEqual(extractMechanicalIds(["plain text", "a session mention without the prefix"]), []);
});

test("#1702 unit: strip is a same-reference no-op without a marker", () => {
    const s = "model prose only";
    assert.strictEqual(stripMechanicalPreserve(s), s);
});

test("#1702 unit: strip removes marker lines wherever they sit and normalizes blank runs", () => {
    const mid = `para one\n\n${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}\n\npara three`;
    assert.equal(stripMechanicalPreserve(mid), "para one\n\npara three");
    const trailing = `body text\n\n${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`;
    assert.equal(stripMechanicalPreserve(trailing), "body text");
    const once = stripMechanicalPreserve(trailing);
    assert.strictEqual(stripMechanicalPreserve(once), once, "idempotent");
});

test("#1702 unit: pin appends one canonical line, model bytes untouched as prefix", () => {
    const p = pinMechanicalIds("model summary body", [`args {"sessionID":"${FULL_ID}"}`, `result mentions ${FULL_ID} twice`]);
    assert.equal(p.changed, true);
    assert.deepEqual(p.ids, [FULL_ID]);
    assert.equal(p.truncated, 0);
    assert.ok(p.summary.startsWith("model summary body\n\n"), p.summary);
    assert.ok(p.summary.endsWith(`${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`), p.summary);
});

test("#1702 unit: pin normalizes a model-copied stale line and re-pins from originals", () => {
    const s = `summary copied the id short: ${TRUNCATED_ID}\n\n${MECHANICAL_PRESERVE_MARKER} ${TRUNCATED_ID}`;
    const p = pinMechanicalIds(s, [`original carries ${FULL_ID}`]);
    assert.equal(p.changed, true);
    const lines = p.summary.split("\n").filter((l) => l.includes(MECHANICAL_PRESERVE_MARKER));
    assert.equal(lines.length, 1, "exactly one appendix line");
    assert.equal(lines[0], `${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`, "stale truncated line replaced by the full-id line");
});

test("#1702 unit: pin keeps the input unchanged (same reference) when no ids are covered", () => {
    const s = "no identifiers anywhere";
    const p = pinMechanicalIds(s, ["id-free original text"]);
    assert.strictEqual(p.summary, s);
    assert.equal(p.changed, false);
});

test("#1702 unit: pin caps at MAX_IDS_PER_BLOCK and reports truncation", () => {
    const many = Array.from({ length: MAX_IDS_PER_BLOCK + 5 }, (_, i) => `ses_pad${String(i).padStart(4, "0")}`);
    const p = pinMechanicalIds("s", [many.join(",")]);
    assert.equal(p.ids.length, MAX_IDS_PER_BLOCK);
    assert.equal(p.truncated, 5);
});

test("#1702 unit: pin on an empty summary degenerates to the bare appendix line", () => {
    const p = pinMechanicalIds("", [`x ${FULL_ID} y`]);
    assert.equal(p.summary, `${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`);
});

// ---------- integration: applyRanges fold commit ----------

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: `mp-${Math.random().toString(36).slice(2)}`,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

/** Realistic opencode subagent dispatch pair plus surrounding turns. Returns
 *  the head message count (refs m00001..m{head} address the dispatch pair). */
function seedDispatch(ctx: Ctx, extraHead: Array<[string, string]> = []): number {
    const head: Array<[string, string, Partial<CoreMessage>?]> = [
        ["user", "Continue the refactor using your subagent session."],
        ["assistant", JSON.stringify({ description: "refactor", prompt: "resume the pending work", sessionId: FULL_ID }), { contentType: "tool-call", toolName: "task" }],
        ["tool", `Subagent finished. Session ${FULL_ID} saved 12k tokens.`, { contentType: "tool-result", toolName: "task" }],
        ["assistant", "Continuing mainline work based on the subagent result."],
        ...extraHead.map(([role, text]): [string, string, Partial<CoreMessage>?] => [role, text]),
    ];
    const tail = Array.from({ length: 5 }, (_, i): [string, string, Partial<CoreMessage>?] => [i % 2 === 0 ? "user" : "assistant", `recent ${i}`]);
    const msgs: CoreMessage[] = [...head, ...tail].map(([role, text, extra], i) => ({
        id: `raw${i}`,
        role: role as CoreMessage["role"],
        contentType: "text",
        text,
        ...extra,
    }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
    return head.length;
}

function storedSummary(state: CompressionState, blockId: string): string {
    const block = state.blocks.find((b) => b.blockId === blockId);
    assert.ok(block, `block ${blockId} exists in state`);
    return block.summary;
}

test("#1702 acceptance: dispatch id survives verbatim even when the model summary drops it entirely", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedDispatch(ctx);
    const modelSummary = "The user asked to continue a refactor; a subagent was dispatched and returned results; mainline work continued.";
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: modelSummary }] }), ctx);
    assert.ok(out.startsWith("[Compressed m00001–m00004"), out.split("\n")[0]);
    const s = storedSummary(ctx.session.state, "b1");
    assert.ok(s.includes(FULL_ID), `full id present verbatim in: ${s}`);
    assert.ok(s.startsWith(modelSummary + "\n\n"), "model bytes untouched as prefix");
    assert.ok(s.endsWith(`${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`), `machine appendix line last: ${s}`);
    // observability: the fingerprint tail excerpt now shows the pinned line
    assert.ok(out.includes(`${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}\"`), `receipt fingerprint shows the pinned line: ${out}`);
});

test("#1702 acceptance: a model-truncated id (#1563 failure mode) is corrected by the machine line", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedDispatch(ctx);
    const modelSummary = `Subagent session ${TRUNCATED_ID} handled the work.`;
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: modelSummary }] }), ctx);
    assert.ok(out.startsWith("[Compressed m00001–m00004"), out.split("\n")[0]);
    const s = storedSummary(ctx.session.state, "b1");
    assert.ok(s.includes(FULL_ID), "full id present verbatim");
    const lines = s.split("\n").filter((l) => l.includes(MECHANICAL_PRESERVE_MARKER));
    assert.equal(lines.length, 1, "exactly one appendix line");
    assert.equal(lines[0], `${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`, "appendix carries the full id only");
});

test("#1702 T2: distilling a child block re-pins its ids into the parent summary", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedDispatch(ctx, [["user", "Next: wire up the cache layer."], ["assistant", "Cache layer wired; verified against the fixture."]]);
    const first = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "Early dispatch round folded away." }] }), ctx);
    assert.ok(first.startsWith("[Compressed m00001–m00004"), first.split("\n")[0]);
    const second = applyRanges(parseCompressInput({ content: [{ startId: "b1", endId: "m00006", summary: "Tier-two overview of the early history." }] }), ctx);
    assert.ok(second.startsWith("[Compressed"), second.split("\n")[0]);
    const parent = ctx.session.state.blocks.filter((b) => b.active).at(-1)!;
    assert.notEqual(parent.blockId, "b1");
    assert.ok(parent.summary.includes(FULL_ID), `parent summary carries the id verbatim: ${parent.summary}`);
});

test("#1702 refold: an in-place re-fold normalizes a model-echoed stale appendix line", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedDispatch(ctx);
    const first = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "First pass summary." }] }), ctx);
    assert.ok(first.startsWith("[Compressed m00001–m00004"), first.split("\n")[0]);
    const restored = resolveDecompress({ blockId: "b1" }, ctx);
    assert.match(restored, /^\[Block b1 content/, restored.slice(0, 60));
    // The model re-summarizes the restored span and echoes a TRUNCATED copy of
    // the old appendix line — worst case for the normalization path.
    const echoed = `Second pass summary.\n\n${MECHANICAL_PRESERVE_MARKER} ${TRUNCATED_ID}`;
    const again = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: echoed }] }), ctx);
    assert.ok(!again.startsWith("[Compression FAILED"), again.split("\n")[0]);
    const blocks = ctx.session.state.blocks.filter((b) => b.active);
    assert.equal(blocks.length, 1, "same block updated in place");
    assert.equal(blocks[0].blockId, "b1");
    const s = blocks[0].summary;
    assert.ok(s.includes(FULL_ID), "full id present verbatim after refold");
    const lines = s.split("\n").filter((l) => l.includes(MECHANICAL_PRESERVE_MARKER));
    assert.equal(lines.length, 1, "exactly one appendix line");
    assert.equal(lines[0], `${MECHANICAL_PRESERVE_MARKER} ${FULL_ID}`);
});

test("#1702 zero cost: a fold covering no ids leaves the model summary byte-identical", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    const msgs: CoreMessage[] = [
        { id: "raw0", role: "user", contentType: "text", text: "early question" },
        { id: "raw1", role: "assistant", contentType: "text", text: "x".repeat(800) },
        { id: "raw2", role: "user", contentType: "text", text: "follow up" },
        { id: "raw3", role: "assistant", contentType: "text", text: "y".repeat(800) },
        ...Array.from({ length: 5 }, (_, i): CoreMessage => ({ id: `raw${i + 4}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `recent ${i}` })),
    ];
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
    const modelSummary = "Early exchange covered setup steps and their follow-up.";
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: modelSummary }] }), ctx);
    assert.ok(out.startsWith("[Compressed m00001–m00004"), out.split("\n")[0]);
    assert.equal(storedSummary(ctx.session.state, "b1"), modelSummary, "byte-identical, no appendix line");
});
