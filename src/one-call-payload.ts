// #2302 root-cause fix: the nudge hands the model a LIST of recommended
// ranges ("use these refs exactly as listed") and a hint to batch — and the
// model still digests the list in groups, one compress call per group. Each
// separate call resets the provider prefix cache from its fold point and
// re-bills the whole remaining history; one call carrying every range pays
// once (live incident: five single-range calls over 44s on a 555K-token
// session re-billed 1.38M tokens; one 9-range call on the same log paid
// once). Instructions have not worked — the recommendation itself now ships
// as a copy-fill-send payload: the exact single-call arguments with every
// recommended range pre-serialized, summary fields left to fill, entries
// deletable (never split the call). Applied at every surface the model reads:
// the injected nudge (all four wire lanes), the post-compress receipt tail,
// and acp_status.
import { viableRanges, type CompressibleRange, type Config, type NudgeDecision } from "acp-kernel";

/** Serialize ranges as ready-to-send compress arguments. Single line per
 *  entry; extra ranges beyond maxEntries collapse into a trailing note (the
 *  visible list above still shows them all). */
export function oneCallPayload(ranges: readonly CompressibleRange[], maxEntries = 16): string {
    const shown = ranges.slice(0, maxEntries);
    const entries = shown.map((r) => `  { "startId": "${r.startRef}", "endId": "${r.endRef}", "summary": "…" }`);
    const more = ranges.length - shown.length;
    return [
        `{ "content": [`,
        entries.join(",\n") + (more > 0 ? "," : ""),
        ...(more > 0 ? [`  // …plus ${more} more range(s) — add them as further entries in the SAME call`] : []),
        `] }`,
    ].join("\n");
}

/** Append the one-call payload to a rendered nudge / receipt text. No-op for
 *  tier-2/3 nudges (their calls are single-shot block rewrites), for ranges
 *  the submit gate would reject (#847 min chars), and when nothing viable
 *  remains. Keeps the #1198 licensing intact: the payload is framed as "if
 *  you compress" with explicit delete-don't-split semantics — a model that
 *  still needs a range drops the entry, it never folds the call in halves. */
export function withOneCallPayload(text: string, nudge: NudgeDecision, config: Config): string {
    if (!text) return text;
    if (nudge.tier !== null && nudge.tier >= 2) return text;
    const minChars = config.compress.minCompressRange ?? 0;
    const viable = viableRanges(nudge.compressibleRanges)
        .filter((r) => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars);
    if (viable.length < 2) return text;
    return `${text}\n\nONE-CALL PAYLOAD — if you compress, fold every range below in a SINGLE compress call: copy this, fill each "summary", DELETE any entry you still need (it reappears in later nudges) — never split it into several calls. Each separate call re-bills the whole remaining history; one call pays once.\n${oneCallPayload(viable)}`;
}
