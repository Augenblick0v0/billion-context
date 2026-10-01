import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { conflictEventsOf, summarizeConflicts } from "../src/conflict-watch.js";
import {
    MONOLITH_MAX_MSGS,
    MONOLITH_MIN_USAGE_FRAC,
    MULTITURN_MIN_MSGS,
    classifyStreamShape,
    observeSessionStream,
    streamWatchOf,
} from "../src/stream-watch.js";

// #1729: per-session request-shape observer — classifier boundaries, one-shot
// dual-stream warning, conflict-ledger entry, restart round-trip, corrupt-state
// tolerance.

_setStoreForTest(new SessionStore({ enabled: false }));

function makeSession(id = `ses-${Math.random().toString(36).slice(2)}`): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function logSpy(): { calls: Array<{ level: string; msg: string }>; fn: (level: string, msg: string) => void } {
    const calls: Array<{ level: string; msg: string }> = [];
    return { calls, fn: (level, msg) => calls.push({ level, msg }) };
}

const WINDOW = 167232;
const FLOW_A = { msgs: 107, tokens: 46000, window: WINDOW, nudgeReason: "growth 6620 < floor 22500, ready: T1 85399" };
const FLOW_B = { msgs: 1, tokens: 165760, window: WINDOW, nudgeReason: "EMERGENCY: usage 99% but no tier has effective compressible content" };

test("classifyStreamShape: monolith / multi-turn / ignored boundaries", () => {
    // Production signature (#1727 logs): 1-2 msgs at 91-99% of window.
    assert.equal(classifyStreamShape(1, 165760, WINDOW), "monolith");
    assert.equal(classifyStreamShape(2, 152470, WINDOW), "monolith");
    // Exactly half of the window counts as monolith; one token below does not.
    const half = WINDOW * MONOLITH_MIN_USAGE_FRAC;
    assert.equal(classifyStreamShape(MONOLITH_MAX_MSGS, half, WINDOW), "monolith");
    assert.equal(classifyStreamShape(MONOLITH_MAX_MSGS, half - 1, WINDOW), null);
    // Main-flow shape: multi-turn even at low usage.
    assert.equal(classifyStreamShape(107, 46000, WINDOW), "multi-turn");
    assert.equal(classifyStreamShape(MULTITURN_MIN_MSGS, 900, WINDOW), "multi-turn");
    // Small side calls under both bars are ignored entirely.
    assert.equal(classifyStreamShape(1, 8000, WINDOW), null);
    assert.equal(classifyStreamShape(2, 8000, WINDOW), null);
    // Unknown window can never be a monolith.
    assert.equal(classifyStreamShape(1, 100000, 0), null);
    // Relative threshold scales to big windows: 1M context needs >= 500K.
    assert.equal(classifyStreamShape(1, 500000, 1000000), "monolith");
    assert.equal(classifyStreamShape(1, 499999, 1000000), null);
});

test("one-shot warning + ledger entry once both classes have been seen periodically", () => {
    const session = makeSession();
    const spy = logSpy();
    observeSessionStream(session, FLOW_A, spy.fn);
    observeSessionStream(session, FLOW_B, spy.fn);
    observeSessionStream(session, FLOW_A, spy.fn);
    assert.equal(spy.calls.length, 0);
    observeSessionStream(session, FLOW_B, spy.fn);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.level, "warn");
    assert.ok(spy.calls[0]!.msg.startsWith(`[${session.id}] [dual-stream]`));
    assert.ok(spy.calls[0]!.msg.includes("107 msgs"));
    assert.ok(spy.calls[0]!.msg.includes("usage 99%"));
    assert.ok(spy.calls[0]!.msg.includes("growth 6620 < floor 22500"));
    assert.ok(spy.calls[0]!.msg.includes("#1835"));
    const events = conflictEventsOf(session);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "dual-stream");
    assert.ok(events[0]!.detail.startsWith("[dual-stream]"));
    assert.equal(summarizeConflicts([session]).kinds["dual-stream"], 1);
    // One-shot: further alternation adds neither warnings nor ledger entries.
    observeSessionStream(session, FLOW_A, spy.fn);
    observeSessionStream(session, FLOW_B, spy.fn);
    assert.equal(spy.calls.length, 1);
    assert.equal(conflictEventsOf(session).length, 1);
});

test("no warning without both classes seen periodically", () => {
    const spy = logSpy();
    const singleB = makeSession();
    observeSessionStream(singleB, FLOW_A, spy.fn);
    observeSessionStream(singleB, FLOW_A, spy.fn);
    observeSessionStream(singleB, FLOW_B, spy.fn);
    assert.equal(spy.calls.length, 0);
    const onlyB = makeSession();
    observeSessionStream(onlyB, FLOW_B, spy.fn);
    observeSessionStream(onlyB, FLOW_B, spy.fn);
    assert.equal(spy.calls.length, 0);
    const sideCalls = makeSession();
    observeSessionStream(sideCalls, { msgs: 1, tokens: 8000, window: WINDOW }, spy.fn);
    observeSessionStream(sideCalls, FLOW_A, spy.fn);
    observeSessionStream(sideCalls, FLOW_A, spy.fn);
    assert.equal(spy.calls.length, 0);
    assert.equal(conflictEventsOf(singleB).length, 0);
    assert.equal(conflictEventsOf(onlyB).length, 0);
    assert.equal(conflictEventsOf(sideCalls).length, 0);
});

test("warned flag survives a metadata round-trip (restart)", () => {
    const session = makeSession();
    const spy = logSpy();
    observeSessionStream(session, FLOW_A, spy.fn);
    observeSessionStream(session, FLOW_B, spy.fn);
    observeSessionStream(session, FLOW_A, spy.fn);
    observeSessionStream(session, FLOW_B, spy.fn);
    assert.equal(spy.calls.length, 1);
    const reloaded = makeSession(session.id);
    reloaded.metadata = JSON.parse(JSON.stringify(session.metadata));
    observeSessionStream(reloaded, FLOW_A, spy.fn);
    observeSessionStream(reloaded, FLOW_B, spy.fn);
    assert.equal(spy.calls.length, 1);
    assert.equal(conflictEventsOf(reloaded).length, 1);
});

test("corrupt persisted state degrades to fresh without crashing", () => {
    const garbage: unknown[] = ["nonsense", null, 42, [], { monolith: "x", lastMonolith: { at: "y" } }];
    for (const g of garbage) {
        const session = makeSession();
        session.metadata.streamWatch = g;
        const spy = logSpy();
        observeSessionStream(session, { msgs: 1, tokens: 165760, window: WINDOW }, spy.fn);
        assert.equal(streamWatchOf(session).monolith, 1);
        assert.equal(spy.calls.length, 0);
    }
});

test("long nudge reasons are truncated in the fingerprint", () => {
    const session = makeSession();
    const spy = logSpy();
    const long = "x".repeat(300);
    observeSessionStream(session, { msgs: 107, tokens: 46000, window: WINDOW, nudgeReason: long }, spy.fn);
    observeSessionStream(session, { msgs: 1, tokens: 165760, window: WINDOW }, spy.fn);
    observeSessionStream(session, { msgs: 107, tokens: 46000, window: WINDOW, nudgeReason: long }, spy.fn);
    observeSessionStream(session, { msgs: 1, tokens: 165760, window: WINDOW }, spy.fn);
    assert.equal(spy.calls.length, 1);
    assert.ok(spy.calls[0]!.msg.includes("x".repeat(120)));
    assert.ok(!spy.calls[0]!.msg.includes("x".repeat(121)));
});
