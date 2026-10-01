/**
 * Tiered release-notes visibility (#1870).
 *
 * The npm companion package `billion-context-release-notes` (published by CI
 * from this repo's release-notes/ directory, exactly like the advisories
 * companion) carries one model-written summary per release with a tier label:
 *   - routine      — default; worth having, no urgency
 *   - recommended  — worth restarting soon (correctness/cache fixes)
 * Critical defects stay in the ADVISORY doc (#1481) — it is the only
 * authoritative source for force-upgrades; this doc never claims critical.
 *
 * Why a watcher at all: the self-updater is a silent courier — it downloads a
 * new version and writes one log line ("Restart to finish") that native-lane
 * users (pi/opencode/dsh) never see, so disk runs new while the process runs
 * old for days. This module keeps the state the visibility surfaces
 * (acp_status, the /acp panel) read: the running version, the disk version
 * (restart pending = disk newer than running), and the release notes SPAN —
 * every entry strictly newer than the running version, which is exactly
 * "what you'll get when you restart" from the USER's point of view.
 *
 * Fail-open everywhere: an unreachable or malformed source must never degrade
 * a working proxy. No install side effects here — visibility only.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import type { FetchOptions } from "./fetch-util.js";
import { CHECK_INTERVAL_MS, egressDispatcher, findInstallDir, readDiskVersion, registryUrlFor } from "./update.js";

const RELEASE_NOTES_PACKAGE = "billion-context-release-notes";
const SUPPORTED_SCHEMA = 1;
/** Producer-side cap (release-notes/README): the doc keeps ~20 entries. */
export const MAX_RELEASE_NOTES_ENTRIES = 20;

export type ReleaseTier = "routine" | "recommended";

export type ReleaseNoteEntry = {
    /** Exact released version this entry describes. */
    version: string;
    /** ISO date (YYYY-MM-DD) of the release. */
    date?: string;
    tier: ReleaseTier;
    /** Model-written, user-meaningful one-liner (what changes for you). */
    summary: string;
};

export type ReleaseNotesState = {
    /** Newest-first as published; empty until the first successful check. */
    entries: ReleaseNoteEntry[];
    /** Disk version captured by the last watcher cycle (restart-pending
     *  signal: disk newer than the RUNNING version). */
    diskVersion?: string;
    lastCheckAt?: number;
    lastError?: string;
};

let state: ReleaseNotesState = { entries: [] };

export function getReleaseNotesState(): ReleaseNotesState {
    return state;
}

/** Test seam: replace the live state without driving the watcher. */
export function _setReleaseNotesStateForTest(s: ReleaseNotesState): void {
    state = s;
}

/** Test seam: clear state, warn dedupe, and stop the timer. */
export function _resetReleaseNotesWatcherForTest(): void {
    state = { entries: [] };
    warnedKeys.clear();
    stopReleaseNotesWatcher();
}

/** Default source: the companion package's `latest` doc on the SAME
 *  configured registry as the updater (BILI_UPDATE_REGISTRY aware via
 *  registryUrlFor) — mirroring the advisory source. An explicit override wins
 *  verbatim. */
export function resolveReleaseNotesUrl(configured: string | undefined): string {
    const v = configured?.trim();
    if (v) return v;
    return registryUrlFor(RELEASE_NOTES_PACKAGE, "latest");
}

/** Validate the raw release-notes document (the companion package's packument
 *  entry, whose custom field carries the payload). Malformed entries are
 *  skipped individually; a document with entries but zero usable ones is an
 *  error so callers can distinguish "no notes" from "broken feed". */
export function parseReleaseNotesDoc(raw: unknown): { entries: ReleaseNoteEntry[]; error?: string } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { entries: [], error: "document is not a JSON object" };
    }
    const payload = (raw as Record<string, unknown>).billionContextReleaseNotes;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return { entries: [], error: "missing billionContextReleaseNotes object" };
    }
    const p = payload as Record<string, unknown>;
    if (p.schema !== SUPPORTED_SCHEMA) {
        return { entries: [], error: `unsupported schema ${String(p.schema)} (supported: ${SUPPORTED_SCHEMA})` };
    }
    if (!Array.isArray(p.releases)) {
        return { entries: [], error: "releases field is not an array" };
    }
    const entries: ReleaseNoteEntry[] = [];
    for (const item of p.releases) {
        if (typeof item !== "object" || item === null) continue;
        const e = item as Record<string, unknown>;
        const version = typeof e.version === "string" ? e.version.trim() : "";
        const tier = e.tier === "recommended" || e.tier === "routine" ? e.tier : undefined;
        const summary = typeof e.summary === "string" ? e.summary.trim() : "";
        if (!semver.valid(version) || tier === undefined || !summary) continue;
        entries.push({
            version,
            tier,
            summary,
            ...(typeof e.date === "string" && e.date.trim() ? { date: e.date.trim() } : {}),
        });
    }
    if (p.releases.length > 0 && entries.length === 0) {
        return { entries: [], error: "no valid release-note entries in document" };
    }
    return { entries };
}

/** The notes a caller RUNNING `fromVersion` would gain — every entry strictly
 *  newer, ordered oldest→newest so the span reads chronologically ("you'll
 *  get 0.1.180, then 0.1.181"). This is the user-side diff between the
 *  current version and the newest release. Invalid `fromVersion` → empty. */
export function spanNotes(entries: ReleaseNoteEntry[], fromVersion: string): ReleaseNoteEntry[] {
    if (!semver.valid(fromVersion)) return [];
    return entries
        .filter((e) => {
            try {
                return semver.gt(e.version, fromVersion);
            } catch {
                return false;
            }
        })
        .sort((a, b) => semver.compare(a.version, b.version));
}

/** The newest valid entry, or undefined when the feed is empty/unknown. */
export function latestKnownVersion(entries: ReleaseNoteEntry[]): string | undefined {
    let best: string | undefined;
    for (const e of entries) {
        if (best === undefined || semver.gt(e.version, best)) best = e.version;
    }
    return best;
}

export type UpdateVisibility = {
    runningVersion: string;
    /** Disk version if the watcher saw one (undefined = unknown). */
    diskVersion?: string;
    /** Disk holds a strictly newer version than this process — a restart
     *  finishes the update. The one action that clears the notice. */
    pendingRestart: boolean;
    /** Notes for everything between running and the newest known release. */
    span: ReleaseNoteEntry[];
    /** A recommended-tier entry sits in the span — worth updating soon even
     *  without a pending restart (e.g. auto-update disabled). */
    recommended: boolean;
};

/** Derived, synchronous view for the visibility surfaces (#1870): reads the
 *  watcher's cached state — no network, no fs. Clean installs (no span, no
 *  pending restart) yield visible=false and every surface stays
 *  byte-identical to the pre-#1870 output. */
export function getUpdateVisibility(runningVersion: string): UpdateVisibility & { visible: boolean } {
    const diskVersion = state.diskVersion;
    const pendingRestart =
        diskVersion !== undefined &&
        semver.valid(diskVersion) === diskVersion &&
        semver.gt(diskVersion, runningVersion);
    const span = spanNotes(state.entries, runningVersion);
    const recommended = span.some((e) => e.tier === "recommended");
    return {
        runningVersion,
        ...(diskVersion !== undefined ? { diskVersion } : {}),
        pendingRestart,
        span,
        recommended,
        visible: pendingRestart || recommended,
    };
}

/** Shared wording for the /acp panel line — one line, stripper-safe slot is
 *  the caller's job. Kept compact: the panel is small, and acp_status carries
 *  the full span. */
export function describeUpdateReady(v: UpdateVisibility): string {
    const latest = v.span.length > 0 ? v.span[v.span.length - 1].version : v.diskVersion;
    const topRec = v.span.find((e) => e.tier === "recommended");
    if (v.pendingRestart && latest !== undefined) {
        const notable = topRec ? ` Notable since ${v.runningVersion}: ${topRec.summary}` : "";
        return `Update ready: ${latest} — restart to finish.${notable}`;
    }
    if (topRec && latest !== undefined) {
        return `Update available: ${latest} (recommended) — ${topRec.summary} (npm install -g billion-context@${latest})`;
    }
    return `Update available: ${latest ?? "newer version"} — npm install -g billion-context@${latest ?? "latest"}`;
}

function throttleFile(): string {
    return path.join(cacheDir(), ".release-notes-check");
}

async function readLastCheck(): Promise<number> {
    try {
        const data = await readFile(throttleFile(), "utf-8");
        return parseInt(data.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

async function writeLastCheck(ts: number): Promise<void> {
    try {
        await mkdir(path.dirname(throttleFile()), { recursive: true });
        await writeFile(throttleFile(), String(ts), "utf-8");
    } catch {
        // best-effort
    }
}

export type ReleaseNotesWatcherOptions = {
    packageName: string;
    /** Running process version (disk wins when readable, same rule as the
     *  updater). */
    currentVersion: string;
    /** Override for the notes document URL (config `releaseNotesUrl` / env
     *  BILI_RELEASE_NOTES_URL). Absent = companion package on the configured
     *  registry. */
    releaseNotesUrl?: string;
    resolveProxy?: (url: string) => string | undefined;
    /** Test seam: pin the install directory instead of findInstallDir(). */
    installDir?: string;
    log?: Logger;
};

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let firstCheckDone = false;
const warnedKeys = new Set<string>();

function warnOnce(log: Logger, key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    log("warn", message);
}

/** Run one release-notes check (throttled unless `force`). Fetches the notes
 *  doc and re-reads the disk version — visibility only, NEVER installs. */
export async function runReleaseNotesCheck(opts: ReleaseNotesWatcherOptions, force = false): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const log = opts.log ?? loggerLog;
    try {
        const now = Date.now();
        const lastCheck = await readLastCheck();
        if (!force && firstCheckDone && now - lastCheck < CHECK_INTERVAL_MS) return;
        await writeLastCheck(now);
        firstCheckDone = true;

        const url = resolveReleaseNotesUrl(opts.releaseNotesUrl);
        let data: unknown;
        try {
            const dispatcher = egressDispatcher({ resolveProxy: opts.resolveProxy }, url);
            const init: FetchOptions = {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(5000),
                ...(dispatcher ? { dispatcher } : {}),
            };
            const res = await fetch(url, init as RequestInit);
            if (!res.ok) throw new Error(`release-notes source returned HTTP ${res.status}`);
            data = await res.json();
        } catch (e) {
            state.lastError = String(e);
            warnOnce(log, `fetch:${String(e)}`, `[release-notes] check failed (${String(e)}) — continuing without release notes`);
            return;
        }
        const parsed = parseReleaseNotesDoc(data);
        if (parsed.error) {
            state.lastError = parsed.error;
            warnOnce(log, `parse:${parsed.error}`, `[release-notes] ignoring malformed document: ${parsed.error}`);
            return;
        }
        state.entries = parsed.entries.slice(0, MAX_RELEASE_NOTES_ENTRIES);
        state.lastError = undefined;
        state.lastCheckAt = now;

        // Restart-pending signal: disk vs the RUNNING process version.
        const installDir = opts.installDir ?? (await findInstallDir(opts.packageName));
        state.diskVersion = installDir ? await readDiskVersion(installDir) : undefined;
    } catch (e) {
        state.lastError = String(e);
        warnOnce(log, `check:${String(e)}`, `[release-notes] check failed: ${String(e)}`);
    } finally {
        inFlight = false;
    }
}

export function startReleaseNotesWatcher(opts: ReleaseNotesWatcherOptions): void {
    if (timer) return;
    loggerLog("info", `[release-notes] watcher enabled (checking every ${CHECK_INTERVAL_MS / 1000 | 0}s, visibility only — never installs)`);
    setTimeout(() => {
        void runReleaseNotesCheck(opts);
    }, 15_000);
    timer = setInterval(() => {
        void runReleaseNotesCheck(opts);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}

/** Stop the periodic check loop (for tests / clean shutdown). */
export function stopReleaseNotesWatcher(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
