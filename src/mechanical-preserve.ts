// #1702 (subtask of #1563): mechanical identifier fidelity at fold commit.
//
// Root-cause chain (#1563): the kernel's fold protection is keyed by tool name
// (ALWAYS_PROTECTED_TOOLS = ["compress","acp_rule"]; soft zone = last-5 msgs /
// 5K tokens) and is content-blind. An opencode subagent dispatch pair — the
// tool-call args carrying the ses_ session id plus its result — is an ordinary
// exchange to the kernel: five messages later it slides out of the fresh zone
// and folds, leaving the id's only survival channel as the model's free-text
// summary. That channel is probabilistic: the A/B probe behind #1563 measured
// a 20% loss rate for weak models, and even prompt-naming schemes (#475) left
// truncated ids behind.
//
// The fix is mechanical: at fold commit — after the model output exists, before
// the adopted block state is used anywhere else — the identifiers are extracted
// from the covered ORIGINALS (a machine read, not a model transcription) and
// pinned as a machine appendix line on the block summary. Fidelity no longer
// depends on the model. One line per block, tens of bytes per fold.
//
// Scope per the issue: subagent dispatch ids (ses_*) only. Commit hashes and
// PR/issue numbers can extend ID_PATTERNS later — deliberately not now.

/** Stable machine-marker prefix; one appendix line per block, owned by code. */
export const MECHANICAL_PRESERVE_MARKER = "[acp-mechanical-preserve]";

/** Identifier shapes preserved verbatim (#1702: start with ses_). */
const ID_PATTERNS: RegExp[] = [
    /ses_[A-Za-z0-9]+/g,
];

/** Pathological ceiling per block (one fold covering >100 distinct sessions). */
export const MAX_IDS_PER_BLOCK = 100;

/** Deduped, order-preserving identifier extraction across covered texts. */
export function extractMechanicalIds(texts: Iterable<string | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const text of texts) {
        if (!text) continue;
        for (const re of ID_PATTERNS) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                if (!seen.has(m[0])) {
                    seen.add(m[0]);
                    out.push(m[0]);
                }
            }
        }
    }
    return out;
}

/** Remove any prior appendix lines (normalizes lines a model may have copied
 *  into its own summary). No-op (same reference) when no marker is present. */
export function stripMechanicalPreserve(summary: string): string {
    if (!summary.includes(MECHANICAL_PRESERVE_MARKER)) return summary;
    const kept = summary.split("\n").filter((l) => !l.trimStart().startsWith(MECHANICAL_PRESERVE_MARKER));
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export interface PinnedSummary {
    summary: string;
    changed: boolean;
    ids: string[];
    /** Count dropped by MAX_IDS_PER_BLOCK (logged by the caller). */
    truncated: number;
}

/** Strip stale appendix lines, then pin the ids present in the covered texts.
 *  Returns the input unchanged (same reference) when nothing to do. */
export function pinMechanicalIds(summary: string, coveredTexts: Iterable<string | undefined>): PinnedSummary {
    const base = stripMechanicalPreserve(summary);
    const extracted = extractMechanicalIds(coveredTexts);
    const ids = extracted.slice(0, MAX_IDS_PER_BLOCK);
    if (ids.length === 0) {
        return { summary: base, changed: base !== summary, ids: [], truncated: 0 };
    }
    const body = base.replace(/\s+$/, "");
    const next = body === "" ? `${MECHANICAL_PRESERVE_MARKER} ${ids.join(", ")}` : `${body}\n\n${MECHANICAL_PRESERVE_MARKER} ${ids.join(", ")}`;
    return { summary: next, changed: true, ids, truncated: extracted.length - ids.length };
}
