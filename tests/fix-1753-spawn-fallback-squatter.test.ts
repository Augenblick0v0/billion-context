import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { ensureProxyRunning, type HealthInfo, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

// #1753: the spawn-wait pre-handshake fallback trusted ANY healthy response on
// the preferred port. Field repro: an older build squatting the lane-sticky
// port (exactly why our child laddered off it) answered health, and the wrapper
// exported the client to THAT origin — silently bypassing the #1225 fingerprint
// gate that had just refused the same instance in the attach path. Fix:
// /__bili/health carries the responder's pid; only child.pid proves ownership
// of the preferred port. Everything else waits for the launchToken handshake
// record on the child's real port.

const prevXdgState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1753-state-"));
after(() => {
    const dir = process.env.XDG_STATE_HOME;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdgState;
});

function makeFakeChild(pid: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
        },
    };
}

function makeClock(intervalMs = 200): { now: () => number; sleep: () => Promise<void>; ticks: () => number } {
    let t = 1_000_000;
    let n = 0;
    return {
        now: () => t,
        sleep: async () => { t += intervalMs; n++; },
        ticks: () => n,
    };
}

const DEAD_PID = 4_000_000;

function staleRecord(): ProxyInstanceFile {
    return {
        origin: "http://127.0.0.1:19999",
        instanceId: "inst-stale",
        pid: DEAD_PID,
        startedAt: Date.now() - 86_400_000,
        host: "127.0.0.1",
        port: 19999,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
    };
}

function handshakeRecord(launchToken: string, now: () => number): ProxyInstanceFile {
    return {
        origin: "http://127.0.0.1:18790",
        instanceId: "inst-child",
        pid: 42421,
        startedAt: now(),
        host: "127.0.0.1",
        port: 18790,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        launchToken,
    };
}

const CHILD_PID = 42421;
const SQUATTER_PID = 875250;
const PREFERRED = "http://127.0.0.1:18787";

test("fallback: healthy foreign squatter on the preferred port is NOT trusted — waits out the ladder and exports the child's real port (#1753)", async () => {
    const clock = makeClock();
    const diags: string[] = [];
    let launchToken = "";
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        launchToken = String(options.env?.BILI_LAUNCH_TOKEN ?? "");
        return makeFakeChild(CHILD_PID);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 18787, passthrough: false, debug: false },
        {
            spawnImpl,
            now: clock.now,
            sleep: clock.sleep,
            // The dead-pid record lingers (previous ephemeral spawn exited) until
            // our child writes its own handshake record ~5 ticks later — the
            // incident's exact sequence.
            readInstanceFile: () =>
                clock.ticks() >= 5 && launchToken ? handshakeRecord(launchToken, clock.now) : staleRecord(),
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) =>
                origin === PREFERRED ? { ok: true, pid: SQUATTER_PID } : undefined,
            attachDiag: (msg) => diags.push(msg),
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:18790", "must export the child's laddered port, not the squatter's");
    assert.equal(handle.port, 18790);
    assert.ok(clock.ticks() >= 5, "the first-tick squatter health must NOT settle the wait");
    const squatterLines = diags.filter((d) => d.includes("foreign instance"));
    assert.equal(squatterLines.length, 1, "squatter announced exactly once");
    assert.ok(squatterLines[0].includes(String(SQUATTER_PID)), "announce names the squatter pid");
});

test("fallback: healthy non-bili listener (no pid in health) on the preferred port is NOT trusted (#1753)", async () => {
    const clock = makeClock();
    const diags: string[] = [];
    let launchToken = "";
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        launchToken = String(options.env?.BILI_LAUNCH_TOKEN ?? "");
        return makeFakeChild(CHILD_PID);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 18787, passthrough: false, debug: false },
        {
            spawnImpl,
            now: clock.now,
            sleep: clock.sleep,
            // no-record stale variant (undefined instead of a dead-pid record)
            readInstanceFile: () =>
                clock.ticks() >= 5 && launchToken ? handshakeRecord(launchToken, clock.now) : undefined,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) =>
                origin === PREFERRED ? { ok: true } : undefined,
            attachDiag: (msg) => diags.push(msg),
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:18790");
    assert.equal(handle.port, 18790);
    const squatterLines = diags.filter((d) => d.includes("foreign instance"));
    assert.equal(squatterLines.length, 1);
    assert.ok(squatterLines[0].includes("unknown"), "no pid to name — announced as unknown");
});

test("fallback: OUR child on the preferred port (health pid === child.pid) still settles immediately, no record needed (#1753)", async () => {
    const clock = makeClock();
    const settled: Array<[string, number]> = [];
    let launchTokenSeen = false;
    const spawnImpl: SpawnFn = () => {
        launchTokenSeen = true;
        return makeFakeChild(CHILD_PID);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 0, lane: "pi", passthrough: false, debug: false },
        {
            spawnImpl,
            now: clock.now,
            sleep: clock.sleep,
            // broken state dir: the child can never write its handshake record —
            // only the identity-verified fallback can settle this bring-up.
            readInstanceFile: () => staleRecord(),
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) =>
                origin === PREFERRED ? { ok: true, pid: CHILD_PID } : undefined,
            zonePreferredPort: () => 18787,
            writeZonePort: (lane, p) => settled.push([lane, p]),
        },
    );
    assert.ok(launchTokenSeen, "a child was spawned");
    assert.equal(handle.origin, PREFERRED);
    assert.equal(handle.port, 18787);
    assert.equal(clock.ticks(), 1, "pid match settles on the first poll tick");
    assert.deepEqual(settled, [["pi", 18787]], "lane sticky settled to the verified port");
});
