import test from "node:test";
import assert from "node:assert/strict";
import {
    DSH_COMPACTION_INSTRUCTION_PREFIX,
    DSH_COMPACTION_SHAPE_MSGS,
    dshCompactionRefusal,
    isDshCompactionCall,
} from "../src/server/dsh-compaction-guard.ts";

// #1729/#2193: the guard must recognize dsh-compaction-basic's summarize
// envelope (replayed prefix + COMPACTION_INSTRUCTION as the FINAL user
// message) and refuse it — MARKER-DECISIVE since #2193, message count plays
// no part (rc.2 replays the full shadowed region, ~1100+ msgs). A turn whose
// final user message merely QUOTES the template elsewhere in history must
// pass untouched.

/** First line of the real COMPACTION_INSTRUCTION, verbatim from
 * @deepseek-ai/dsh-compaction-basic (tracked per dsh release). */
const INSTRUCTION =
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.";

function openaiBody(messages: unknown[]) {
    return { model: "qwen-3.8-27b", messages, stream: true };
}

const giantPrefix = "x".repeat(600_000); // ~150K tokens of replayed prefix

test("identifies the observed production shape: 2-msg openai replay + directive", () => {
    const body = openaiBody([
        { role: "system", content: "you are dsh" },
        { role: "user", content: giantPrefix },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body), true);
});

test("identifies the collapsed shape: system + directive only", () => {
    const body = openaiBody([
        { role: "system", content: "you are dsh" },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body), true);
});

test("directive as content-parts array still matches", () => {
    const body = openaiBody([
        { role: "user", content: giantPrefix },
        { role: "user", content: [{ type: "text", text: "  " + INSTRUCTION }] },
    ]);
    assert.equal(isDshCompactionCall("openai", body), true);
});

test("#2193 regression: rc.2 full-shadowed-region replay (~1100+ msgs) IS intercepted", () => {
    // dsh-compaction-basic 0.2.0-rc.2: system + entire shadowed region as
    // individual messages + the directive as the final user message. The old
    // ≤4-msg SHAPE bar made this envelope pass silently (#2193 incident:
    // 1121 msgs / 2.8MiB). Marker alone must decide.
    const historyLen = 1118;
    const msgs = [
        { role: "system", content: "you are dsh" },
        ...Array.from({ length: historyLen }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `history ${i}` })),
        { role: "user", content: INSTRUCTION },
    ];
    const body = openaiBody(msgs);
    assert.ok(msgs.length > DSH_COMPACTION_SHAPE_MSGS);
    assert.equal(isDshCompactionCall("openai", body), true);
});

test("multi-message turn quoting the template MID-HISTORY is NOT intercepted", () => {
    const msgs = Array.from({ length: 107 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` }));
    msgs[50] = { role: "user", content: INSTRUCTION };
    msgs.push({ role: "user", content: "what did we just discuss?" });
    const body = openaiBody(msgs);
    assert.equal(isDshCompactionCall("openai", body), false);
});

test("normal long turn without the marker is never intercepted, whatever its size", () => {
    const msgs = Array.from({ length: 1326 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
    msgs.push({ role: "user", content: "please continue the refactor" });
    const body = openaiBody(msgs);
    assert.equal(isDshCompactionCall("openai", body), false);
});

test("directive text NOT at the head of the final user message is not intercepted", () => {
    const body = openaiBody([
        { role: "user", content: giantPrefix },
        { role: "user", content: `What does this template mean?\n\n${INSTRUCTION}` },
    ]);
    assert.equal(isDshCompactionCall("openai", body), false);
});

test("anthropic messages shape is covered", () => {
    const body = { model: "m", system: "s", max_tokens: 8192, messages: [
        { role: "user", content: giantPrefix },
        { role: "user", content: [{ type: "text", text: INSTRUCTION }] },
    ] };
    assert.equal(isDshCompactionCall("anthropic", body), true);
});

test("out-of-scope protocols and missing shapes never intercept", () => {
    const body = openaiBody([{ role: "user", content: INSTRUCTION }]);
    assert.equal(isDshCompactionCall("google", body), false);
    assert.equal(isDshCompactionCall("responses", body), false);
    assert.equal(isDshCompactionCall(null, body), false);
    assert.equal(isDshCompactionCall("openai", { input: [{ type: "message", role: "user", content: INSTRUCTION }] }), false);
    assert.equal(isDshCompactionCall("openai", null), false);
});

test("refusal bodies carry the marker reason and are non-retryable", () => {
    const openai = dshCompactionRefusal("openai") as { status: number; body: { error: { retryable: boolean; message: string } } };
    assert.equal(openai.status, 403);
    assert.equal(openai.body.error.retryable, false);
    assert.match(openai.body.error.message, /#1729/);
    const anthropic = dshCompactionRefusal("anthropic") as { status: number; body: { error: { message: string } } };
    assert.equal(anthropic.status, 403);
    assert.match(anthropic.body.error.message, /durably/);
});

test("the versioned marker prefix matches the live dsh template", () => {
    assert.ok(INSTRUCTION.startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX));
});
