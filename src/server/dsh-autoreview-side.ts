/**
 * #1309: dsh experimental auto-review side-request identification.
 *
 * `@deepseek-ai/dsh-experimental-auto-review` (the desktop host's Auto
 * permission preset) fires one LLM review request before EVERY tool call:
 * `classifyRisk()` sends a fixed system policy (REVIEW_POLICY) plus exactly
 * one user message (reviewUserText(snapshot): ENVIRONMENT / PROJECT_
 * INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION JSON sections), no tools,
 * no max_tokens, temperature 0 — reusing the main session id, so it rides
 * bili as a same-key request with a NORMAL budget. The #388 budget heuristic
 * (max_tokens <= 200) can never catch it, and #1307/#1308 proved the damage
 * of letting it run the full pipeline: it consumed refs, rewrote snapshots,
 * skewed the nudge baseline, and 3 consecutive review calls tripped the
 * silent orphan-GC (ORPHAN_THRESHOLD=3) that deactivated every compressed
 * block. #1309 left the routing open because every SHAPE-based disjunct
 * (message count / budget / overlap) breaks #1075's genuine-short-view
 * semantics.
 *
 * The stable signal #1309 asked for exists at the traffic level: the review
 * request carries a machine-authored, package-internal system prompt that no
 * human turn starts with. Two-signal AND (claudeSubagentSplit #970
 * discipline; failure direction = "stop side-routing", which degrades to
 * today's behavior):
 *   1. MARKER — messages[0] is a system message starting with the versioned
 *      REVIEW_POLICY opening (byte-identical across 0.1.7-rc.2 → 0.2.0-rc.2,
 *      tracked per dsh release like MAIN_SYSTEM_PREFIXES);
 *   2. SHAPE — <= 2 messages, no tools, and the single user message starts
 *      with the stable "ENVIRONMENT" header of reviewUserText().
 *
 * Requests matching BOTH are routed by server.ts into the #388
 * side-passthrough lane: forwarded (never refused — unlike the #1729
 * compaction guard, this traffic is legitimate and the host needs the
 * verdict), but with zero kernel contact — no ref consumption, no snapshot
 * refresh, no nudge baseline, no usage, no orphan-GC visibility. A generic
 * short main view can never match: no human-authored turn begins with the
 * reviewer policy, which is exactly why #1075 stays intact.
 *
 * v1 scope: the openai chat wire shape (the dsh desktop lane speaks
 * OpenAI-compatible chat; qwen and deepseek providers alike). The #1729
 * compaction guard is upstream of this check and provably never matches
 * this shape (its marker lives in the FINAL USER message; reviewUserText
 * starts with "ENVIRONMENT") — asserted by cross-module regression tests.
 */

/** Stable opening of dsh-experimental-auto-review's REVIEW_POLICY system
 * prompt (verbatim from @deepseek-ai/dsh-experimental-auto-review,
 * identical across 0.1.7-rc.2 → 0.2.0-rc.2; tracked per dsh release). */
export const DSH_AUTOREVIEW_POLICY_PREFIX =
    "You are the final authorization reviewer for exactly one pending tool call. Your decision replaces human approval for this call. If you allow it, the call executes immediately with full host access and no later confirmation.";

/** system + one user message; classifyRisk() sends nothing else. */
export const DSH_AUTOREVIEW_MAX_MESSAGES = 2;

/** Stable first header of reviewUserText() — the second signal. */
export const DSH_AUTOREVIEW_USER_PREFIX = "ENVIRONMENT";

type Rec = Record<string, unknown>;

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

/** Two-signal test: versioned reviewer policy as the system opener AND the
 * compact no-tools shape. `messageCount` is the wire messages-array length
 * the caller already computed (server.ts inboundMsgs). */
export function isDshAutoReviewSideCall(protocol: string | null, parsed: unknown, messageCount: number | null): boolean {
    if (protocol !== "openai") return false;
    if (messageCount === null || messageCount > DSH_AUTOREVIEW_MAX_MESSAGES) return false;
    if (parsed === null || typeof parsed !== "object") return false;
    const p = parsed as Rec;
    if (Array.isArray(p.tools) && p.tools.length > 0) return false; // a main turn, never side
    const messages = p.messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const first = messages[0];
    if (first === null || typeof first !== "object" || (first as Rec).role !== "system") return false;
    if (!textOfContent((first as Rec).content).trimStart().startsWith(DSH_AUTOREVIEW_POLICY_PREFIX)) return false;
    const user = messages[1];
    if (user === null || typeof user !== "object" || (user as Rec).role !== "user") return false;
    return textOfContent((user as Rec).content).startsWith(DSH_AUTOREVIEW_USER_PREFIX);
}
