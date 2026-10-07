// #2302: the one-call skeleton now lives in the kernel (nudge-text.ts) and
// rides every surface the model reads — renderNudgeText itself (all wire
// lanes inject its output), the post-compress receipt tail, and acp_status.
// These tests pin the kernel shape from the bili side, including a
// round-trip through the REAL compress parser: the refs we hand out must
// parse as a one-string batch once the model fills the bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneCallPayload, oneCallTail, type CompressibleRange } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";

function range(start: number, end: number): CompressibleRange {
    return { startRef: `m${String(start).padStart(5, "0")}`, endRef: `m${String(end).padStart(5, "0")}`, tokens: 1000 } as unknown as CompressibleRange;
}

test("#2302: skeleton is line form — one string, one block per range", () => {
    const payload = oneCallPayload([range(1, 42), range(50, 121)]);
    assert.ok(!payload.includes("{"), "no JSON shells");
    assert.ok(payload.includes("m00001–m00042 <topic>"), "refs header line");
    assert.ok(payload.includes("<write your summary of this range>"), "summary slot");
});

test("#2302: tail frames one call and deferral, skips <2 ranges", () => {
    assert.equal(oneCallTail([range(1, 2)]), "", "nothing to batch");
    const tail = oneCallTail([range(1, 42), range(50, 121)]);
    assert.ok(tail.includes("never split"), "delete-don't-split licensing");
    assert.ok(!tail.includes("If you compress"), "the tail carries no directive of its own — the nudge text around it does (#1198)");
});

test("#2302: skeleton headers round-trip through the real compress parser", () => {
    const payload = oneCallPayload([range(1, 42), range(50, 121)]);
    // the model replaces the placeholder bodies with real summaries —
    // keep the refs lines, swap in a long-enough summary
    const filled = payload.replace(/<topic>/g, "topic").replace(/<write your summary of this range>/g, "summary body long enough for the minimum length check");
    const parsed = parseCompressInput({ content: filled });
    assert.equal(parsed.ranges.length, 2, "one string → both ranges");
    assert.equal(parsed.ranges[0]?.startRef, "m00001");
    assert.equal(parsed.ranges[0]?.endRef, "m00042");
    assert.equal(parsed.ranges[1]?.startRef, "m00050");
    assert.equal(parsed.ranges[1]?.endRef, "m00121");
    assert.ok(parsed.ranges.every((r) => (r.summary ?? "").includes("summary body long enough")), "line-form bodies become summaries");
});

test("#2302: more than maxEntries ranges collapse into a same-string note", () => {
    const many = Array.from({ length: 18 }, (_, i) => range(i * 10 + 1, i * 10 + 9));
    const payload = oneCallPayload(many);
    assert.equal((payload.match(/<topic>/g) ?? []).length, 16, "16 headers shown as blocks");
    assert.ok(payload.includes("continue the SAME string"), "overflow note");
});
