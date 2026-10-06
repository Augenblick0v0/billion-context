import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Config } from "acp-kernel";
import { resolveRequestConfig } from "../src/compress-settings.ts";

// #2110 root cause RC2: the kernel default growth step was flat 50k at every
// window (floor=cap=50000, #379/#380), so sub-1M windows waited a 1M-calibrated
// step — on the issue's 272k-native window the effective 204k budget line made
// the 50k gate ~24% of the window, and quiet-turn growth never re-armed the
// nudge cadence (66 straight requests, pending 43–52k, zero folds).
//
// The fix restores a window-relative default band
// clamp(0.05 × window, 20000, 50000): ≥1M byte-identical, ≤400k floored at 20k.
// This suite pins the bili-side plumbing: per-route modelContextLimit flows into
// the effective kernel config (the step scales with the ROUTE's window, not the
// global base), and compress.nudgeGrowthTokens still flattens the band to a
// fixed step (the live-verified escape hatch from issue #2110).

function stepFor(config: Config): number {
  const turn = createCore().processTurn({
    messages: [],
    state: createInitialState(),
    config,
    tokenCount: 1,
  });
  const breakdown = turn.nudge?.breakdown as Record<string, number> | undefined;
  assert.ok(breakdown?.nudgeGrowthTokens !== undefined, "decideNudge breakdown carries nudgeGrowthTokens");
  return breakdown.nudgeGrowthTokens;
}

test("#2110: per-route windows scale the default growth step through resolveRequestConfig", () => {
  const routes = {
    "http://upstream.local": {
      models: {
        "small-window-model": { context: 272_000 },
        "big-window-model": { context: 1_000_000 },
      },
    },
  };
  const base = defaultConfig(1_000_000);

  const small = resolveRequestConfig(base, routes, "http://upstream.local", "small-window-model", 272_000);
  assert.equal(small.modelContextLimit, 272_000, "route window wins");
  assert.equal(stepFor(small), 20000, "272k route window gets the 20k floor (was flat 50k)");

  const big = resolveRequestConfig(base, routes, "http://upstream.local", "big-window-model", undefined);
  assert.equal(big.modelContextLimit, 1_000_000);
  assert.equal(stepFor(big), 50000, "1M window keeps the legacy 50k step byte-identical");
});

test("#2110: compress.nudgeGrowthTokens still pins a flat step over the scaled default", () => {
  const routes = {
    "http://upstream.local": {
      models: { "small-window-model": { context: 204_000, compress: { nudgeGrowthTokens: 25000 } } },
    },
  };
  const base = defaultConfig(1_000_000);
  const cfg = resolveRequestConfig(base, routes, "http://upstream.local", "small-window-model", undefined);
  assert.equal(cfg.nudge.growthFloor, 25000, "escape hatch flattens the band floor");
  assert.equal(cfg.nudge.growthCap, 25000, "escape hatch flattens the band cap");
  assert.equal(stepFor(cfg), 25000, "the flattened step wins over window scaling at any window");
});
