// #2302 root-cause fix: the nudge hands the model a LIST of recommended
// ranges ("use these refs exactly as listed") and a hint to batch — and the
// model digests the list in groups, one compress call per group. Each
// separate call resets the provider prefix cache from its fold point and
// re-bills the whole remaining history; one call carrying every range pays
// once (live incident: five single-range calls over 44s on a 555K-token
// session re-billed 1.38M tokens; one 9-range call on the same log paid
// once). The tool's preferred line form already makes batching natural —
// content is ONE string that may hold every range — so the recommendation
// itself now ships as a ready-to-fill line-form skeleton: refs headers
// authoritative (ours), summary bodies entirely the model's to write (its
// decision, its wording). How to package is NOT prescribed beyond "one
// call, one string": no JSON shells, no escaped strings. Applied at every
// surface the model reads: the injected nudge (all four wire lanes), the
// post-compress receipt tail, and acp_status.
import { viableRanges, type CompressibleRange, type Config, type NudgeDecision } from "acp-kernel";

/** Serialize ranges as a line-form skeleton: one block per range, first line
 *  the refs (en dash, optional topic slot), remaining lines the model's
 *  summary. Matches the compress tool's preferred content shape — one string
 *  carries the whole batch, no JSON structure, no escaping. Extra ranges
 *  beyond maxEntries collapse into a trailing same-string note. */
export function oneCallPayload(ranges: readonly CompressibleRange[], maxEntries = 16): string {
    const shown = ranges.slice(0, maxEntries);
    const blocks = shown.map((r) => `${r.startRef}–${r.endRef} <topic>\n<write your summary of this range>`);
    const more = ranges.length - shown.length;
    const tailMore = more > 0
        ? `\n\n(+${more} more range(s) — continue the SAME string with further blocks, one per range: ${ranges.slice(maxEntries).map((r) => `${r.startRef}–${r.endRef}`).join(", ")})`
        : "";
    return blocks.join("\n\n") + tailMore;
}

/** Append the one-call skeleton to a rendered nudge / receipt text. No-op for
 *  tier-2/3 nudges (their calls are single-shot block rewrites), for ranges
 *  the submit gate would reject (#847 min chars), and when fewer than two
 *  viable ranges remain. Keeps the #1198 licensing intact: conditional "if
 *  you compress" framing and delete-don't-split semantics — a model that
 *  still needs a range drops the block, it never folds the call in halves. */
export function withOneCallPayload(text: string, nudge: NudgeDecision, config: Config): string {
    if (!text) return text;
    if (nudge.tier !== null && nudge.tier >= 2) return text;
    const minChars = config.compress.minCompressRange ?? 0;
    const viable = viableRanges(nudge.compressibleRanges)
        .filter((r) => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars);
    if (viable.length < 2) return text;
    return `${text}\n\nONE CALL CARRIES THE WHOLE BATCH — compress accepts ONE string holding every range: one block per range, first line the refs (as shown below, optional topic after them), remaining lines your summary. If you compress, send every block below in a single call; DELETE the blocks you still need (they reappear in later nudges) — never split them into several calls. Each separate call re-bills the whole remaining history; one call pays once.\n${oneCallPayload(viable)}`;
}
