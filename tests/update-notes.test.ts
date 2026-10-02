// #1870: tiered release-notes visibility. The self-updater is a silent
// courier on native lanes (its "Restart to finish" line only reaches a log
// file), so disk runs new while the process runs old. These tests pin the
// three behaviors that make the fix safe and useful:
//   1. parsing/validation of the remote doc (bad entries skipped, bad doc = error),
//   2. the user-side span + visibility derivation (restart-pending beats
//      everything; recommended surfaces even without pending restart; clean
//      installs see NOTHING — byte-identical to pre-#1870 output),
//   3. the two surfaces: acp_status section + /acp panel line before the
//      footer (stripper-safe), with remote-doc text escaped for replace().
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import {
    _resetReleaseNotesWatcherForTest,
    _setReleaseNotesStateForTest,
    parseReleaseNotesDoc,
    spanNotes,
    getUpdateVisibility,
    describeUpdateReady,
    type ReleaseNoteEntry,
} from "../src/update-notes.ts";
import { VERSION } from "../src/version.ts";
import semver from "semver";

// #1870 follow-up: the two SURFACE tests below exercise the real running
// version (package.json at runtime), so their fixtures must be derived FROM
// it — hardcoded 0.1.18x strings rotted the moment v0.1.180 shipped and put
// master's CI red after the #1870 merge. The explicit-version unit tests
// above keep hardcoded strings (they pin spanNotes logic, not this repo's
// current version).
const RUNNING = semver.valid(VERSION) ?? "0.0.1";
const NEXT = semver.inc(RUNNING, "patch") ?? "0.0.2";
const NEXT2 = semver.inc(NEXT, "patch") ?? "0.0.3";
const SURFACE_ENTRIES: ReleaseNoteEntry[] = [
    { version: NEXT2, tier: "routine", summary: "docs and log polish" },
    { version: NEXT, date: "2026-10-02", tier: "recommended", summary: "OpenCode WebSocket traffic intercepted again (#1844)" },
    { version: RUNNING, tier: "recommended", summary: "compression survives restart/resume forks (#1834)" },
];

const ENTRIES: ReleaseNoteEntry[] = [
    { version: "0.1.181", tier: "routine", summary: "docs and log polish" },
    { version: "0.1.180", date: "2026-10-02", tier: "recommended", summary: "OpenCode WebSocket traffic intercepted again (#1844)" },
    { version: "0.1.179", tier: "recommended", summary: "compression survives restart/resume forks (#1834)" },
];

test("#1870 parseReleaseNotesDoc: valid doc parses; malformed entries skip; broken doc errors", () => {
    const doc = {
        billionContextReleaseNotes: {
            schema: 1,
            releases: [
                { version: "0.1.181", tier: "routine", summary: "ok" },
                { version: "not-semver", tier: "routine", summary: "skipped" },
                { version: "0.1.180", tier: "urgent", summary: "bad tier skipped" },
                { version: "0.1.179", tier: "routine", summary: "   " },
                { version: "0.1.178", tier: "recommended", date: "2026-10-01", summary: "ok with date" },
            ],
        },
    };
    const parsed = parseReleaseNotesDoc(doc);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0].version, "0.1.181");
    assert.equal(parsed.entries[1].date, "2026-10-01");

    assert.equal(parseReleaseNotesDoc(null).error, "document is not a JSON object");
    assert.equal(parseReleaseNotesDoc({}).error, "missing billionContextReleaseNotes object");
    assert.equal(parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 2, releases: [] } }).error, "unsupported schema 2 (supported: 1)");
    assert.equal(parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 1, releases: "no" } }).error, "releases field is not an array");
    // Entries present but ALL invalid → error (distinguish broken feed from empty).
    const allBad = parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 1, releases: [{ version: "x", tier: "routine", summary: "s" }] } });
    assert.equal(allBad.error, "no valid release-note entries in document");
    // Empty releases array = legitimate empty feed, not an error.
    assert.deepEqual(parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 1, releases: [] } }), { entries: [] });
});

test("#1870 spanNotes: strictly-newer entries, ascending (user-side diff), invalid base = none", () => {
    const span = spanNotes(ENTRIES, "0.1.179");
    assert.deepEqual(span.map((e) => e.version), ["0.1.180", "0.1.181"], "excludes the running version itself, oldest first");
    assert.deepEqual(spanNotes(ENTRIES, "0.1.180").map((e) => e.version), ["0.1.181"]);
    assert.deepEqual(spanNotes(ENTRIES, "0.1.181"), [], "up to date → empty span");
    assert.deepEqual(spanNotes(ENTRIES, "0.1.182"), [], "future version → empty span");
    assert.deepEqual(spanNotes(ENTRIES, "garbage"), [], "invalid running version → empty (no crash)");
});

test("#1870 getUpdateVisibility: pending restart beats everything; recommended-only still visible; clean = invisible", () => {
    _resetReleaseNotesWatcherForTest();
    try {
        // Clean install: no disk info, no span → invisible (byte-identical surfaces).
        const clean = getUpdateVisibility(VERSION);
        assert.equal(clean.visible, false);
        assert.equal(clean.pendingRestart, false);
        assert.deepEqual(clean.span, []);

        // Recommended release exists beyond running version (auto-update off).
        _setReleaseNotesStateForTest({ entries: ENTRIES });
        const recOnly = getUpdateVisibility("0.1.179");
        assert.equal(recOnly.pendingRestart, false);
        assert.equal(recOnly.recommended, true);
        assert.equal(recOnly.visible, true, "recommended alone must surface (updater may be off)");
        assert.deepEqual(recOnly.span.map((e) => e.version), ["0.1.180", "0.1.181"]);

        // Disk newer than running → restart-pending, the actionable case.
        _setReleaseNotesStateForTest({ entries: ENTRIES, diskVersion: "0.1.181" });
        const pending = getUpdateVisibility("0.1.179");
        assert.equal(pending.pendingRestart, true);
        assert.equal(pending.visible, true);

        // Disk older or equal (edge: rollback / same) → not pending.
        assert.equal(getUpdateVisibility("0.1.181").pendingRestart, false);
        _setReleaseNotesStateForTest({ entries: ENTRIES, diskVersion: "0.1.175" });
        assert.equal(getUpdateVisibility("0.1.179").pendingRestart, false);
        // Disk version garbage → never pending (fail-closed on visibility, no crash).
        _setReleaseNotesStateForTest({ entries: [], diskVersion: "not-semver" });
        const garbage = getUpdateVisibility("0.1.179");
        assert.equal(garbage.pendingRestart, false);
        assert.equal(garbage.visible, false);
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

test("#1870 describeUpdateReady: actionable wording + byte-stability", () => {
    _resetReleaseNotesWatcherForTest();
    try {
        _setReleaseNotesStateForTest({ entries: ENTRIES, diskVersion: "0.1.181" });
        const pending = getUpdateVisibility("0.1.179");
        const line = describeUpdateReady(pending);
        assert.ok(line.startsWith("Update ready: 0.1.181 — restart to finish."), `pending-restart wording (got: ${line})`);
        assert.ok(line.includes("#1844"), "top recommended summary carried");
        assert.equal(line, describeUpdateReady(getUpdateVisibility("0.1.179")), "byte-stable for identical state");

        _setReleaseNotesStateForTest({ entries: ENTRIES }); // no disk info
        const rec = describeUpdateReady(getUpdateVisibility("0.1.179"));
        assert.ok(rec.startsWith("Update available: 0.1.181 (recommended) —"), `recommended wording (got: ${rec})`);
        assert.ok(rec.includes("npm install -g billion-context@0.1.181"), "manual command when restart cannot finish it");

        // Span with NO recommended entry + no pending restart = invisible; the
        // routine-only branch exists for panel completeness only.
        const routineOnly = getUpdateVisibility("0.1.178"); // span = 179(rec),… — pick a base where span is routine-only
        const routineEntries: ReleaseNoteEntry[] = [{ version: "0.2.0", tier: "routine", summary: "polish" }];
        _setReleaseNotesStateForTest({ entries: routineEntries });
        const ro = getUpdateVisibility("0.1.179");
        assert.equal(ro.recommended, false);
        assert.equal(ro.visible, false);
        assert.ok(describeUpdateReady(ro).includes("0.2.0"), "fallback line still names the version");
        assert.ok(routineOnly !== undefined);
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

// ---------------------------------------------------------------------------
// Surfaces. Mirrors the #1577 advisory-surface tests.

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCtx(messages: CoreMessage[]): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "update-notes-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function makeCtx12(): ReturnType<typeof makeCtx> {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = makeCtx(msgs);
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

test("#1870 acp_status: UPDATE READY section lists the span; clean state stays byte-absent", async () => {
    _resetReleaseNotesWatcherForTest();
    const { handleAcpStatus } = await import("../src/acp-status.ts");
    try {
        const ctx = makeCtx12();
        const clean = handleAcpStatus({}, ctx);
        assert.ok(!clean.includes("UPDATE READY") && !clean.includes("UPDATE AVAILABLE"), "no section on a clean install");

        _setReleaseNotesStateForTest({ entries: SURFACE_ENTRIES, diskVersion: NEXT2 });
        const out = handleAcpStatus({}, ctx);
        assert.ok(out.includes(`UPDATE READY (instance-level): ${NEXT2} downloaded — restart this agent's proxy to finish`), "actionable headline names the disk version");
        assert.ok(out.includes(`(running ${VERSION})`), "names the running version for contrast");
        assert.ok(out.includes(`· ${NEXT} [recommended] OpenCode WebSocket traffic intercepted again (#1844)`), "span renders versions below disk but above running, tier-first");
        assert.ok(out.includes(`· ${NEXT2} [routine] docs and log polish`), "span renders up to the disk version the restart will finish");
        assert.ok(out.includes("GET /__bili/status → update"), "points at the live-state field");

        // No disk info (auto-update off): AVAILABLE wording + manual command.
        _setReleaseNotesStateForTest({ entries: SURFACE_ENTRIES });
        const avail = handleAcpStatus({}, ctx);
        assert.ok(avail.includes("UPDATE AVAILABLE (instance-level):"), "available headline when nothing is pending");
        assert.ok(avail.includes(`npm install -g billion-context@${NEXT2}`), "manual update command present");
        assert.ok(!avail.includes("UPDATE READY"), "ready wording reserved for the pending-restart case");
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

test("#1870 /acp panel: one update line BEFORE the footer, stripper-safe, byte-exact when clean; $ survives", async () => {
    _resetReleaseNotesWatcherForTest();
    const { _resetSessionsForTest } = await import("../src/session.ts");
    const { handlePluginStatus } = await import("../src/plugin.ts");
    const { PANEL_BOX_FOOTER } = await import("../src/acp-panel.ts");
    try {
        _resetSessionsForTest();
        const { getSession } = await import("../src/session.ts");
        getSession("upd-sess", { protocol: "anthropic", label: "UPD" });
        const deps = { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} };

        const r0 = mockRes();
        handlePluginStatus("never-seen", r0.res, deps, true);
        assert.equal(r0.status, 200);
        const p0 = JSON.parse(r0.body).panel as string;
        assert.ok(!p0.includes("Update ready") && !p0.includes("Update available"), "no update line when clean");
        assert.ok(p0.includes(PANEL_BOX_FOOTER), "footer present when clean");

        _setReleaseNotesStateForTest({ entries: SURFACE_ENTRIES, diskVersion: NEXT2 });
        const r1 = mockRes();
        handlePluginStatus("never-seen", r1.res, deps, true);
        const p1 = JSON.parse(r1.body).panel as string;
        assert.ok(p1.includes(`Update ready: ${NEXT2} — restart to finish.`), "panel line present");
        assert.ok(p1.includes(PANEL_BOX_FOOTER), "footer still present with the update line");
        assert.ok(p1.indexOf("Update ready") < p1.indexOf(PANEL_BOX_FOOTER), "update line sits BEFORE the footer (stripper anchor)");
        const footerEsc = PANEL_BOX_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.equal((p1.match(new RegExp(footerEsc, "g")) ?? []).length, 1, "footer appears exactly once");

        // Remote-doc summary containing replace() pattern syntax must survive
        // byte-exact (same escape the advisory line relies on).
        const dollarSummary = "saves $5 and echoes $& `$'` verbatim";
        _setReleaseNotesStateForTest({
            entries: [{ version: NEXT, tier: "recommended", summary: dollarSummary }],
            diskVersion: NEXT,
        });
        const r2 = mockRes();
        handlePluginStatus("never-seen", r2.res, deps, true);
        const p2 = JSON.parse(r2.body).panel as string;
        assert.ok(p2.includes(dollarSummary), "dollar-sign summary survives byte-exact");
    } finally {
        _resetReleaseNotesWatcherForTest();
        _resetSessionsForTest();
    }
});
