// #2302 root-cause fix: the recommendation itself must ship as a copy-fill-send
// payload. The nudge used to hand the model a LIST of recommended ranges plus a
// batch hint — and the model digested the list in groups, one compress call per
// group (live: 10 recommended ranges → 3 calls; 5 calls over 44s re-billed
// 1.38M tokens). oneCallPayload pre-serializes every recommended range into the
// exact single-call arguments; withOneCallPayload appends it to every surface
// the model reads (nudge injection ×4 lanes, post-compress tail, acp_status)
// while keeping the #1198 conditional framing (delete entries you still need —
// never split the call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneCallPayload, withOneCallPayload } from "../src/one-call-payload.ts";
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

test("#2302: oneCallPayload serializes ranges as ready-to-send compress args", () => {
    const out = oneCallPayload([range(1, 42, 8000), range(50, 121, 12000), range(130, 200, 9000)]);
    assert.ok(out.startsWith(`{ "content": [`), "opens a single-call content array");
    assert.ok(out.includes(`{ "startId": "m00001", "endId": "m00042", "summary": "…" }`), "entry 1 pre-serialized");
    assert.ok(out.includes(`{ "startId": "m00050", "endId": "m00121", "summary": "…" }`), "entry 2 pre-serialized");
    assert.ok(out.includes(`{ "startId": "m00130", "endRef"`.replace("m00130", `"m00130`).slice(0, 0) + `{ "startId": "m00130", "endId": "m00200", "summary": "…" }`), "entry 3 pre-serialized");
    assert.ok(out.trimEnd().endsWith(`] }`), "closes the call");
});

test("#2302: more than maxEntries ranges collapse into a same-call note", () => {
    const ranges = Array.from({ length: 18 }, (_, i) => range(i * 10 + 1, i * 10 + 9, 1000));
    const out = oneCallPayload(ranges);
    assert.equal((out.match(/"startId"/g) ?? []).length, 16, "16 entries shown");
    assert.ok(out.includes("plus 2 more range(s)"), "overflow folded into a note");
    assert.ok(out.includes("SAME call"), "note keeps them inside the same call");
});

test("#2302: withOneCallPayload appends the payload with #1198-safe framing", () => {
    const out = withOneCallPayload("NUDGE BODY", nudge([range(1, 10, 5000), range(11, 20, 5000)]), CFG);
    assert.ok(out.startsWith("NUDGE BODY"), "original text preserved");
    assert.ok(out.includes("ONE-CALL PAYLOAD"), "payload section present");
    assert.ok(out.includes("if you compress"), "conditional framing kept (#1198)");
    assert.ok(out.includes("DELETE any entry you still need"), "delete-don't-split licensing kept");
    assert.ok(out.includes("never split"), "never split directive present");
    assert.ok(out.includes(`{ "startId": "m00001", "endId": "m00010", "summary": "…" }`), "ranges pre-serialized");
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
