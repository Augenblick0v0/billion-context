import test from "node:test";
import assert from "node:assert/strict";
import {
    DSH_COMPACTION_INSTRUCTION_FULL,
    DSH_COMPACTION_INSTRUCTION_PREFIX,
    DSH_COMPACTION_MAX_MESSAGES,
    dshCompactionRefusal,
    isDshCompactionCall,
} from "../src/server/dsh-compaction-guard.ts";

// #1729/#2223: the guard must recognize dsh-compaction-basic's summarize
// envelope (replayed prefix + COMPACTION_INSTRUCTION as the final user
// message) at ANY span length and refuse it, while a normal multi-message
// turn — even one quoting part of the template — must pass untouched.

/** First line of the real COMPACTION_INSTRUCTION, verbatim from
 * @deepseek-ai/dsh-compaction-basic (tracked per dsh release). */
const INSTRUCTION =
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.";

/** Full COMPACTION_INSTRUCTION verbatim from
 * @deepseek-ai/dsh-compaction-basic@0.2.0-rc.2 — mirror of the guard's
 * tracked constant; the drift test below fails loudly if either copy moves. */
const FULL_INSTRUCTION = "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.\n\nOutput EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.\n\n## Primary Request and Intent\n- [the user's original and evolving goals; quote verbatim where the exact wording matters]\n\n## Key Technical Concepts\n- [technologies, frameworks, patterns, and conventions in play]\n\n## Files and Code\n- [exact path: why it matters, key changes or snippets]\n\n## Errors and Fixes\n- [error: how it was resolved, plus any related user feedback]\n\n## Pending Jobs\n- [explicitly requested work not yet completed]\n\n## Current Work\n- [precisely what was in progress at this checkpoint]\n\n## Next Step\n- [the single next action, directly in line with the most recent request, or \"(none)\"]\n\n## Critical Context\n- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]\n\nRules:\n- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.\n- Capture user feedback and explicit instructions faithfully, especially corrections.\n- Do NOT mention this summarization request or that the context was compacted.\n- Output only the checkpoint text: do not call any tool or take any other action.\n- If the conversation already contains a \x3ccompacted-summary\x3e block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.";

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
    assert.equal(isDshCompactionCall("openai", body, 3), true);
});

test("identifies the collapsed shape: system + directive only", () => {
    const body = openaiBody([
        { role: "system", content: "you are dsh" },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 2), true);
});

test("directive as content-parts array still matches", () => {
    const body = openaiBody([
        { role: "user", content: giantPrefix },
        { role: "user", content: [{ type: "text", text: "  " + INSTRUCTION }] },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 2), true);
});

test("#2223: identifies the per-message-replay envelope: >4 messages, exact full-text directive", () => {
    // The shipped plugin replays the shadowed span PER MESSAGE (byte-for-byte,
    // for KV-cache reuse), so a realistic compaction call far exceeds
    // DSH_COMPACTION_MAX_MESSAGES. The full-text signal must catch it at any
    // span length; the plugin appends the directive as a single text part.
    const region = [
        { role: "user", content: "build the parser" },
        { role: "assistant", content: [{ type: "text", text: "on it" }] },
        { role: "user", content: [{ type: "text", text: "[tool result] done" }] },
        { role: "assistant", content: "ok, next step" },
        { role: "user", content: "now ship it" },
        { role: "assistant", content: "shipping" },
    ];
    const body = openaiBody([
        { role: "system", content: "you are dsh" },
        ...region,
        { role: "user", content: [{ type: "text", text: FULL_INSTRUCTION }] },
    ]);
    assert.ok(body.messages.length > DSH_COMPACTION_MAX_MESSAGES);
    assert.equal(isDshCompactionCall("openai", body, body.messages.length), true);
});

test("#2223: pasted partial instruction in a long conversation is NOT intercepted", () => {
    // A snippet of the template (starts with the marker sentence but is
    // truncated) cannot reproduce the full text; with >4 messages the legacy
    // shape bar does not apply either — neither signal fires.
    const partial = FULL_INSTRUCTION.slice(0, FULL_INSTRUCTION.indexOf("\n## Files and Code"));
    assert.ok(partial.startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX));
    assert.ok(partial.length < FULL_INSTRUCTION.length);
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` }));
    msgs.push({ role: "user", content: partial });
    const body = openaiBody(msgs);
    assert.equal(isDshCompactionCall("openai", body, msgs.length), false);
});

test("#2223: byte-exact full-instruction paste in a long conversation IS intercepted", () => {
    // Traffic-level indistinguishable from a real compaction call (same
    // session history + identical final message). The degenerate collision
    // loses on purpose: a clear, actionable 403 beats irreversible substrate
    // destruction from a landed checkpoint.
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` }));
    msgs.push({ role: "user", content: FULL_INSTRUCTION });
    const body = openaiBody(msgs);
    assert.equal(isDshCompactionCall("openai", body, msgs.length), true);
});

test("multi-message turn quoting the template mid-history is NOT intercepted", () => {
    const msgs = Array.from({ length: 107 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` }));
    msgs.push({ role: "user", content: INSTRUCTION });
    const body = openaiBody(msgs);
    assert.equal(isDshCompactionCall("openai", body, msgs.length), false);
});

test("message count above the shape bar is never intercepted", () => {
    const body = openaiBody([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 5), false);
    assert.ok(5 > DSH_COMPACTION_MAX_MESSAGES);
});

test("directive text NOT at the head of the final user message is not intercepted", () => {
    const body = openaiBody([
        { role: "user", content: giantPrefix },
        { role: "user", content: `What does this template mean?\n\n${INSTRUCTION}` },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 2), false);
});

test("anthropic messages shape is covered", () => {
    const body = { model: "m", system: "s", max_tokens: 8192, messages: [
        { role: "user", content: giantPrefix },
        { role: "user", content: [{ type: "text", text: INSTRUCTION }] },
    ] };
    assert.equal(isDshCompactionCall("anthropic", body, 2), true);
});

test("out-of-scope protocols and missing shapes never intercept", () => {
    const body = openaiBody([{ role: "user", content: INSTRUCTION }]);
    assert.equal(isDshCompactionCall("google", body, 1), false);
    assert.equal(isDshCompactionCall("responses", body, 1), false);
    assert.equal(isDshCompactionCall(null, body, 1), false);
    assert.equal(isDshCompactionCall("openai", { input: [{ type: "message", role: "user", content: INSTRUCTION }] }, null), false);
    assert.equal(isDshCompactionCall("openai", null, 1), false);
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

test("the tracked full-text constant matches its test mirror and subsumes the prefix", () => {
    // Drift guard (#2223, #970 discipline): when dsh ships a reworded
    // COMPACTION_INSTRUCTION, the constant in src/server/dsh-compaction-guard.ts
    // MUST be re-extracted from the published tarball — this fails loudly if
    // the two copies ever diverge.
    assert.equal(FULL_INSTRUCTION, DSH_COMPACTION_INSTRUCTION_FULL);
    assert.ok(FULL_INSTRUCTION.startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX));
    assert.ok(FULL_INSTRUCTION.includes("\x3ccompacted-summary\x3e"));
});
