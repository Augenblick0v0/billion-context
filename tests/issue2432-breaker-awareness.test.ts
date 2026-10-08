// #2432: the compress circuit breaker (#2146) was invisible outside its own
// receipts while still steering every other surface against it — acp_status
// kept advertising compressible ranges the model then failed on (climbing the
// counter), and every turn's nudge kept inviting the same failing calls. The
// armed state now reaches those surfaces (acp_status section + counter,
// per-turn nudge suppression), and the armed receipt branches on the failure
// CAUSE: substrate-destruction gets the single-recovery-step wording (one
// acp_status + live-range re-anchor; success disarms) instead of the blanket
// "do not poll acp_status" order that locked the model out of the only exit.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, compressBreakerArmed, compressBreakerDetail, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { METADATA_DRIFT_ESCALATED } from "../src/fold-reconcile.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue2432-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function makeCtx(messages: CoreMessage[], config?: Config, logs?: string[]): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: logs ? (m) => logs.push(m) : () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

test("#2432: armed receipts branch on cause — substrate-destruction names the single recovery step", () => {
    // Ten mapped messages; the "resent history" then drops the first seven
    // (an out-of-band rewrite), so their refs are known-but-dangling — the
    // kernel's "cannot be anchored" shape.
    const all = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(400)));
    const ctx = makeCtx(all);
    ctx.messages = all.slice(7);
    ctx.session.metadata[METADATA_DRIFT_ESCALATED] = true;

    const f1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `failure 1 (got: ${f1.slice(0, 120)})`);
    assert.match(f1, /cannot be anchored/, "kernel reports the unanchored range");
    assert.match(f1, /\[cause: substrate-destruction/, "escalated drift sharpens the cause");
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "failure 1 carries no breaker");

    const f2 = applyRanges(parseCompressInput(compressArgs("m00004", "m00006")), ctx).text;
    assert.ok(!f2.includes("CIRCUIT BREAKER"), "failure 2 carries no breaker");

    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00007")), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "third failure arms the breaker");
    assert.match(f3, /fold substrate was destroyed/, "substrate cause named in the armed paragraph");
    assert.match(f3, /exactly ONE recovery step/, "recovery step stated");
    assert.match(f3, /run acp_status once/, "the single permitted action is named");
    assert.doesNotMatch(f3, /do not poll acp_status/, "the blanket ban is WITHHELD for substrate-destruction (it forbids the only exit)");
});

test("#2432: non-substrate causes keep the verbatim loop-noise paragraph (owner decision 2026-10-07)", () => {
    // Same dangling shape but WITHOUT the escalated drift flag: the cause is
    // content-changed, and the armed paragraph must stay byte-identical to the
    // pre-#2432 wording (its measured behavior is load-bearing for #2146).
    const all = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(400)));
    const ctx = makeCtx(all);
    ctx.messages = all.slice(7);

    applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx);
    applyRanges(parseCompressInput(compressArgs("m00004", "m00006")), ctx);
    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00007")), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arms at three");
    assert.match(f3, /do not try other ranges, do not re-issue any previous range, and do not poll acp_status\./, "verbatim loop-noise sentence intact");
    assert.match(f3, /compression happens again only when there is genuinely new content to fold\.\]/, "verbatim closing intact");
    assert.doesNotMatch(f3, /exactly ONE recovery step/, "no substrate wording for a non-substrate cause");
});

test("#2432: compressBreakerDetail/Armed mirror the receipt's arming conditions", () => {
    const s = makeSession();
    assert.equal(compressBreakerArmed(s), false, "empty session disarmed");
    assert.equal(compressBreakerDetail(s), undefined);

    s.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() };
    assert.equal(compressBreakerArmed(s), false, "below threshold disarmed");

    s.metadata["compressFailStreak"] = { n: 3, lastAt: Date.now() - 11 * 60 * 1000 };
    assert.equal(compressBreakerArmed(s), false, "decayed streak reads disarmed even before the next failure rewrites the metadata");

    s.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() - 4 * 60 * 1000 };
    const d = compressBreakerDetail(s);
    assert.deepEqual(d, { n: 4, threshold: 3, decayMinutes: 10 }, "armed detail carries the visible counter");
    assert.equal(compressBreakerArmed(s), true);
});

test("#2432: acp_status shows the armed counter and suppresses the Compressible-ranges list", () => {
    // Six big messages: with no breaker the surface advertises ranges.
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const session = makeSession();
    session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: msgs, session };

    const healthy = handleAcpStatus({}, ctx);
    assert.ok(healthy.text?.includes("Compressible ranges ("), `healthy surface advertises ranges (got: ${healthy.text?.slice(-300)})`);
    assert.ok(!healthy.text?.includes("COMPRESS CIRCUIT BREAKER"), "healthy surface has no breaker section");

    session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() };
    const armed = handleAcpStatus({}, ctx);
    assert.match(armed.text, /COMPRESS CIRCUIT BREAKER: ARMED — consecutiveFailures: 4 \/ 3\./, "armed section with the visible counter");
    assert.match(armed.text, /Disarms on one successful compress or 10 min/, "disarm condition stated");
    assert.ok(!(armed.text).includes("Compressible ranges ("), "ranges list suppressed while armed — no contradiction with the breaker receipt");
    assert.match(armed.text, /SUPPRESSED while the breaker is armed/, "suppression is explained, not silent");
});
