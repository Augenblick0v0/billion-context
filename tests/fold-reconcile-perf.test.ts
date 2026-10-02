import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

// #1930-2: #1921's acceptance criteria promised near-linear reconcile cost on
// an 8K-message / ~40MB synthetic history. These pins keep it there:
//   - a cold round must scale ~linearly with message count (a quadratic
//     regression shows up as a ~64x ratio at 8x scale), and
//   - a steady-state resend round (all ids unchanged) must be far cheaper than
//     the cold round — the anchor-reuse path reuses stored anchors instead of
//     re-normalizing + re-hashing every message.
const FILLER = "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ";

function makeHistory(n: number): CoreMessage[] {
    const body = FILLER.repeat(8); // ~4.5KB per message -> ~40MB at 8K
    return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: "user", contentType: "text", text: `${i}: ${body}` }) as CoreMessage);
}

function coveredSession(msgs: CoreMessage[]): Session {
    return {
        state: { blocks: [{ active: true, effectiveMessageIds: msgs.map((m) => m.id!) }] },
        metadata: {},
    } as unknown as Session;
}

function ms(fn: () => void): number {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe("reconcileFoldCoverage near-linear performance (#1930-2)", () => {
    const opts = { mode: "repair" as const, sessionId: "perf", log: () => {} };

    test("cold rounds scale near-linearly to 8K messages / ~40MB", () => {
        // warmup: JIT + allocator steady state before measuring
        const warmup = makeHistory(1_000);
        ms(() => reconcileFoldCoverage(coveredSession(warmup), warmup, opts));

        const small = makeHistory(1_000);
        const t1k = ms(() => reconcileFoldCoverage(coveredSession(small), small, opts));

        const big = makeHistory(8_000);
        const t8k = ms(() => reconcileFoldCoverage(coveredSession(big), big, opts));

        assert.ok(t1k > 0 && t8k > 0);
        // 8x the messages must not give ~64x the work: near-linear with CI-variance headroom.
        assert.ok(t8k / t1k < 12, `8K/1K cold-round ratio ${t8k / t1k} is super-linear (t1k=${t1k.toFixed(1)}ms t8k=${t8k.toFixed(1)}ms)`);
        // Absolute sanity net (current implementation is well under a second).
        assert.ok(t8k < 10_000, `8K cold round took ${t8k.toFixed(1)}ms`);
    });

    test("steady-state resend round is far cheaper than the cold round (anchor reuse)", () => {
        const big = makeHistory(8_000);
        const session = coveredSession(big);
        const cold = ms(() => reconcileFoldCoverage(session, big, opts));
        // Same ids resent: unchanged id => unchanged bytes => stored anchor still valid.
        const warm = ms(() => reconcileFoldCoverage(session, big, opts));
        assert.ok(warm < cold / 2, `warm ${warm.toFixed(1)}ms not far below cold ${cold.toFixed(1)}ms — anchor reuse path regressed`);
    });
});
