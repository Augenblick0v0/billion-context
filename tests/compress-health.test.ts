import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, defaultConfig, type Config } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getSession, resetSessionCompression, storeEffectiveConfig, _resetSessionsForTest } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { OUTAGE_MIN_REQUESTS, OUTAGE_ROUNDS, evaluateCompressHealth, nudgeIntervalOf, noteCompressFailure, noteCompressSuccess, noteRoundCompleted } from "../src/compress-health.ts";
import { buildOverview, buildSessionDetail, buildSessionList, _resetDiskCacheForTest } from "../src/web/sessions-data.ts";
import { recordToolReject, recentToolRejects, _resetPluginStateForTest } from "../src/plugin.ts";

// Plain JSON session files so any persistence stays deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

interface Stats {
    requests: number;
    tokensSaved: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheSamples: number;
    lastInputTokens: number;
    contextTokens: number;
    retrieveCalls: number;
    retrieveHits: number;
    retrieveMisses: number;
    storedBytes: number;
    storeBytesSaved: number;
    compressCreditTokens: number;
}

function zeroStats(): Stats {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0 };
}

function makeSession(id = "s1", patch: Partial<Stats> = {}): Session {
    const now = Date.now();
    return {
        id,
        meta: { protocol: "openai" },
        stats: { ...zeroStats(), ...patch },
        metadata: {},
        state: createInitialState(),
        createdAt: now,
        lastSeen: now,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function anchor(s: Session, tokens: number): void {
    s.state.nudge.lastNudgeShownTokens = tokens;
}

test.before(() => {
    _setStoreForTest(new SessionStore({ enabled: false }));
});

test.after(() => {
    _resetSessionsForTest();
    _resetDiskCacheForTest();
    _resetPluginStateForTest();
});

test("fresh unanchored session reports ok with no verdict inputs", () => {
    const v = evaluateCompressHealth(makeSession());
    assert.equal(v.status, "ok");
    assert.equal(v.currentTokens, 0);
    assert.equal(v.nudgeInterval, 50_000);
    assert.equal(v.gap, 0);
    assert.equal(v.roundsSinceSuccess, 0);
    assert.equal(v.stockSinceSuccess, null);
    assert.ok(!("lastSuccessAt" in v) && !("failCount" in v) && !("lastFailReason" in v));
});

test("growth below the nudge interval stays ok regardless of round count", () => {
    const s = makeSession("s-low", { requests: 50, lastInputTokens: 140_000 });
    anchor(s, 100_000);
    const v = evaluateCompressHealth(s);
    assert.equal(v.status, "ok");
    assert.equal(v.gap, 40_000);
    assert.equal(v.roundsSinceSuccess, 50);
});

test("exceeded interval with >=8 zero-success rounds flags outage", () => {
    const s = makeSession("s-outage", { requests: OUTAGE_ROUNDS, lastInputTokens: 200_000 });
    anchor(s, 100_000);
    const v = evaluateCompressHealth(s);
    assert.equal(v.status, "outage");
    assert.equal(v.currentTokens, 200_000);
    assert.equal(v.nudgeInterval, 50_000);
    assert.equal(v.gap, 100_000);
    assert.equal(v.stockSinceSuccess, null);
});

test("round gate and min-request gate keep young sessions ok", () => {
    const seven = makeSession("s-7", { requests: OUTAGE_ROUNDS - 1, lastInputTokens: 300_000 });
    anchor(seven, 100_000);
    assert.equal(evaluateCompressHealth(seven).status, "ok", "7 zero-success rounds not yet a verdict");

    const two = makeSession("s-2", { requests: OUTAGE_MIN_REQUESTS - 1, lastInputTokens: 300_000 });
    anchor(two, 100_000);
    assert.equal(evaluateCompressHealth(two).status, "ok", "baseline still settling");
});

test("contextTokens fallback feeds the verdict when usage reports are absent", () => {
    const s = makeSession("s-est", { requests: 9, contextTokens: 160_000 });
    anchor(s, 100_000);
    const v = evaluateCompressHealth(s);
    assert.equal(v.currentTokens, 160_000);
    assert.equal(v.gap, 60_000);
    assert.equal(v.status, "outage");
});

test("a successful compress restarts the round clock and anchors consumed stock", () => {
    const s = makeSession("s-succ", { requests: 10, lastInputTokens: 150_000 });
    anchor(s, 100_000);
    noteCompressSuccess(s, 150_000);

    s.stats.requests = 17;
    s.stats.lastInputTokens = 210_000;
    let v = evaluateCompressHealth(s);
    assert.equal(v.status, "ok", "7 rounds since success is within the flat cadence budget");
    assert.equal(v.roundsSinceSuccess, 7);
    assert.equal(v.stockSinceSuccess, 60_000);
    assert.ok(typeof v.lastSuccessAt === "number");

    s.stats.requests = 18;
    v = evaluateCompressHealth(s);
    assert.equal(v.status, "outage");
    assert.equal(v.roundsSinceSuccess, 8);
});

test("nudgeIntervalOf follows the stamped effectiveConfig, flat default otherwise", () => {
    const plain = makeSession("s-interval");
    assert.equal(nudgeIntervalOf(plain), 50_000);

    const base = defaultConfig(1);
    const flattened: Config = { ...base, modelContextLimit: 200_000, nudge: { ...base.nudge, growthFloor: 10_000, growthCap: 10_000, growthRatio: 0 } };
    storeEffectiveConfig(plain, flattened);
    assert.equal(nudgeIntervalOf(plain), 10_000, "owner-flattened compress.nudgeGrowthTokens step wins");

    const capped: Config = { ...base, modelContextLimit: 200_000, nudge: { ...base.nudge, growthFloor: 200_000, growthCap: 80_000, growthRatio: 0 } };
    storeEffectiveConfig(plain, capped);
    assert.equal(nudgeIntervalOf(plain), 80_000, "min(cap, max(floor, limit*ratio)) kernel formula");
});

test("failure notes accumulate, truncate at 200 chars, and preserve success anchors", () => {
    const s = makeSession("s-fail", { requests: 5, lastInputTokens: 120_000 });
    anchor(s, 90_000);
    noteCompressSuccess(s, 120_000);
    noteCompressFailure(s, "boom");
    noteCompressFailure(s, "boom again");
    let v = evaluateCompressHealth(s);
    assert.equal(v.failCount, 2);
    assert.equal(v.lastFailReason, "boom again");
    assert.ok(typeof v.lastFailAt === "number");
    assert.ok(typeof v.lastSuccessAt === "number", "success anchors survive failure notes");
    assert.equal(v.status, "ok");

    const t = makeSession("s-trunc");
    noteCompressFailure(t, "x".repeat(500));
    v = evaluateCompressHealth(t);
    assert.equal(v.failCount, 1);
    assert.equal(v.lastFailReason?.length, 200);

    noteCompressFailure(t, "");
    assert.equal(evaluateCompressHealth(t).failCount, 1, "empty reason is ignored");
});

test("noteRoundCompleted marks once on transition, holds while ongoing, clears on recovery", () => {
    const s = makeSession("s-edge", { requests: OUTAGE_ROUNDS + 2, lastInputTokens: 200_000 });
    anchor(s, 100_000);
    assert.equal(s.metadata["compressOutage"], undefined);

    noteRoundCompleted(s);
    const marker = s.metadata["compressOutage"] as { sinceAt: number; lastLoggedAt: number };
    assert.ok(marker.sinceAt > 0 && marker.lastLoggedAt > 0);

    noteRoundCompleted(s);
    assert.equal((s.metadata["compressOutage"] as { sinceAt: number }).sinceAt, marker.sinceAt, "no re-mark within the relog window");

    noteCompressSuccess(s, 200_000);
    noteRoundCompleted(s);
    assert.equal(s.metadata["compressOutage"], undefined, "recovery clears the marker");

    const healthy = makeSession("s-ok-rounds", { requests: 2, lastInputTokens: 10_000 });
    noteRoundCompleted(healthy);
    assert.equal(healthy.metadata["compressOutage"], undefined, "healthy rounds never mark");
});

test("resetSessionCompression clears stale health records across a rebase", () => {
    const s = makeSession("s-rebase", { requests: OUTAGE_ROUNDS + 3, lastInputTokens: 200_000 });
    anchor(s, 100_000);
    noteCompressFailure(s, "stale failure");
    noteRoundCompleted(s);
    assert.ok(s.metadata["compressHealth"] && s.metadata["compressOutage"]);

    resetSessionCompression(s);
    assert.equal(s.metadata["compressHealth"], undefined);
    assert.equal(s.metadata["compressOutage"], undefined);
    assert.equal(evaluateCompressHealth(s).status, "ok");
});

test("panel list carries compressHealth only while red; detail always has it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-compress-health-"));
    const prev = process.env.BILI_SESSIONS_DIR;
    process.env.BILI_SESSIONS_DIR = dir;
    try {
        _resetDiskCacheForTest();
        const bad = getSession("outage-1", { protocol: "openai", label: "bad" });
        anchor(bad, 100_000);
        bad.stats.requests = 12;
        bad.stats.lastInputTokens = 200_000;
        noteCompressFailure(bad, "parse:malformed-ranges");
        const good = getSession("ok-1", { protocol: "openai", label: "good" });
        good.stats.requests = 3;
        good.stats.lastInputTokens = 50_000;

        const list = await buildSessionList();
        const rowBad = list.find((r) => r.id === "outage-1");
        assert.ok(rowBad, "red session present in list");
        assert.equal(rowBad.compressHealth?.status, "outage");
        assert.equal(rowBad.compressHealth?.failCount, 1);
        const rowGood = list.find((r) => r.id === "ok-1");
        assert.ok(rowGood, "healthy session present in list");
        assert.ok(!("compressHealth" in rowGood), "healthy rows omit the field entirely");

        const detBad = await buildSessionDetail("outage-1");
        assert.ok(detBad);
        assert.equal(detBad.compressHealth.status, "outage");
        const detGood = await buildSessionDetail("ok-1");
        assert.ok(detGood);
        assert.equal(detGood.compressHealth.status, "ok");
    } finally {
        if (prev === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prev;
        _resetDiskCacheForTest();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("MCP routing rejections surface in the overview feed, cap at 20, and reset cleanly", async () => {
    _resetPluginStateForTest();
    recordToolReject("compress", "conv-abcdef123456", "no-entry");
    recordToolReject("acp_status", "conv-short", "not-resident");
    for (let i = 0; i < 30; i++) recordToolReject("compress", `conv-${i}`, "no-entry");
    assert.equal(recentToolRejects().length, 20, "ring caps at 20");

    const ov = await buildOverview();
    assert.ok(ov.toolRejects && ov.toolRejects.length === 20);
    assert.equal(ov.toolRejects[0].conversationId, "conv-10", "the 12 oldest events are evicted first");
    assert.ok(!ov.toolRejects.some((e) => e.conversationId === "conv-short"), "early events evicted");

    _resetPluginStateForTest();
    const ov2 = await buildOverview();
    assert.ok(!ov2.toolRejects || ov2.toolRejects.length === 0, "reset empties the feed");
});
