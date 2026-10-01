// #1729: per-session request-shape observer. The nudge gate is correctly
// per-request/per-payload, so a session id shared by two producers with
// structurally exclusive shapes deadlocks silently: the multi-turn agent loop
// (~100 msgs, low usage) fails the growth gate while carrying the READY
// compressible mass, and the giant single-message replay (~1-2 msgs, near-
// ceiling usage, no compressible content in its own payload) passes growth
// but has nothing to compress there. No single request satisfies both gates,
// usage pins at the window ceiling, and the per-request logs never aggregate
// the pattern. Session-level observation is the missing layer: warn ONCE when
// two mutually exclusive shapes alternate — the traffic signature of a second
// producer on one conversation (#1206/#394). Identified dsh compaction calls
// are refused upstream of the pipeline (#1835); a pattern reaching this
// watcher is an UNCLASSIFIED variant, hence the triage pointer. Purely
// diagnostic: no wire or nudge-gate changes; O(1) state in session.metadata
// (round-trips wholesale; older versions ignore the unknown key).

import { markDirty, type Session } from "./session.js";
import { recordConflict } from "./conflict-watch.js";

// Class B "monolith": ≤ this many messages AND ≥ MONOLITH_MIN_USAGE_FRAC of
// the resolved window. Observed live: 1-2 msgs at 91-99% of window
// (#1727/#1729 logs); relative to the window so it scales 100K→1M with no knob.
export const MONOLITH_MAX_MSGS = 2;
export const MONOLITH_MIN_USAGE_FRAC = 0.5;
// Class A "multi-turn": a normal agent-loop conversation.
export const MULTITURN_MIN_MSGS = 3;
// Each class must be seen this many times before warning — periodic
// alternation, not a one-off side call.
export const EACH_CLASS_MIN_SEEN = 2;

const REASON_MAX = 120;

export type StreamClass = "monolith" | "multi-turn";

export interface StreamSighting {
    at: number;
    msgs: number;
    tokens: number;
    usagePct: number;
    reason?: string;
}

interface StreamWatchState {
    monolith: number;
    multiTurn: number;
    lastMonolith?: StreamSighting;
    lastMultiTurn?: StreamSighting;
    warned?: boolean;
}

export function classifyStreamShape(msgs: number, tokens: number, window: number): StreamClass | null {
    if (msgs <= MONOLITH_MAX_MSGS && window > 0 && tokens >= MONOLITH_MIN_USAGE_FRAC * window) return "monolith";
    if (msgs >= MULTITURN_MIN_MSGS) return "multi-turn";
    return null;
}

function num(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function sightingOf(v: unknown): StreamSighting | undefined {
    if (!v || typeof v !== "object") return undefined;
    const s = v as Record<string, unknown>;
    if (!num(s.at) || !num(s.msgs) || !num(s.tokens) || !num(s.usagePct)) return undefined;
    const out: StreamSighting = { at: s.at, msgs: s.msgs, tokens: s.tokens, usagePct: s.usagePct };
    if (typeof s.reason === "string") out.reason = s.reason;
    return out;
}

/** Defensive read — the state round-trips through disk and across versions. */
export function streamWatchOf(session: Session): StreamWatchState {
    const raw = session.metadata.streamWatch as Record<string, unknown> | undefined;
    const st: StreamWatchState = { monolith: 0, multiTurn: 0 };
    if (!raw || typeof raw !== "object") return st;
    if (num(raw.monolith)) st.monolith = raw.monolith;
    if (num(raw.multiTurn)) st.multiTurn = raw.multiTurn;
    st.lastMonolith = sightingOf(raw.lastMonolith);
    st.lastMultiTurn = sightingOf(raw.lastMultiTurn);
    if (raw.warned === true) st.warned = true;
    return st;
}

export interface StreamWatchInput {
    msgs: number;
    // Must be the same usage-grade effectiveTokenCount fed to the nudge, not a
    // raw wire estimate (#728/#1492/#1569 discipline).
    tokens: number;
    window: number;
    // turn.nudge?.reason — carries each flow's own gate verdict into the warning.
    nudgeReason?: string;
}

function describe(cls: StreamClass, s: StreamSighting | undefined): string {
    if (!s) return `${cls} (no recent sighting)`;
    const r = s.reason ? `, nudge "${s.reason}"` : "";
    return `${cls} (${s.msgs} msgs, ~${s.tokens} tok, usage ${s.usagePct}%${r})`;
}

// One-shot dual-stream warning + conflict-ledger entry once both classes have
// each been seen periodically; the ledger makes it reachable after the fact via
// acp_status / web banner / /__bili/stats instead of log-grepping only.
export function observeSessionStream(
    session: Session,
    input: StreamWatchInput,
    log: (level: string, msg: string) => void,
): void {
    const cls = classifyStreamShape(input.msgs, input.tokens, input.window);
    if (cls === null) return;
    const st = streamWatchOf(session);
    const usagePct = input.window > 0 ? Math.round((input.tokens / input.window) * 100) : 0;
    const sight: StreamSighting = { at: Date.now(), msgs: input.msgs, tokens: input.tokens, usagePct };
    if (input.nudgeReason) sight.reason = input.nudgeReason.slice(0, REASON_MAX);
    if (cls === "monolith") {
        st.monolith += 1;
        st.lastMonolith = sight;
    } else {
        st.multiTurn += 1;
        st.lastMultiTurn = sight;
    }
    if (!st.warned && st.monolith >= EACH_CLASS_MIN_SEEN && st.multiTurn >= EACH_CLASS_MIN_SEEN) {
        st.warned = true;
        const detail =
            `[dual-stream] structurally exclusive request shapes alternate on this session id: ` +
            `${describe("multi-turn", st.lastMultiTurn)} <-> ${describe("monolith", st.lastMonolith)}. ` +
            `No single request satisfies the nudge gates on both shapes, so compression stalls while usage pins near the ceiling — ` +
            `a second producer shares this conversation (co-resident compressor summary calls, or cross-instance/cross-profile session reuse; #1206/#394). ` +
            `Identified dsh compaction calls are refused at the gate (#1835) — treat this as an UNCLASSIFIED shape variant needing triage (#1729).`;
        recordConflict(session, "dual-stream", detail);
        log("warn", `[${session.id}] ${detail}`);
    }
    session.metadata.streamWatch = st;
    markDirty(session);
}
