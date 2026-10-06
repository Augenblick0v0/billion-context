import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import { parseExternalSummarySettings } from "../src/external-summary-settings.ts";
import { configuredSummarySettings } from "../src/external-summary-config.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { parseCompressSettings, parseRouteEntry } from "../src/config.ts";
import { handleConfigGet, handleConfigPut, handleSummaryCredentialPut } from "../src/web/api.ts";
import { rmrf } from "./tmp-rm.ts";

const target = {
    name: "primary", protocol: "responses", url: "https://example.com/v1/responses",
    model: "summary-model", credentialRef: "secret:primary",
};
const roots: string[] = [];
function root(): string {
    const path = mkdtempSync(join(tmpdir(), "bili-summary-settings-"));
    roots.push(path);
    return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmrf(path); });

test("external summary defaults off and produces a bounded global plan", () => {
    const off = parseExternalSummarySettings({});
    assert.equal(off.enabled, false);
    assert.deepEqual(off.targets, []);
    const plan = parseExternalSummarySettings({ enabled: true, targets: [target] });
    assert.equal(plan.targets[0].outputTokens, 8192);
    assert.equal(plan.targets[0].contextWindow, 128_000);
    assert.deepEqual(plan.budget, { totalTimeoutMs: 50_000, targetTimeoutMs: 25_000, maxSummaryBytes: 65536 });
    assert.deepEqual(parseCompressSettings({ externalSummary: plan })?.externalSummary, plan);
});

test("small context and total budgets clamp defaults without changing explicit limits", () => {
    const plan = parseExternalSummarySettings({ targets: [{ ...target, contextWindow: 2048 }], budget: { totalTimeoutMs: 500 } });
    assert.equal(plan.targets[0].outputTokens, 512);
    assert.equal(plan.budget.targetTimeoutMs, 500);
});

test("configured summary settings cache successful reads by path, mtime and size only", () => {
    const path = join(root(), "config.json");
    const previous = process.env.BILI_CONFIG_FILE;
    const first = { compress: { externalSummary: { enabled: true, targets: [target] } } };
    const second = { compress: { externalSummary: { enabled: true, targets: [{ ...target, name: "backup1", credentialRef: "secret:backup1" }] } } };
    const timestamp = new Date("2020-01-01T00:00:00.000Z");
    process.env.BILI_CONFIG_FILE = path;
    try {
        writeFileSync(path, JSON.stringify(first));
        utimesSync(path, timestamp, timestamp);
        assert.equal(configuredSummarySettings()?.targets[0]?.name, "primary");
        writeFileSync(path, JSON.stringify(second));
        utimesSync(path, timestamp, timestamp);
        assert.equal(configuredSummarySettings()?.targets[0]?.name, "primary");

        const invalidTimestamp = new Date("2020-01-01T00:00:01.000Z");
        writeFileSync(path, "{");
        utimesSync(path, invalidTimestamp, invalidTimestamp);
        assert.throws(() => configuredSummarySettings(), /configuration unavailable/);
        writeFileSync(path, JSON.stringify(second));
        utimesSync(path, invalidTimestamp, invalidTimestamp);
        assert.equal(configuredSummarySettings()?.targets[0]?.name, "backup1");
    } finally {
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
    }
});

for (const invalid of [
    { enabled: "true" }, { enabled: true }, { targets: {} }, { targets: [target, target] },
    { targets: [{ ...target, key: "do-not-echo" }] }, { apiKey: "do-not-echo" },
    { targets: [{ ...target, url: "https://user:private@example.com/v1/responses" }] },
    { targets: [{ ...target, url: "https://example.com/v1/responses?key=private" }] },
    { targets: [{ ...target, url: "http://remote.example/v1/responses" }] },
    { targets: [{ ...target, url: "https://example.com/bili/https://upstream.example/v1/responses" }] },
    { targets: [{ ...target, credentialRef: "secret:../escape" }] },
    { targets: [{ ...target, credentialRef: "env:KEY\nother" }] },
    { targets: [{ ...target, protocol: "unknown" }] },
    { targets: [{ ...target, contextWindow: 3000, outputTokens: 3000 }] },
    { targets: [{ ...target, stream: "true" }] },
    { budget: { totalTimeoutMs: 60_000 } }, { budget: { totalTimeoutMs: 100, targetTimeoutMs: 101 } },
    { budget: { concurrency: 1000 } },
]) {
    test(`invalid external summary plan is rejected: ${JSON.stringify(invalid)}`, () => {
        assert.throws(() => parseExternalSummarySettings(invalid));
        assert.equal(parseCompressSettings({ externalSummary: invalid }), undefined);
    });
}

test("external summary target registry cannot be overridden by provider or model", () => {
    const externalSummary = parseExternalSummarySettings({ targets: [target] });
    assert.throws(() => parseRouteEntry({ compress: { externalSummary } }), /global-only/);
    assert.throws(() => parseRouteEntry({ models: { model: { compress: { externalSummary } } } }), /global-only/);
    assert.doesNotThrow(() => parseRouteEntry({ compress: { tiers: false } }));
});

test("private store resolves, rotates and deletes keys without exposing arbitrary paths", () => {
    const path = join(root(), "keys.json");
    const store = new SummaryCredentialStore(path);
    assert.equal(store.configured("secret:primary"), false);
    store.set("primary", "test-first-key");
    store.set("backup", "test-backup-key");
    assert.equal(store.resolve("secret:primary"), "test-first-key");
    store.set("primary", "test-rotated-key");
    assert.equal(store.resolve("secret:backup"), "test-backup-key");
    store.set("primary", null);
    assert.equal(store.resolve("secret:primary"), undefined);
    assert.equal(readFileSync(path, "utf8").includes("test-first-key"), false);
    if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.throws(() => store.set("../escape", "test-key"));
    assert.throws(() => store.set("primary", "test-key\nInjected-Header"));
    assert.throws(() => store.resolve("file:/etc/passwd"));
});

test("environment references are read-only and do not inherit another provider key", () => {
    const store = new SummaryCredentialStore(join(root(), "absent.json"));
    assert.equal(store.resolve("env:SUMMARY_KEY", { SUMMARY_KEY: "test-env-key", OPENAI_API_KEY: "wrong" }), "test-env-key");
    assert.equal(store.resolve("env:SUMMARY_KEY", { OPENAI_API_KEY: "wrong" }), undefined);
    assert.throws(() => store.resolve("env:SUMMARY_KEY", { SUMMARY_KEY: "bad\nkey" }));
});

test("corrupt private store fails closed and is not overwritten", () => {
    const path = join(root(), "keys.json");
    writeFileSync(path, "corrupt-private-value", { mode: 0o600 });
    const store = new SummaryCredentialStore(path);
    assert.throws(() => store.set("primary", "replacement"), /credentials unavailable/);
    assert.equal(store.configured("secret:primary"), false);
    assert.equal(readFileSync(path, "utf8"), "corrupt-private-value");
});

test("world-readable private store is refused", { skip: process.platform === "win32" }, () => {
    const path = join(root(), "keys.json");
    const store = new SummaryCredentialStore(path);
    store.set("primary", "test-private-key");
    chmodSync(path, 0o644);
    assert.throws(() => store.resolve("secret:primary"), /permissions/);
});

test("another writer's credential lock refuses the update without deleting its lock", () => {
    const path = join(root(), "keys.json");
    const store = new SummaryCredentialStore(path);
    store.set("primary", "test-original");
    writeFileSync(`${path}.lock`, "other-writer", { mode: 0o600 });
    assert.throws(() => store.set("primary", "test-replacement"), /locked/);
    assert.equal(store.resolve("secret:primary"), "test-original");
    assert.equal(readFileSync(`${path}.lock`, "utf8"), "other-writer");
});

test("config/credential API never echoes keys, and raw config saves validate summary settings", async () => {
    const path = join(root(), "config.json");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = path;
    writeFileSync(path, JSON.stringify({ compress: { externalSummary: { enabled: false, targets: [target] } }, retained: true }));
    const server = http.createServer((req, res) => {
        const handler = req.method === "GET" ? handleConfigGet(res)
            : req.url === "/credential" ? handleSummaryCredentialPut(req, res) : handleConfigPut(req, res);
        void handler.catch(() => { res.writeHead(500); res.end("test handler failed"); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const key = "test-never-public-key";
    try {
        const saved = await fetch(`${base}/credential`, { method: "PUT", body: JSON.stringify({ name: "primary", key }) });
        assert.equal(saved.status, 200);
        assert.equal((await saved.text()).includes(key), false);
        let response = await fetch(base);
        const body = await response.text();
        assert.equal(body.includes(key), false);
        assert.equal(JSON.parse(body).externalSummaryCredentials["secret:primary"], true);
        assert.equal(readFileSync(path, "utf8").includes(key), false);
        response = await fetch(base, { method: "PUT", body: JSON.stringify({ file: JSON.stringify({ compress: { externalSummary: { ...target, key } } }) }) });
        assert.equal(response.status, 400);
        assert.equal((await response.text()).includes(key), false);
        assert.equal(JSON.parse(readFileSync(path, "utf8")).retained, true);
        writeFileSync(path, JSON.stringify({ compress: { externalSummary: { enabled: true, key } } }));
        assert.equal((await (await fetch(base)).text()).includes(key), false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
    }
});
