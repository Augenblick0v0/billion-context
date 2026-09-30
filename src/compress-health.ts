// #1762: unified compression-outage observability — per-session "compression
// should be happening but isn't", cause-agnostic (MCP routing rejection / tool
// error / model-not-calling / wire-injection-dead all land on the same red
// flag). Detection consumes the kernel's OWN nudge anchor (state.nudge) plus
// the per-session effectiveConfig stamp, so the threshold is exactly the
// cadence the kernel decided — no parallel trigger logic here.
import { nudgeGrowthInterval, type Session } from "./session.js";
import { log } from "./logger.js";
import type { Config } from "acp-kernel";

/** Minimum model rounds before a stall verdict is meaningful (baseline settling). */
export const OUTAGE_MIN_REQUESTS = 3;
/** Zero successful compresses across this many rounds while the nudge band stays exceeded = stalled. */
export const OUTAGE_ROUNDS = 8;
const HEALTH_KEY = "compressHealth";
const OUTAGE_KEY = "compressOutage";
const RELOG_MS = 30 * 60 * 1000;
const REASON_MAX = 200;

export interface CompressHealthView {
    status: "ok" | "outage";
    /** max(lastInputTokens, contextTokens) — upstream-reported input first,
     *  local processTurn estimate as fallback when usage reports are absent. */
    currentTokens: number;
    /** Effective nudge growth interval for this session (kernel contract). */
    nudgeInterval: number;
    /** Unfolded growth past the kernel's nudge anchor; 0 until the kernel has
     *  anchored a baseline (then no stall verdict is possible anyway). */
    gap: number;
    /** Model rounds since the last successful compress; total rounds when none
     *  ever succeeded. */
    roundsSinceSuccess: number;
    /** Current context minus the size at the last success; null when no
     *  success was ever recorded. */
    stockSinceSuccess: number | null;
    lastSuccessAt?: number;
    failCount?: number;
    lastFailAt?: number;
    lastFailReason?: string;
}

type HealthRecord = {
    lastSuccessAt?: number;
    lastSuccessReq?: number;
    lastSuccessTokens?: number;
    failCount?: number;
    lastFailAt?: number;
    lastFailReason?: string;
};

function readRecord(session: Session): HealthRecord | undefined {
    const raw = session.metadata?.[HEALTH_KEY];
    if (!raw || typeof raw !== "object") return undefined;
    const rec = raw as Record<string, unknown>;
    const out: HealthRecord = {};
    if (typeof rec.lastSuccessAt === "number") out.lastSuccessAt = rec.lastSuccessAt;
    if (typeof rec.lastSuccessReq === "number") out.lastSuccessReq = rec.lastSuccessReq;
    if (typeof rec.lastSuccessTokens === "number") out.lastSuccessTokens = rec.lastSuccessTokens;
    if (typeof rec.failCount === "number") out.failCount = rec.failCount;
    if (typeof rec.lastFailAt === "number") out.lastFailAt = rec.lastFailAt;
    if (typeof rec.lastFailReason === "string") out.lastFailReason = rec.lastFailReason;
    return Object.keys(out).length > 0 ? out : undefined;
}

function currentTokens(session: Session): number {
    return Math.max(session.stats.lastInputTokens ?? 0, session.stats.contextTokens ?? 0);
}

/** The growth interval the kernel decided with on this session's last turn —
 *  the same value its own nudge cadence runs on (owner-flattened
 *  compress.nudgeGrowthTokens included); flat kernel default when unstamped. */
export function nudgeIntervalOf(session: Session): number {
    const stored = session.metadata?.["effectiveConfig"];
    return nudgeGrowthInterval(stored && typeof stored === "object" ? (stored as Config) : undefined);
}

/** The kernel's own growth reference: lastNudgeShownTokens when non-zero,
 *  else the baseline measurement. 0 = never anchored → no verdict possible. */
function nudgeAnchor(session: Session): number {
    const nudge = session.state?.nudge;
    if (!nudge) return 0;
    return nudge.lastNudgeShownTokens > 0 ? nudge.lastNudgeShownTokens : (nudge.lastPerMessageNudgeTokens ?? 0);
}

export function evaluateCompressHealth(session: Session): CompressHealthView {
    const curTok = currentTokens(session);
    const interval = nudgeIntervalOf(session);
    const anchor = nudgeAnchor(session);
    const gap = anchor > 0 ? Math.max(0, curTok - anchor) : 0;
    const rec = readRecord(session);
    const requests = session.stats.requests ?? 0;
    const roundsSinceSuccess = rec?.lastSuccessReq != null ? Math.max(0, requests - rec.lastSuccessReq) : requests;
    const stockSinceSuccess = rec?.lastSuccessTokens != null ? Math.max(0, curTok - rec.lastSuccessTokens) : null;
    const status: CompressHealthView["status"] =
        anchor > 0 && gap >= interval && requests >= OUTAGE_MIN_REQUESTS && roundsSinceSuccess >= OUTAGE_ROUNDS
            ? "outage" : "ok";
    return {
        status,
        currentTokens: curTok,
        nudgeInterval: interval,
        gap,
        roundsSinceSuccess,
        stockSinceSuccess,
        ...(rec?.lastSuccessAt != null ? { lastSuccessAt: rec.lastSuccessAt } : {}),
        ...(rec?.failCount != null ? { failCount: rec.failCount } : {}),
        ...(rec?.lastFailAt != null ? { lastFailAt: rec.lastFailAt } : {}),
        ...(rec?.lastFailReason != null ? { lastFailReason: rec.lastFailReason } : {}),
    };
}

/** Stamp a successful compress (stream.ts applyRanges success path). Clears
 *  the failure streak — same reset semantics as clearCompressFailures (#847).
 *  `preContextTokens` is the pre-compress context size read BEFORE credit
 *  netting, i.e. how much stock this fold consumed. */
export function noteCompressSuccess(session: Session, preContextTokens: number): void {
    if (!session.metadata) return;
    session.metadata[HEALTH_KEY] = {
        lastSuccessAt: Date.now(),
        lastSuccessReq: session.stats.requests,
        ...(preContextTokens > 0 ? { lastSuccessTokens: preContextTokens } : {}),
    };
}

/** Record a failed compress attempt against its owning session (applyRanges
 *  failure paths + plugin tool rejections). Diagnostic garnish only — stall
 *  detection itself never depends on this field being present. */
export function noteCompressFailure(session: Session, reason: string): void {
    if (!session.metadata || !reason) return;
    const prev = readRecord(session) ?? {};
    prev.failCount = (prev.failCount ?? 0) + 1;
    prev.lastFailAt = Date.now();
    prev.lastFailReason = reason.slice(0, REASON_MAX);
    session.metadata[HEALTH_KEY] = prev;
}

/** Per-model-round edge-triggered outage logging (called next to each
 *  ++stats.requests in server.ts prepare*). Warns once on the ok→outage
 *  transition, re-warns at most every RELOG_MS while ongoing, and clears the
 *  marker (plus an info line) on recovery. No writes outside transitions. */
export function noteRoundCompleted(session: Session): void {
    if (!session.metadata) return;
    const view = evaluateCompressHealth(session);
    const rec = session.metadata[OUTAGE_KEY];
    if (view.status === "outage") {
        if (!rec || typeof rec !== "object") {
            session.metadata[OUTAGE_KEY] = { sinceAt: Date.now(), lastLoggedAt: Date.now() };
            log("warn", `[${session.id}] compression outage detected: context ${view.currentTokens} tok is ${view.gap} tok past the ${view.nudgeInterval}-tok nudge anchor with no successful compress in ${view.roundsSinceSuccess} round(s)${view.lastFailReason ? ` (last failure: ${view.lastFailReason})` : ""} — visible in the /__bili/ panel (#1762)`);
            return;
        }
        const state = rec as { sinceAt?: number; lastLoggedAt?: number };
        if (Date.now() - (state.lastLoggedAt ?? 0) >= RELOG_MS) {
            state.lastLoggedAt = Date.now();
            log("warn", `[${session.id}] compression outage still ongoing (${view.roundsSinceSuccess} round(s) without a successful compress, gap ${view.gap} tok ≥ ${view.nudgeInterval}-tok nudge interval) (#1762)`);
        }
    } else if (rec !== undefined) {
        delete session.metadata[OUTAGE_KEY];
        log("info", `[${session.id}] compression outage cleared (#1762)`);
    }
}
