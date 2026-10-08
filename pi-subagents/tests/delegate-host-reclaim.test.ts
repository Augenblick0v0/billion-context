import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeDelegateTool,
  scheduleRunNotification,
  flushDelegateNotifications,
  knownDelegateHostCount,
} from "../src/delegate-tool.js";

type PiLike = Parameters<typeof makeDelegateTool>[0];

function mkRun(runId: string, status: "completed" | "failed", over: Record<string, unknown> = {}): any {
  return {
    runId,
    agent: "reviewer",
    task: "review X",
    cwd: "/tmp",
    startedAt: 0,
    finishedAt: 1000,
    status,
    result: { code: 1, file: `/tmp/${runId}.out`, body: "boom" },
    ...over,
  };
}

/** Mock ExtensionAPI: captures sends and can emit host lifecycle events so the
 *  settle-gated commit path can be driven deterministically (same harness as
 *  delegate-settle-notify.test.ts). */
function mockPi() {
  const sent: string[] = [];
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const pi = {
    sendUserMessage: (t: string) => void sent.push(t),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as PiLike;
  const emit = (event: string) => {
    for (const h of handlers.get(event) ?? []) h({});
  };
  return { pi, sent, emit };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── #2390: per-host notification registry must not retain retired hosts ─────
// knownHosts is a strong-ref Set (a target-less flush enumerates it, and JS has
// no iterable weak collection, so strong refs are unavoidable) but it now PRUNES
// a host once it goes idle (no in-flight runs, empty coalescing queue, no pending
// flush) and re-adds it on every subsequent state access. A host's notification
// STATE object is never deleted — only its enumeration entry — so a handler that
// captured the state can never desync. These tests pin the boundedness guarantee
// deterministically (no --expose-gc needed) plus the isolation/enumeration
// behavior the pruning must not regress.

test("idle hosts are reclaimed from the enumeration registry (#2390)", async () => {
  const before = knownDelegateHostCount();
  const N = 5;
  const hosts: ReturnType<typeof mockPi>[] = [];
  for (let i = 0; i < N; i++) {
    const m = mockPi();
    makeDelegateTool(m.pi);
    hosts.push(m);
  }
  assert.equal(knownDelegateHostCount(), before + N, "all N fresh hosts registered");

  // Drive every host through a start/settle cycle with no queued work: each
  // settle arms an idle-flush macrotask whose callback prunes the host once it
  // is fully idle. (The inline settle-time prune is intentionally deferred to
  // that macrotask because maybeFlush sets flushScheduled synchronously.)
  for (const m of hosts) {
    m.emit("agent_start");
    m.emit("agent_settled");
  }
  await sleep(30);
  assert.equal(
    knownDelegateHostCount(),
    before,
    "idle hosts reclaimed from the registry; count returns to baseline (#2390)",
  );
});

test("re-added host rejoins enumeration after being pruned", async () => {
  const m = mockPi();
  makeDelegateTool(m.pi);
  const base = knownDelegateHostCount();
  assert.ok(base >= 1, "host registered");

  // Idle cycle → pruned on the post-flush macrotask.
  m.emit("agent_start");
  m.emit("agent_settled");
  await sleep(30);
  assert.equal(knownDelegateHostCount(), base - 1, "host pruned while idle");

  // Touching the host again (via a queued run) must re-register it, otherwise a
  // later target-less flush would miss its pending delivery.
  m.emit("agent_start");
  scheduleRunNotification(m.pi, mkRun("rejoin_after_prune", "completed"));
  assert.equal(knownDelegateHostCount(), base, "host rejoined enumeration on access");

  m.emit("agent_settled");
  await sleep(30);
  assert.equal(m.sent.length, 1, "rejoined host still delivered its notification");
  assert.equal(knownDelegateHostCount(), base - 1, "pruned again after delivering");
});

test("per-host isolation: other/retired hosts do not cross-deliver", async () => {
  const a = mockPi();
  const b = mockPi();
  makeDelegateTool(a.pi);
  makeDelegateTool(b.pi);

  a.emit("agent_start");
  scheduleRunNotification(a.pi, mkRun("reclaim_iso_a", "completed"));
  a.emit("agent_settled");
  await sleep(30);
  assert.equal(a.sent.length, 1, "host A delivered its own notification");
  assert.equal(b.sent.length, 0, "host B unaffected by A's notification");

  b.emit("agent_start");
  scheduleRunNotification(b.pi, mkRun("reclaim_iso_b", "completed"));
  b.emit("agent_settled");
  await sleep(30);
  assert.equal(b.sent.length, 1, "host B delivered its own notification");
  assert.equal(a.sent.length, 1, "no cross-delivery into A after B settles");
});

test("target-less flush enumerates every live host", () => {
  const a = mockPi();
  const b = mockPi();
  makeDelegateTool(a.pi);
  makeDelegateTool(b.pi);

  // agent_start first keeps each run queued (busy tier) instead of idle-flushing.
  a.emit("agent_start");
  scheduleRunNotification(a.pi, mkRun("reclaim_flush_a", "completed"));
  b.emit("agent_start");
  scheduleRunNotification(b.pi, mkRun("reclaim_flush_b", "completed"));
  flushDelegateNotifications();
  assert.equal(a.sent.length, 1, "host A flushed");
  assert.equal(b.sent.length, 1, "host B flushed");
});
