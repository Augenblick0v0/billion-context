/** #4313: immutable local time-of-occurrence on the <acp> tag.
 *
 * Hard invariants pinned here (spec C):
 *  - the time attribute renders ONLY from a STORED value (message.ts or the
 *    persisted first-sight stamp map) — the render path never reads the wall
 *    clock, so a second render of the same logical message is byte-identical
 *    (prefix cache).
 *  - ids claimed BEFORE the feature shipped keep their exact legacy bytes
 *    (no attribute) — zero churn on upgrade.
 *  - first-sight arrival: the stamp is minted exactly once and survives
 *    every later render of that message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { formatTagTime, renderWithSnapshot } from "../src/render-refs.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

// Pin the local zone: the kernel is platform-agnostic and test hosts may
// run anywhere. Each test FILE runs in its own node process, so setting TZ
// here affects every local-time call below deterministically (+08:00, no DST).
process.env.TZ = "Asia/Shanghai";

const msg = (id: string, text: string): CoreMessage => ({
  id,
  role: "user",
  contentType: "text",
  text,
});

test("formatTagTime: stored ms → 'yyyy-mm-dd hh:mm:ss' local, hand-padded", () => {
  // UTC 2026-09-28 07:59:09Z == Asia/Shanghai 2026-09-28 15:59:09 local
  assert.equal(formatTagTime(Date.UTC(2026, 8, 28, 7, 59, 9)), "2026-09-28 15:59:09");
  // UTC 2026-01-04 19:04:05Z == Shanghai 2026-01-05 03:04:05 — single-digit
  // components must be zero-padded AND the day boundary must be local, not UTC.
  assert.equal(formatTagTime(Date.UTC(2026, 0, 4, 19, 4, 5)), "2026-01-05 03:04:05");
});

test("first-sight arrival: stamp minted once, immutable across renders", () => {
  const core = createCore();
  const state = createInitialState();
  const t0 = Date.now();
  const r1 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  const timeOf = (t: string) => / time="([^"]+)"/.exec(t)?.[1];
  const t1a = timeOf(r1.messages[0]!.text!);
  const t1b = timeOf(r1.messages[1]!.text!);
  assert.ok(t1a && t1b, "fresh arrivals carry the time attribute");
  assert.ok(Date.parse(t1a.replace(" ", "T")) >= t0 - 5000, "stamp ≈ first-sight now");
  // Second pass over the SAME state: the stamps persist, bytes are stable.
  const r2 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state: r1.state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  assert.equal(timeOf(r2.messages[0]!.text!), t1a, "id a keeps its stamp");
  assert.equal(timeOf(r2.messages[1]!.text!), t1b, "id b keeps its stamp");
  const stamps = r1.state.tsStamps;
  assert.ok(stamps && typeof stamps["a"] === "number" && typeof stamps["b"] === "number",
    "stamps persisted into state.tsStamps keyed by raw id");
  assert.ok(!("c" in (stamps ?? {})), "no phantom entries for unseen ids");
});

test("pre-feature ids (already claimed, no stamp) keep byte-exact legacy tags", () => {
  const core = createCore();
  const state = createInitialState();
  state.messageRefs = assignRefs([msg("a", "alpha")], {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const result = core.processTurn({
    messages: [msg("a", "alpha")],
    state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  assert.match(
    result.messages[0]!.text!,
    /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/,
    "no time attribute ever appears for un-stamped legacy ids",
  );
});

test("explicit CoreMessage.ts beats minting and is recorded verbatim", () => {
  const core = createCore();
  const T = Date.UTC(2026, 8, 28, 7, 59, 9);
  const result = core.processTurn({
    messages: [{ ...msg("a", "alpha"), ts: T }],
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 10,
  });
  assert.match(
    result.messages[0]!.text!,
    new RegExp(`^<acp tokens="\\d+" type="text" time="${formatTagTime(T)}">m00001<\\/acp>\\nalpha$`),
  );
  assert.equal(result.state.tsStamps?.["a"], T, "stored value wins over the wall clock");
});

test("snapshot stability: two renders of the same snapshot are byte-identical", () => {
  const state = createInitialState();
  state.messageRefs = assignRefs([msg("a", "alpha"), msg("b", "beta")], {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.tsStamps = {
    a: Date.UTC(2026, 8, 28, 7, 59, 9),
    b: Date.UTC(2026, 9, 1, 1, 2, 3),
  };
  const [r1, r2] = [renderWithSnapshot([msg("a", "alpha"), msg("b", "beta")], state),
    renderWithSnapshot([msg("a", "alpha"), msg("b", "beta")], state)];
  assert.deepEqual(
    r1.messages.map((m) => m.text),
    r2.messages.map((m) => m.text),
    "rendering never consults the clock — repeats are byte-equal",
  );
});

test("lint: the render path reads no wall clock", () => {
  const src = readFileSync(new URL("../src/render-refs.ts", import.meta.url), "utf8");
  assert.ok(!/Date\.now\s*\(\s*\)/.test(src), "render-refs never calls Date.now()");
  // The ONLY new Date in the file is formatTagTime parsing a STORED ms value.
  assert.equal(src.match(/\bnew Date\s*\(/g)?.length ?? 0, 1);
});

test("stamps survive applyCompression (the fold clones state, #cloneState carry)", () => {
  const core = createCore();
  // Long enough to clear the default minCompressRange floor.
  const body = "payload ".repeat(500);
  const messages = [msg("a", body), msg("b", body), msg("c", body), msg("d", body), msg("e", body), msg("f", body), msg("g", body), msg("h", body)];
  const turn = core.processTurn({ config: defaultConfig(100000), tokenCount: 20, messages, state: createInitialState() });
  const before: Record<string, number> | undefined = turn.state.tsStamps;
  assert.ok(before && before["a"] && before["h"], "turn minted stamps");
  const result = core.applyCompression({
    // f..h sit in the default protected zone (last 3) — keep the fold older.
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "Messages a through e carry identical large payload bodies; nothing else was decided here." }],
    messages,
    state: turn.state,
    config: defaultConfig(100000),
  });
  assert.equal(result.result.errors.length, 0);
  assert.deepEqual(result.state.tsStamps, before, "the fold must not drop first-sight stamps");
});
