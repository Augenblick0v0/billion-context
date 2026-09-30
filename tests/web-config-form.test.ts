import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { ENV_OVERRIDES, envForcedMap, isEnvForcedPath } from "../src/web/api.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

interface CfgEnvSaver { saved: Record<string, string | undefined>; }

function clearOverrideEnv(): CfgEnvSaver {
    const saver: CfgEnvSaver = { saved: {} };
    for (const { vars } of ENV_OVERRIDES) {
        for (const v of vars) {
            if (!(v in process.env)) continue;
            saver.saved[v] = process.env[v];
            delete process.env[v];
        }
    }
    return saver;
}

function restoreEnv(saver: CfgEnvSaver): void {
    for (const [k, v] of Object.entries(saver.saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-web-cfgform-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const opts: ProxyOptions = {
        port: await freePort(),
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    try {
        await fn(`http://127.0.0.1:${opts.port}`);
    } finally {
        await close(proxy);
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmSync(root, { recursive: true, force: true });
    }
}

test("#1748: GET /__bili/config reports env-forced fields", async () => {
    const saver = clearOverrideEnv();
    try {
        process.env.ACP_DEBUG = "1";
        process.env.BILI_ADVISORY_CHECK = "0";
        await withServer(async (base) => {
            const body = JSON.parse(await (await fetch(`${base}/__bili/config`)).text());
            assert.deepEqual(body.envForced, {
                debug: ["ACP_DEBUG"],
                advisoryCheck: ["BILI_ADVISORY_CHECK"],
            });
        });
    } finally {
        restoreEnv(saver);
    }
});

test("#1748: file PUT preserves unmodeled top-level keys byte-for-byte", async () => {
    await withServer(async (base) => {
        const doc = {
            providers: { "https://a.example/v1": { models: { m: { context: 1_000 } } } },
            promptPack: { name: "lean" },
            debug: false,
        };
        const res = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file: JSON.stringify({ ...doc, debug: true }) }),
        });
        assert.equal(res.status, 200);
        const onDisk = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8"));
        // The whole-file contract the form relies on: unknown keys survive the round-trip.
        assert.deepEqual(onDisk.promptPack, { name: "lean" });
        assert.equal(onDisk.debug, true);
        assert.deepEqual(onDisk.providers["https://a.example/v1"], { models: { m: { context: 1_000 } } });
    });
});

test("#1748: embedded client ships the detailed form wiring", () => {
    for (const needle of [
        "cfg-form-host",
        "save-config-form",
        "envForced",
        "cf_r_",
        "route-new-key",
        "toast.unsaved_refreshed",
        "buildCfgSchema",
        "collectValue",
    ]) {
        assert.match(WEB_CLIENT, new RegExp(needle));
    }
});

test("#1748: default-on bool fields are marked def so off writes explicit false", () => {
    // Fields whose config default is ON (absent key = on): the switch renders
    // checked for an absent key and turning it off saves `false`. Deleting the
    // key instead would silently keep the feature on (un-disableable via UI).
    const defaultOn = [
        '["log"], k: "bool", def: true',
        '["compress", "injectTool"], k: "bool", def: true',
        '["compress", "injectNudge"], k: "bool", def: true',
        '["compress", "tiers"], k: "bool", def: true',
        '["compress", "visibilityMarkers"], k: "bool", def: true',
        '["autoUpdate"], k: "bool", def: true',
        '["advisoryCheck"], k: "bool", def: true',
        '["maskHosts"], k: "bool", def: true',
        '["subagentSplit"], k: "bool", def: true',
        '["resumeInheritance"], k: "bool", def: true',
        '["chainContentDetection"], k: "bool", def: true',
        '["mitm", "enabled"], k: "bool", def: true',
    ];
    for (const needle of defaultOn) assert.ok(WEB_CLIENT.includes(needle), needle);
    // Default-off fields must NOT carry def: an absent key already means off,
    // and marking them would render the switch checked for a feature that is off.
    const defaultOff = [
        '["debug"], k: "bool", tip:',
        '["autoRestartOnUpdate"], k: "bool", tip:',
        '["passthrough"], k: "bool", tip:',
        '["forkAdoption"], k: "bool", tip:',
        '["stableSystemAnchor"], k: "bool", tip:',
        '["compress", "stripImages"], k: "bool", tip:',
        '["compress", "rules"], k: "bool", tip:',
        '["compress", "acknowledgePromptsRisk"], k: "bool", tip:',
        '["native", "attachExternal"], k: "bool", tip:',
        '{ f: "passthrough", k: "bool", tip:',
        '{ f: "direct", k: "bool", tip:',
    ];
    for (const needle of defaultOff) assert.ok(WEB_CLIENT.includes(needle), needle);
    assert.ok(WEB_CLIENT.includes("value === undefined ? Boolean(f.def) : value === true"));
    assert.ok(WEB_CLIENT.includes("if (!on && !f.def) return { del: true };"));
});

test("#1748: route control ids are key-stable, never index-based", () => {
    assert.ok(WEB_CLIENT.includes('function routeCtrlId(key, f) { return "cf_r_" + encodeURIComponent(key) + "_" + f; }'));
    assert.equal((WEB_CLIENT.match(/routeCtrlId\(key, f\.f\)/g) || []).length, 2);
    // Index-based ids shift unsaved edits to the wrong provider row whenever
    // addRoute/removeRoute re-sort or splice routeKeys before re-rendering.
    assert.doesNotMatch(WEB_CLIENT, /"cf_r_"\s*\+\s*i\s*\+/);
});

test("#1748: isEnvForcedPath is an exact-path lookup; BILI_IMAGE_BILLING reports imageBilling", () => {
    const map = envForcedMap({ BILI_IMAGE_BILLING: "anthropic", ACP_DEBUG: "1" } as NodeJS.ProcessEnv);
    assert.equal(isEnvForcedPath("debug", map), true);
    assert.equal(isEnvForcedPath("imageBilling", map), true);
    assert.equal(isEnvForcedPath("passthrough", map), false);
    // Provider keys may contain dots, so per-route paths never match a pattern.
    assert.equal(isEnvForcedPath("providers.x.example.imageBilling", map), false);
    assert.deepEqual(envForcedMap({} as NodeJS.ProcessEnv), {});
});
