import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";

// #2110: the default growth step must be window-relative —
// clamp(growthRatio × modelContextLimit, growthFloor=20000, growthCap=50000).
// The old flat floor=cap=50000 (#379/#380) pinned EVERY window to a 50k step:
// ~24% of a 204k budget line, so quiet-turn growth never re-armed the nudge
// cadence and compressible mass sat idle turn after turn (the issue's session
// held pending 43–52k against the 50k gate for 66 straight requests). ≥1M
// windows must stay byte-identical (0.05 × 1M = 50000 = cap).
function growthBreakdown(modelContextLimit: number, nudgeOverrides: Record<string, unknown> = {}): Record<string, number> {
  const config = defaultConfig(modelContextLimit, { nudge: nudgeOverrides } as never);
  const core = createCore();
  const turn = core.processTurn({
    messages: [],
    state: createInitialState(),
    config,
    tokenCount: 1,
  });
  assert.ok(turn.nudge?.breakdown, "decideNudge always emits a breakdown");
  return turn.nudge.breakdown as unknown as Record<string, number>;
}

test("#2110: default growth step scales with the window", () => {
  // Legacy calibration is preserved at the top: 1M windows are byte-identical.
  assert.equal(growthBreakdown(1_000_000).nudgeGrowthTokens, 50000, "1M window keeps the flat 50k step");
  assert.equal(growthBreakdown(2_000_000).nudgeGrowthTokens, 50000, "cap binds above 1M");

  // In-band scaling: 5% of the window between 400k and 1M.
  assert.equal(growthBreakdown(600_000).nudgeGrowthTokens, 30000, "600k window scales to 5% = 30k");

  // The #2110 window: 272k native (204k effective budget line) previously
  // waited a flat 50k; now the floor binds at 20k.
  assert.equal(growthBreakdown(272_000).nudgeGrowthTokens, 20000, "272k window (the issue) gets the 20k floor");
  assert.equal(growthBreakdown(204_000).nudgeGrowthTokens, 20000, "204k window gets the 20k floor");
  assert.equal(growthBreakdown(400_000).nudgeGrowthTokens, 20000, "400k window is exactly at the floor crossover");
});

test("#2110: the anti-thrash gate follows the scaled step", () => {
  // gate2 = max(minGrowthFloor=20000, minGrowthRatio 0.45 × step): the small-window
  // floor is exactly minGrowthFloor; the 1M step keeps the legacy 22500.
  assert.equal(growthBreakdown(272_000).growthFloor, 20000, "272k: max(20000, 0.45 × 20000) = 20000");
  assert.equal(growthBreakdown(1_000_000).growthFloor, 22500, "1M: max(20000, 0.45 × 50000) = 22500 (unchanged)");
});

test("#2110: nudgeGrowthTokens-style flatten still pins a flat step", () => {
  // compress.nudgeGrowthTokens sets growthFloor = growthCap (the documented
  // escape hatch, verified live in issue #2110 with 25000). At every window.
  for (const limit of [204_000, 272_000, 600_000, 1_000_000]) {
    assert.equal(
      growthBreakdown(limit, { growthFloor: 25000, growthCap: 25000 }).nudgeGrowthTokens,
      25000,
      `limit=${limit}: flattened band pins the step`,
    );
  }
});
