/**
 * #1729: dsh native compaction-call guard.
 *
 * dsh's `dsh-compaction-basic` answers context pressure by replaying the whole
 * conversation prefix and appending a fixed summarization directive
 * (COMPACTION_INSTRUCTION, dsh-compaction-basic/lib/index.js) as the FINAL
 * user message, reusing the same session id so the provider's KV prefix cache
 * stays warm. In the desktop lane those calls ride bili under the main
 * conversation id — the second producer of #1729's deadlock — and when one
 * LANDS, dsh durably shadows the replayed surface range: the original
 * messages never ride a future request again, which destroys the proxy's
 * compression substrate (irreversible, unlike every cost of refusing).
 *
 * This guard identifies the call at the traffic level and refuses it locally:
 * never forwarded, kernel state untouched. Detection is a two-signal OR —
 * each signal stands alone, and the failure direction of BOTH is "stop
 * intercepting" (a reworded template degrades toward today's behavior):
 *   1. FULLTEXT (#2223) — the final user message EQUALS the versioned
 *      COMPACTION_INSTRUCTION byte-for-byte (whitespace-trimmed). The shipped
 *      plugin replays the shadowed span PER MESSAGE (byte-for-byte, for
 *      KV-cache reuse), so a realistic call carries far more than
 *      DSH_COMPACTION_MAX_MESSAGES wire messages — signal 2 was calibrated
 *      against the OLD collapsed-blob envelope (observed 2 msgs / ~152K
 *      tokens in the #1727/#1729 logs) and silently misses every
 *      per-message-replay envelope of any real length. A pasted snippet
 *      cannot reproduce the full multi-hundred-word instruction; the one
 *      degenerate collision (a byte-exact full paste as the final message of
 *      a normal turn) is traffic-level indistinguishable from a real call
 *      and loses on purpose — a clear, actionable 403 beats irreversible
 *      substrate destruction.
 *   2. MARKER+SHAPE (legacy, #1729) — the final user message STARTS with the
 *      instruction prefix AND the whole request is ≤ DSH_COMPACTION_MAX_
 *      MESSAGES messages (replayed prefix collapsed + directive). Kept as a
 *      fallback so a future template reword that breaks the full-text match
 *      degrades to today's behavior instead of going blind.
 *
 * Deliberately unconditional (auto pressure, context-overflow recovery, and
 * manual /compact all send the same envelope — the traffic layer cannot tell
 * which trigger fired, and a landed checkpoint is equally destructive from
 * any of them). Not gated on the dsh plugin marker: a dsh host routed through
 * a global bili proxy without the plugin bundle must be covered too. Refusal
 * message text intentionally rides into dsh's own warn line
 * (\x22step compaction failed: <message>; continuing the turn\x22).
 */

/** Stable opening sentence of dsh's COMPACTION_INSTRUCTION template
 * (verbatim from @deepseek-ai/dsh-compaction-basic, tracked per dsh release
 * like MAIN_SYSTEM_PREFIXES tracks Claude Code's system prompts, #970). */
export const DSH_COMPACTION_INSTRUCTION_PREFIX =
    "You are now acting as a compaction engine for this AI coding assistant";

/** Exact full text of dsh's COMPACTION_INSTRUCTION, verbatim from
 * @deepseek-ai/dsh-compaction-basic@0.2.0-rc.2 lib/index.js:243-278 (the
 * string-array `.join("\n")`; the only interpolation is the constant
 * \x3ccompacted-summary\x3e tag). Tracked per dsh release like
 * DSH_COMPACTION_INSTRUCTION_PREFIX (#970 discipline): re-extract from the
 * published tarball when dsh ships a new template — the drift test in
 * tests/dsh-compaction-guard.test.ts pins the two copies together and fails
 * loudly on divergence. Bundle is byte-identical across 0.1.7-rc.2 →
 * 0.2.0-rc.2 (diff = 0 lines). #2223: this is what the per-message-replay
 * envelope's final user message equals, at ANY span length. */
export const DSH_COMPACTION_INSTRUCTION_FULL =
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.\n\nOutput EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.\n\n## Primary Request and Intent\n- [the user's original and evolving goals; quote verbatim where the exact wording matters]\n\n## Key Technical Concepts\n- [technologies, frameworks, patterns, and conventions in play]\n\n## Files and Code\n- [exact path: why it matters, key changes or snippets]\n\n## Errors and Fixes\n- [error: how it was resolved, plus any related user feedback]\n\n## Pending Jobs\n- [explicitly requested work not yet completed]\n\n## Current Work\n- [precisely what was in progress at this checkpoint]\n\n## Next Step\n- [the single next action, directly in line with the most recent request, or \"(none)\"]\n\n## Critical Context\n- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]\n\nRules:\n- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.\n- Capture user feedback and explicit instructions faithfully, especially corrections.\n- Do NOT mention this summarization request or that the context was compacted.\n- Output only the checkpoint text: do not call any tool or take any other action.\n- If the conversation already contains a \x3ccompacted-summary\x3e block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.";

/** Legacy marker+shape bar, calibrated against the OLD collapsed-blob
 * envelope: observed as 2 messages (~152K tokens) in the #1727 production
 * logs. A normal turn — including a user pasting the template into an
 * existing conversation — carries the full multi-message history and cannot
 * fit under this bar. Since #2223 the full-text signal no longer needs the
 * bar; it survives only to keep the legacy detection alive if the template
 * ever rewords. */
export const DSH_COMPACTION_MAX_MESSAGES = 4;

type Rec = Record<string, unknown>;

/** Concatenate a wire content field (string | parts array) into plain text. */
function textOfContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let out = "";
    for (const part of content) {
        if (typeof part === "string") out += part;
        else if (part !== null && typeof part === "object" && typeof (part as Rec).text === "string") {
            out += (part as Rec).text;
        }
    }
    return out;
}

/** Text of the LAST role=user message for the messages-shaped protocols
 * (openai chat/completions, anthropic messages). Google's contents/parts
 * shape and the Responses input items are out of scope for v1 — dsh's
 * desktop lane speaks OpenAI-compatible chat. */
function lastUserMessageText(protocol: string, parsed: unknown): string | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const messages = (parsed as Rec).messages;
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m === null || typeof m !== "object") continue;
        if ((m as Rec).role !== "user") continue;
        return textOfContent((m as Rec).content);
    }
    return undefined;
}

/** Two-signal OR: the final user message either EQUALS the tracked
 * COMPACTION_INSTRUCTION exactly (per-message-replay envelope, any span
 * length, #2223) or starts with its prefix while the whole request stays
 * under the legacy shape bar (collapsed-blob envelope, #1729).
 * `messageCount` is the wire messages-array length the caller already
 * computed (server.ts inboundMsgs). */
export function isDshCompactionCall(protocol: string | null, parsed: unknown, messageCount: number | null): boolean {
    if (protocol !== "openai" && protocol !== "anthropic") return false;
    const finalUser = lastUserMessageText(protocol, parsed);
    if (finalUser === undefined) return false;
    const t = finalUser.trim();
    if (t === DSH_COMPACTION_INSTRUCTION_FULL) return true;
    return messageCount !== null && messageCount <= DSH_COMPACTION_MAX_MESSAGES && t.startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX);
}

export type Refusal = { status: number; body: unknown };

const REFUSAL_MESSAGE =
    `dsh native compaction call refused by billion-context: bili owns compression on this lane (#1729, cf. #1772/#1206). ` +
    `A landed dsh compaction checkpoint durably shadows the raw conversation history, which destroys the proxy's compression substrate. ` +
    `To run dsh native compaction on this lane anyway, opt in explicitly: "allowDshCompaction": true in the bili config (web UI) or env BILI_ALLOW_DSH_COMPACTION=1 (#2028).`;

/** Protocol-shaped refusal body (mirrors the #554 side-request guard shape so
 * clients render it natively). 403: a policy refusal, not a malformed
 * request — the caller's own retry logic must not treat it as transient. */
export function dshCompactionRefusal(protocol: string): Refusal {
    if (protocol === "anthropic") {
        return {
            status: 403,
            body: { type: "error", error: { type: "invalid_request_error", message: REFUSAL_MESSAGE } },
        };
    }
    return {
        status: 403,
        body: {
            error: {
                type: "server_error",
                code: "dsh_compaction_refused",
                message: REFUSAL_MESSAGE,
                retryable: false,
            },
        },
    };
}
