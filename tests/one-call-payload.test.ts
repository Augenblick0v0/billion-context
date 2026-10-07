// #2302 root-cause fix: the recommendation itself must make batching the
// path of least resistance. The nudge used to hand the model a LIST of
// recommended ranges plus a batch hint — and the model digested the list in
// groups, one compress call per group (live: 10 recommended ranges → 3 calls;
// 5 calls over 44s re-billed 1.38M tokens). The compress tool's preferred
// line form already supports one-string-one-batch, so the recommendation now
// ships as a line-form skeleton: refs headers authoritative, summaries the
// model's own to write. Packaging style beyond "one call, one string" is NOT
// prescribed (no JSON object shells — that was the wrong shape, corrected per
// owner review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneCallPayload, withOneCallPayload } from "../src/one-call-payload.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { defaultConfig, type CompressibleRange, type NudgeDecision } from "acp-kernel";

function range(start: number, end: number, tokens: number, chars?: number): CompressibleRange {
    return {
        startRef: `m${String(start).padStart(5, "0")}`,
        endRef: `m${String(end).padStart(5, "0")}`,
        tokens,
        chars,
        summaryTokens: 64,
    } as unknown as CompressibleRange;
}

function nudge(ranges: CompressibleRange[], tier: number | null = null): NudgeDecision {
    return {
        shouldInject: true,
        reason: "test",
        contextUsage: 0.5,
        tier,
        compressibleRanges: ranges,
    } as unknown as NudgeDecision;
}

const CFG = defaultConfig(200_000);

test("#2302: oneCallPayload emits the line-form skeleton (one string, all ranges)", () => {
    const out = oneCallPayload([range(1, 42, 8000), range(50, 121, 12000), range(130, 200, 9000)]);
    assert.ok(out.includes("m00001–m00042 <topic>"), "refs header line form (en dash, topic slot)");
    assert.ok(out.includes("m00050–m00121 <topic>"), "second range header");
    assert.ok(out.includes("m00130–m00200 <topic>"), "third range header");
    assert.ok(out.includes("<write your summary of this range>"), "summary body left to the model");
    assert.ok(!out.includes('"startId"') && !out.includes("{") && !out.includes("}"), "no JSON shells — packaging is the model's call");
});

test("#2302: the skeleton headers round-trip through the real compress parser", () => {
    // The refs we recommend must parse exactly — the model copies the headers
    // verbatim, fills the bodies, and sends ONE string.
    const ranges = [range(1, 42, 8000), range(50, 121, 12000)];
    const payload = oneCallPayload(ranges)
        .replace(/<write your summary of this range>/g, "summary body long enough for the kernel minimum length check, written by the model");
    const parsed = parseCompressInput({ content: payload });
    assert.equal(parsed.ranges.length, 2, "one string → both ranges");
    assert.equal(parsed.ranges[0]?.startRef, "m00001");
    assert.equal(parsed.ranges[0]?.endRef, "m00042");
    assert.equal(parsed.ranges[1]?.startRef, "m00050");
    assert.equal(parsed.ranges[1]?.endRef, "m00121");
    assert.ok(parsed.ranges.every((r) => (r.summary ?? "").includes("summary body long enough")), "line-form bodies become summaries");
});

test("#2302: more than maxEntries ranges collapse into a same-string note", () => {
    const ranges = Array.from({ length: 18 }, (_, i) => range(i * 10 + 1, i * 10 + 9, 1000));
    const out = oneCallPayload(ranges);
    assert.equal((out.match(/<topic>/g) ?? []).length, 16, "16 headers shown as blocks");
    assert.ok(out.includes("+2 more range(s)"), "overflow folded into a note");
    assert.ok(out.includes("SAME string"), "note keeps them inside the one call");
});

test("#2302: withOneCallPayload appends the skeleton with #1198-safe framing", () => {
    const out = withOneCallPayload("NUDGE BODY", nudge([range(1, 10, 5000), range(11, 20, 5000)]), CFG);
    assert.ok(out.startsWith("NUDGE BODY"), "original text preserved");
    assert.ok(out.includes("ONE CALL CARRIES THE WHOLE BATCH"), "one-call framing present");
    assert.ok(out.includes("If you compress"), "conditional framing kept (#1198)");
    assert.ok(out.includes("DELETE the blocks you still need"), "delete-don't-split licensing kept");
    assert.ok(out.includes("never split"), "never split directive present");
    assert.ok(out.includes("m00001–m00010 <topic>"), "refs headers pre-serialized");
});

test("#2302: skip conditions — tier>=2, single range, empty text, sub-floor chars", () => {
    assert.equal(withOneCallPayload("", nudge([range(1, 10, 5000), range(11, 20, 5000)]), CFG), "", "empty text stays empty");
    // Tier-2/3 nudges drive single-shot block-ref calls — no payload.
    assert.equal(withOneCallPayload("T2 BODY", nudge([range(1, 10, 5000), range(11, 20, 5000)], 2), CFG), "T2 BODY");
    // A single remaining range cannot be split — no payload.
    assert.equal(withOneCallPayload("ONE BODY", nudge([range(1, 10, 5000)]), CFG), "ONE BODY");
    // Ranges below the submit gate's char floor (#847) must not be advertised.
    assert.equal(withOneCallPayload("FLOOR BODY", nudge([range(1, 10, 100, 40), range(11, 20, 100, 40)]), CFG), "FLOOR BODY");
});
