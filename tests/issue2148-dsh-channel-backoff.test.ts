// #2148 (from #2146 field repro): a dsh host whose CLI cannot even start
// (MODULE_NOT_FOUND out of app.asar) made refreshDshProfileBundles re-spawn and
// re-fail every 3-min cycle forever — frozen profile copy, log-only warning,
// and a "manual fix" that told users to run the same broken command. This file
// pins: per-(profile,targetVersion) backoff (#1603 shape), repair wording for a
// broken host CLI, and the user-visible surfaces (dshChannelFailures → status /
// /acp panel / web banner).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createCore, defaultConfig } from "acp-kernel";
import {
    _resetDshRefreshBackoffForTest,
    _setDshRunnersForTest,
    dshChannelFailures,
    dshHostCliBroken,
    dshRefreshBackoffMs,
    refreshDshProfileBundles,
    type DshPlan,
} from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { handlePluginStatus } from "../src/plugin.ts";
import { PANEL_BOX_FOOTER } from "../src/acp-panel.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";

type Manifest = { name?: string; dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };

function makeHome(entries: Record<string, Manifest | undefined>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2148-"));
    for (const [name, manifest] of Object.entries(entries)) {
        fs.mkdirSync(path.join(home, "profiles", name), { recursive: true });
        if (manifest) fs.writeFileSync(path.join(home, "profiles", name, "package.json"), JSON.stringify(manifest));
    }
    return home;
}

/** Records every attempted spawn (successful ones in `calls`, failed ones in
 *  `opts.failCalls` when provided); profiles in `failNames` throw before any
 *  effect. Platform-neutral argv unpacking mirrors tests/dsh-refresh.test.ts. */
function recordingAsyncRunner(calls: string[], opts?: { failNames?: Set<string>; failErr?: () => Error; failCalls?: string[] }): (plan: DshPlan) => Promise<{ stdout: string; stderr: string }> {
    return async (plan) => {
        const base = path.basename(plan.command).toLowerCase();
        const tokens = base === "cmd.exe" || base === "cmd"
            ? (plan.args[3] ?? "").replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0).slice(1)
            : [...plan.args];
        const name = tokens[tokens.indexOf("--profile") + 1];
        if (opts?.failNames?.has(name)) {
            opts.failCalls?.push(tokens.join(" "));
            throw opts.failErr ? opts.failErr() : Object.assign(new Error("spawn failed"), { status: 1, stderr: "boom" });
        }
        calls.push(tokens.join(" "));
        return { stdout: "", stderr: "" };
    };
}

const REG_HOME = (): Record<string, Manifest> => ({ a: { dependencies: { "billion-context": "^0.1.119" } } });

/** Deterministic clock: returns a setter for fake-now (ms) and a restore fn. */
function fakeClock(): { setNow: (ms: number) => void; restore: () => void } {
    const realNow = Date.now.bind(Date);
    let nowMs = realNow();
    Date.now = () => nowMs;
    return {
        setNow: (ms: number): void => { nowMs = ms; },
        restore: (): void => { Date.now = realNow; },
    };
}

test("#2148: dshRefreshBackoffMs matches the #1603 shape — base 5m at threshold 3, doubling, 6h cap", () => {
    assert.equal(dshRefreshBackoffMs(3), 5 * 60_000);
    assert.equal(dshRefreshBackoffMs(4), 10 * 60_000);
    assert.equal(dshRefreshBackoffMs(5), 20 * 60_000);
    assert.equal(dshRefreshBackoffMs(999), 6 * 60 * 60_000);
});

test("#2148: dshHostCliBroken recognizes the broken-host signatures only", () => {
    assert.ok(dshHostCliBroken("Error: Cannot find module 'G:\\x\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'\n    code: 'MODULE_NOT_FOUND'"));
    assert.ok(dshHostCliBroken("MODULE_NOT_FOUND"));
    assert.ok(!dshHostCliBroken("pnpm not found on PATH"));
    assert.ok(!dshHostCliBroken("boom"));
    assert.ok(!dshHostCliBroken(""));
});

test("#2148: backoff — retries until threshold, cools down silently, resumes after cooldown with raised wait", async () => {
    const home = makeHome(REG_HOME());
    const calls: string[] = [];
    const fails: string[] = [];
    const logs: string[] = [];
    const log = (level: string, msg: string): void => { logs.push(`${level}: ${msg}`); };
    const clk = fakeClock();
    try {
        _resetDshRefreshBackoffForTest();
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]), failCalls: fails }) });
        const env = { ...process.env, DSH_HOME: home };

        await refreshDshProfileBundles("0.1.121", log, env); // failure 1
        await refreshDshProfileBundles("0.1.121", log, env); // failure 2
        assert.equal(fails.length, 2, "each pre-threshold cycle still retries");
        const w1 = logs.find((l) => l.startsWith("warn"));
        assert.ok(w1, "first failure still warns");
        assert.ok(w1.endsWith(`dsh plugin --profile a add billion-context@0.1.121 failed: boom — manual fix: run \`dsh plugin --profile a add billion-context@0.1.121\` from a shell where \`dsh\` resolves (or point BILI_DSH_BIN at dsh's executable)`), w1);

        await refreshDshProfileBundles("0.1.121", log, env); // failure 3 → threshold
        assert.equal(fails.length, 3);
        const w3 = logs.at(-1);
        assert.ok(w3?.includes("keeps failing (3× in a row): dsh plugin --profile a add billion-context@0.1.121 failed: boom."), w3);
        assert.ok(w3?.includes("Backing off — next attempt in ~5m."), w3);

        const t3 = Date.now();
        clk.setNow(t3 + 4 * 60_000); // inside the 5m cooldown
        const warnsBefore = logs.length;
        await refreshDshProfileBundles("0.1.121", log, env);
        assert.equal(fails.length, 3, "no doomed spawn while cooling down");
        assert.equal(logs.length, warnsBefore, "no repeated warn while cooling down");

        clk.setNow(t3 + 6 * 60_000); // past the cooldown
        await refreshDshProfileBundles("0.1.121", log, env); // failure 4
        assert.equal(fails.length, 4, "retries again after the cooldown");
        assert.ok(logs.at(-1)?.includes("Still failing — next attempt in ~10m."), logs.at(-1));

        const vis = dshChannelFailures();
        assert.deepEqual(vis.map((f) => f.profile), ["a"]);
        assert.equal(vis[0].attempts, 4);
        assert.equal(vis[0].lastError, "dsh plugin --profile a add billion-context@0.1.121 failed: boom");
    } finally {
        clk.restore();
        _setDshRunnersForTest(undefined);
        _resetDshRefreshBackoffForTest();
        rmrf(home);
    }
});

test("#2148: success resets the streak — transient failures never reach the visibility list", async () => {
    const home = makeHome(REG_HOME());
    const calls: string[] = [];
    const logs: string[] = [];
    const clk = fakeClock();
    try {
        _resetDshRefreshBackoffForTest();
        const env = { ...process.env, DSH_HOME: home };
        const log = (level: string, msg: string): void => { logs.push(`${level}: ${msg}`); };

        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]) }) });
        await refreshDshProfileBundles("0.1.121", log, env); // fail 1
        await refreshDshProfileBundles("0.1.121", log, env); // fail 2
        assert.equal(dshChannelFailures().length, 0, "below threshold → invisible");

        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) }); // host repaired
        await refreshDshProfileBundles("0.1.121", log, env); // success
        assert.equal(calls.length, 1);

        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]) }) });
        await refreshDshProfileBundles("0.1.122", log, env); // new target, fail 1
        assert.ok(logs.at(-1)?.endsWith(`failed: boom — manual fix: run \`dsh plugin --profile a add billion-context@0.1.122\` from a shell where \`dsh\` resolves (or point BILI_DSH_BIN at dsh's executable)`), logs.at(-1));
        assert.ok(!logs.at(-1)?.includes("keeps failing"), "streak was reset by the success");
        assert.deepEqual(dshChannelFailures(), []);
    } finally {
        clk.restore();
        _setDshRunnersForTest(undefined);
        _resetDshRefreshBackoffForTest();
        rmrf(home);
    }
});

test("#2148: a new target version prunes stale same-profile entries from the visibility list", async () => {
    const home = makeHome(REG_HOME());
    const calls: string[] = [];
    const clk = fakeClock();
    try {
        _resetDshRefreshBackoffForTest();
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]) }) });
        const env = { ...process.env, DSH_HOME: home };
        const log = (_l: string, _m: string): void => {};
        await refreshDshProfileBundles("0.1.121", log, env);
        await refreshDshProfileBundles("0.1.121", log, env);
        await refreshDshProfileBundles("0.1.121", log, env); // v1 in backoff
        assert.deepEqual(dshChannelFailures().map((f) => `${f.profile}@${f.targetVersion}`), ["a@0.1.121"]);

        // Registry moved on: the stale v1 entry is pruned and the new target
        // re-accumulates from zero (below threshold → invisible again).
        await refreshDshProfileBundles("0.1.122", log, env); // fail 1 on v2
        assert.deepEqual(dshChannelFailures(), [], "stale entry pruned; new target below threshold");

        await refreshDshProfileBundles("0.1.122", log, env); // fail 2 on v2
        await refreshDshProfileBundles("0.1.122", log, env); // fail 3 on v2 → resurfaces
        const fails = dshChannelFailures();
        assert.equal(fails.length, 1);
        assert.equal(fails[0].targetVersion, "0.1.122");
        assert.equal(fails[0].attempts, 3);
    } finally {
        clk.restore();
        _setDshRunnersForTest(undefined);
        _resetDshRefreshBackoffForTest();
        rmrf(home);
    }
});

test("#2148: broken host CLI gets repair wording — never 'run the same command'", async () => {
    const home = makeHome(REG_HOME());
    const calls: string[] = [];
    const logs: string[] = [];
    const clk = fakeClock();
    try {
        _resetDshRefreshBackoffForTest();
        const env = { ...process.env, DSH_HOME: home };
        const log = (level: string, msg: string): void => { logs.push(`${level}: ${msg}`); };
        const moduleNotFound = (): Error => Object.assign(new Error("spawn failed"), {
            status: 1,
            stderr: "Error: Cannot find module 'G:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'\n    code: 'MODULE_NOT_FOUND'",
        });

        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]), failErr: moduleNotFound }) });
        await refreshDshProfileBundles("0.1.184", log, env);
        const w = logs.find((l) => l.startsWith("warn"));
        assert.ok(w, "failure is still logged");
        assert.ok(w?.includes("host installation itself appears broken"), w);
        assert.ok(w?.includes("repair or reinstall the dsh host"), w);
        assert.ok(w?.includes("re-running that command cannot succeed"), w);
        assert.ok(!w?.includes("from a shell where"), `must not suggest re-running the broken command: ${w}`);

        // ENOENT (CLI missing entirely) takes the same repair wording
        logs.length = 0;
        const enoent = (): Error => Object.assign(new Error("spawn dsh ENOENT"), { code: "ENOENT" });
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]), failErr: enoent }) });
        await refreshDshProfileBundles("0.1.185", log, env);
        const w2 = logs.find((l) => l.startsWith("warn"));
        assert.ok(w2?.includes("CLI not found"), w2);
        assert.ok(w2?.includes("repair or reinstall the dsh host"), w2);
        assert.ok(!w2?.includes("from a shell where"), w2);
    } finally {
        clk.restore();
        _setDshRunnersForTest(undefined);
        _resetDshRefreshBackoffForTest();
        rmrf(home);
    }
});

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

async function driveToBackoff(targetVersion: string): Promise<void> {
    const home = makeHome(REG_HOME());
    const calls: string[] = [];
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, { failNames: new Set(["a"]) }) });
        const env = { ...process.env, DSH_HOME: home };
        const log = (_l: string, _m: string): void => {};
        for (let i = 0; i < 3; i++) await refreshDshProfileBundles(targetVersion, log, env);
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(home);
    }
}

test("#2148: /acp panel surfaces the failing dsh channel BEFORE the footer (stripper-safe), silent when clean", async () => {
    _resetSessionsForTest();
    _resetDshRefreshBackoffForTest();
    try {
        getSession("dsh2148-sess", { protocol: "anthropic", label: "DSH" });
        const deps = { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} };

        const r0 = mockRes();
        handlePluginStatus("never-seen", r0.res, deps, true);
        const p0 = JSON.parse(r0.body).panel as string | undefined;
        assert.ok(p0, "panel renders");
        assert.ok(!p0.includes("DSH UPDATE CHANNEL FAILING"), "no line when healthy");

        await driveToBackoff("0.1.184");
        const r1 = mockRes();
        handlePluginStatus("never-seen", r1.res, deps, true);
        const p1 = JSON.parse(r1.body).panel as string;
        assert.ok(p1.includes("⚠️ DSH UPDATE CHANNEL FAILING: a→0.1.184 (3×)"), p1);
        assert.ok(p1.indexOf("DSH UPDATE CHANNEL FAILING") < p1.indexOf(PANEL_BOX_FOOTER), "line sits BEFORE the footer so the stripper still matches");
    } finally {
        _resetDshRefreshBackoffForTest();
        _resetSessionsForTest();
    }
});

function makeAcpCtx(messages: CoreMessage[]): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session } {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "acp-status-2148",
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
        },
    };
}

test("#2148: acp_status report carries the failing dsh channel instance-level, silent when clean", async () => {
    _resetDshRefreshBackoffForTest();
    try {
        const clean = handleAcpStatus({}, makeAcpCtx([])).text;
        assert.ok(!clean.includes("DSH UPDATE CHANNEL FAILING"), "no line when healthy");

        await driveToBackoff("0.1.184");
        const report = handleAcpStatus({}, makeAcpCtx([])).text;
        assert.ok(report.includes("DSH UPDATE CHANNEL FAILING (instance-level): a→0.1.184 (3×)"), report.slice(-600));
        assert.ok(report.includes("Repair/reinstall the dsh host"), report.slice(-600));
        assert.ok(report.includes("__bili/status → dshChannel"), "points at the live-state endpoint");
    } finally {
        _resetDshRefreshBackoffForTest();
    }
});
