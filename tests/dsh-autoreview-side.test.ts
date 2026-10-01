import test from "node:test";
import assert from "node:assert/strict";
import {
    DSH_AUTOREVIEW_MAX_MESSAGES,
    DSH_AUTOREVIEW_POLICY_PREFIX,
    DSH_AUTOREVIEW_USER_PREFIX,
    isDshAutoReviewSideCall,
} from "../src/server/dsh-autoreview-side.ts";
import { isDshCompactionCall } from "../src/server/dsh-compaction-guard.ts";

// #1309: dsh experimental auto-review review requests (REVIEW_POLICY system +
// one ENVIRONMENT user message, no tools, normal budget, same session id)
// must route to the #388 side-passthrough lane — never the full pipeline
// (ref/snapshot/nudge/orphan-GC pollution, #1307) and never the #1729
// compaction refusal (legitimate host traffic).

/** Opening of the real REVIEW_POLICY, verbatim from
 * @deepseek-ai/dsh-experimental-auto-review (identical 0.1.7-rc.2 →
 * 0.2.0-rc.2; tracked per dsh release). */
const POLICY =
    "You are the final authorization reviewer for exactly one pending tool call. Your decision replaces human approval for this call. If you allow it, the call executes immediately with full host access and no later confirmation.\n\nReturn exactly one JSON object and no other text.";

/** reviewUserText(snapshot) shape: five stable JSON sections. */
const REVIEW_USER = [
    "ENVIRONMENT",
    JSON.stringify({ cwd: "/repo" }),
    "PROJECT_INSTRUCTIONS",
    "null",
    "FILTERED_HISTORY",
    "[]",
    "PENDING_ACTION",
    JSON.stringify({ tool: "fs_write", args: { path: "/repo/a.ts" } }),
].join("\n\n");

function reviewBody(messages: unknown[], extra: Record<string, unknown> = {}) {
    return { model: "qwen-3.8-27b", temperature: 0, messages, ...extra };
}

const REAL_MESSAGES = [
    { role: "system", content: POLICY },
    { role: "user", content: [{ type: "text", text: REVIEW_USER }] },
];

test("identifies the real classifyRisk() wire shape", () => {
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(REAL_MESSAGES), 2), true);
});

test("accepts string system content and string user content", () => {
    const messages = [
        { role: "system", content: POLICY },
        { role: "user", content: REVIEW_USER },
    ];
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(messages), 2), true);
});

test("marker in a LATER system message or non-system opener never matches", () => {
    const swapped = [
        { role: "user", content: REVIEW_USER },
        { role: "system", content: POLICY },
    ];
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(swapped), 2), false);
    const led = [
        { role: "system", content: "you are dsh" },
        { role: "system", content: POLICY },
        { role: "user", content: REVIEW_USER },
    ];
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(led), 3), false);
});

test("policy quoted mid-system (not the head) never matches", () => {
    const messages = [
        { role: "system", content: `House rules follow.\n\n${POLICY}` },
        { role: "user", content: REVIEW_USER },
    ];
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(messages), 2), false);
});

test("a tools array marks a main turn — never side-routed", () => {
    assert.equal(
        isDshAutoReviewSideCall("openai", reviewBody(REAL_MESSAGES, { tools: [{ type: "function", function: { name: "fs_write" } }] }), 2),
        false,
    );
});

test("user message without the ENVIRONMENT header never matches", () => {
    const messages = [
        { role: "system", content: POLICY },
        { role: "user", content: "Summarize the diff below.\n\n+1 -1" },
    ];
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(messages), 2), false);
});

test("message count above the shape bar never matches", () => {
    const messages = [...REAL_MESSAGES, { role: "assistant", content: "x" }, { role: "user", content: REVIEW_USER }];
    assert.ok(messages.length > DSH_AUTOREVIEW_MAX_MESSAGES);
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(messages), messages.length), false);
    assert.equal(isDshAutoReviewSideCall("openai", reviewBody(REAL_MESSAGES), null), false);
});

test("out-of-scope protocols and malformed bodies never match", () => {
    assert.equal(isDshAutoReviewSideCall("anthropic", { system: POLICY, messages: [{ role: "user", content: REVIEW_USER }] }, 1), false);
    assert.equal(isDshAutoReviewSideCall(null, reviewBody(REAL_MESSAGES), 2), false);
    assert.equal(isDshAutoReviewSideCall("openai", null, 2), false);
    assert.equal(isDshAutoReviewSideCall("openai", { input: [] }, 2), false);
});

test("#1729 regression: the compaction guard never intercepts a review call", () => {
    // The compaction marker lives in the FINAL USER message; reviewUserText()
    // starts with "ENVIRONMENT" — the two lanes cannot collide.
    assert.equal(isDshCompactionCall("openai", reviewBody(REAL_MESSAGES), 2), false);
});

test("#1729 regression: the compaction call is never side-routed as a review", () => {
    const compaction = {
        model: "m",
        messages: [
            { role: "system", content: "you are dsh" },
            { role: "user", content: "You are now acting as a compaction engine for this AI coding assistant. Condense…" },
        ],
    };
    assert.equal(isDshAutoReviewSideCall("openai", compaction, 2), false);
});

test("the versioned markers match the live dsh package strings", () => {
    assert.ok(POLICY.startsWith(DSH_AUTOREVIEW_POLICY_PREFIX));
    assert.ok(REVIEW_USER.startsWith(DSH_AUTOREVIEW_USER_PREFIX));
});
