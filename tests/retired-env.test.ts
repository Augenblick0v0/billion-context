// #1714: boot-time scan for retired behavior-class env vars must surface a
// stale export instead of letting it die quietly (the #1706 failure mode).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scanRetiredEnv, _resetRetiredEnvScanForTest } from "../src/retired-env.ts";
import { setLogCapture } from "../src/logger.ts";

function withCapture(fn: () => void): Array<{ level: string; msg: string }> {
    const out: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => { out.push({ level, msg }); });
    try {
        fn();
    } finally {
        setLogCapture(null);
    }
    return out;
}

test("clean env produces no warn", () => {
    _resetRetiredEnvScanForTest();
    const out = withCapture(() => scanRetiredEnv({ ACP_PORT: "8787", BILI_CONFIG_FILE: "/x.json" }));
    assert.equal(out.filter((l) => l.level === "warn").length, 0);
});

test("stale exports are listed once with their config.json hints", () => {
    _resetRetiredEnvScanForTest();
    const out = withCapture(() => scanRetiredEnv({
        ACP_DEBUG: "1",
        ACP_PASSTHROUGH: "1",
        BILI_MITM_DOMAINS: "api.example.com",
    }));
    const warns = out.filter((l) => l.level === "warn");
    assert.equal(warns.length, 1, "exactly one warn per process");
    const msg = warns[0].msg;
    assert.match(msg, /3 retired environment variable\(s\)/);
    assert.match(msg, /ACP_DEBUG → config\.json debug/);
    assert.match(msg, /ACP_PASSTHROUGH → config\.json passthrough/);
    assert.match(msg, /BILI_MITM_DOMAINS → config\.json mitm\.domains/);
    assert.match(msg, /#1714/);
});

test("the scan fires only once per process", () => {
    _resetRetiredEnvScanForTest();
    const env = { BILI_PERSIST: "0" };
    const first = withCapture(() => scanRetiredEnv(env));
    const second = withCapture(() => scanRetiredEnv(env));
    assert.equal(first.filter((l) => l.level === "warn").length, 1);
    assert.equal(second.length, 0, "second call in the same process is silent");
});

test("_resetRetiredEnvScanForTest re-arms the one-shot", () => {
    _resetRetiredEnvScanForTest();
    withCapture(() => scanRetiredEnv({ BILI_PERSIST: "0" }));
    const again = withCapture(() => {
        _resetRetiredEnvScanForTest();
        scanRetiredEnv({ BILI_PERSIST: "0" });
    });
    assert.equal(again.filter((l) => l.level === "warn").length, 1);
});

test("every retired name is a valid env identifier and unique", () => {
    // The map lives in src; this pins its shape so a typo'd key (truncated
    // name, lowercase) cannot silently widen or narrow the warning surface.
    const src = fs.readFileSync(new URL("../src/retired-env.ts", import.meta.url), "utf8");
    const names = [...src.matchAll(/^\s{4}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    assert.ok(names.length >= 60, `map should hold the full inventory, got ${names.length}`);
    assert.equal(new Set(names).size, names.length, "duplicate keys in RETIRED_ENV");
});
