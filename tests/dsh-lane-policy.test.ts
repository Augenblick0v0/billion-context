import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { PANEL_BOX_FOOTER } from "../src/acp-panel.ts";

/** #2090 follow-up — the never-compressed lane registry. These tests pin:
 *  - the scan walks ~/.dsh/profiles/<profile>/node_modules and matches by
 *    package.json name (unknown/unreadable trees are inert, never fatal);
 *  - version-aware guidance: pre-1.4.5 says REFUSED + upgrade, >=1.4.5 says
 *    bypasses-by-design;
 *  - the TTL cache serves repeats and `maxAgeMs: 0` forces a fresh walk;
 *  - dshLanePolicyLines dedups per (package, version) with the profile list.
 *  The registry is module state, so each scenario runs in a child node
 *  process against a fixture DSH_HOME (same pattern as the module-eval
 *  guard tests: fresh module graph per case). */

function fixtureHome(): string {
    const home = mkdtempSync(path.join(os.tmpdir(), "lane-policy-"));
    return home;
}

function installPlugin(home: string, profile: string, name: string, version: string): void {
    const dir = path.join(home, "profiles", profile, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

function run(script: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
            env: { ...env, NODE_OPTIONS: "" },
            stdio: ["ignore", "pipe", "pipe"],
            cwd: path.resolve(new URL("..", import.meta.url).pathname),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => { stdout += c; });
        child.stderr.on("data", (c) => { stderr += c; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, code }));
    });
}

const IMPORT = `import { scanDshLanePolicies, dshLanePolicyLines, DSH_LANE_POLICIES } from ${JSON.stringify(new URL("../src/dsh-lane-policy.ts", import.meta.url).href)};`;

test("scan finds installs across profiles with version-aware guidance", async () => {
    const home = fixtureHome();
    try {
        installPlugin(home, "desktop", "dsh-our-free-model", "1.4.4");
        installPlugin(home, "cli", "dsh-our-free-model", "1.4.5");
        installPlugin(home, "cli", "unrelated-plugin", "9.9.9");
        const { stdout, code } = await run(
            `${IMPORT}
const findings = scanDshLanePolicies(process.env, { maxAgeMs: 0 });
console.log(JSON.stringify(findings));
const lines = dshLanePolicyLines(process.env);
console.log(JSON.stringify(lines));`,
            { DSH_HOME: home },
        );
        assert.equal(code, 0);
        const findings = JSON.parse(stdout.split("\n")[0]) as Array<{ packageName: string; version: string; profile: string; message: string }>;
        assert.equal(findings.length, 2);
        const old = findings.find((f) => f.version === "1.4.4");
        const modern = findings.find((f) => f.version === "1.4.5");
        assert.ok(old, "1.4.4 install detected");
        assert.ok(modern, "1.4.5 install detected");
        assert.equal(old.profile, "desktop");
        assert.match(old.message, /REFUSED \(403\)/);
        assert.match(old.message, />=1\.4\.5/);
        assert.match(modern.message, /never reaches bili|NEVER compressed/);
        assert.doesNotMatch(modern.message, /REFUSED/);
        // lines: two distinct (package, version) pairs, profile list appended
        const lines = JSON.parse(stdout.split("\n")[1]) as string[];
        assert.equal(lines.length, 2);
        const modernLine = lines.find((l) => l.includes("1.4.5"))!;
        assert.match(modernLine, /profile: cli/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("unknown packages, empty homes, and broken trees are inert", async () => {
    const home = fixtureHome();
    try {
        installPlugin(home, "desktop", "some-other-plugin", "0.0.1");
        // name mismatch: directory named like the policy but different package name
        const dir = path.join(home, "profiles", "desktop", "node_modules", "dsh-our-free-model");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "package.json"), "{ not json");
        const { stdout, code } = await run(
            `${IMPORT}
console.log(JSON.stringify(scanDshLanePolicies(process.env, { maxAgeMs: 0 })));`,
            { DSH_HOME: home },
        );
        assert.equal(code, 0);
        assert.deepEqual(JSON.parse(stdout), []);
        // missing profiles root entirely
        const empty = mkdtempSync(path.join(os.tmpdir(), "lane-empty-"));
        try {
            const r2 = await run(
                `${IMPORT}
console.log(JSON.stringify(scanDshLanePolicies(process.env, { maxAgeMs: 0 })));`,
                { DSH_HOME: empty },
            );
            assert.equal(r2.code, 0);
            assert.deepEqual(JSON.parse(r2.stdout), []);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("TTL cache serves repeats; maxAgeMs 0 re-walks", async () => {
    const home = fixtureHome();
    try {
        installPlugin(home, "desktop", "dsh-our-free-model", "1.4.6");
        const script = `${IMPORT}
const first = scanDshLanePolicies(process.env, { maxAgeMs: 0 });
console.log(JSON.stringify(first.map(f => f.version)));
// mutation after the cached walk must NOT show up on the repeat call...
const fs = await import("node:fs");
fs.writeFileSync(process.env.DSH_HOME + "/profiles/desktop/node_modules/dsh-our-free-model/package.json", JSON.stringify({ name: "dsh-our-free-model", version: "1.4.7" }));
const cached = scanDshLanePolicies(process.env);
console.log(JSON.stringify(cached.map(f => f.version)));
// ...but a forced re-walk must.
const fresh = scanDshLanePolicies(process.env, { maxAgeMs: 0 });
console.log(JSON.stringify(fresh.map(f => f.version)));`;
        const { stdout, code } = await run(script, { DSH_HOME: home });
        assert.equal(code, 0);
        const rows = stdout.trim().split("\n").map((l) => JSON.parse(l) as string[]);
        assert.deepEqual(rows[0], ["1.4.6"]);
        assert.deepEqual(rows[1], ["1.4.6"]);
        assert.deepEqual(rows[2], ["1.4.7"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("registry: every policy keeps a package name and a non-empty message for any version", async () => {
    const { stdout, code } = await run(
        `${IMPORT}
const out = [];
for (const p of DSH_LANE_POLICIES) {
    out.push({ name: p.packageName, label: p.label, old: p.describe("0.0.1"), modern: p.describe("99.0.0"), weird: p.describe("not-semver") });
}
console.log(JSON.stringify(out));`,
        {},
    );
    assert.equal(code, 0);
    const rows = JSON.parse(stdout) as Array<{ name: string; label: string; old: string; modern: string; weird: string }>;
    assert.ok(rows.length >= 1);
    for (const r of rows) {
        assert.ok(r.name.length > 0);
        assert.ok(r.label.length > 0);
        for (const m of [r.old, r.modern, r.weird]) assert.ok(typeof m === "string" && m.length > 20);
    }
    const ofm = rows.find((r) => r.name === "dsh-our-free-model")!;
    assert.match(ofm.old, /REFUSED/);
    assert.match(ofm.modern, /NEVER compressed/);
});

// #2090 follow-up: the /acp panel is the one surface native-lane users see —
// a detected never-compressed lane must land BEFORE PANEL_BOX_FOOTER with its
// reason (same stripper-safety contract as the advisory, #1577).
test("panel integration: lane line lands before the footer, stripped when the plugin is absent", async () => {
    const home = fixtureHome();
    try {
        installPlugin(home, "desktop", "dsh-our-free-model", "1.4.4");
        const script = `
const http = await import("node:http");
const { createCore, defaultConfig } = await import("acp-kernel");
const { _resetSessionsForTest, getSession } = await import(${JSON.stringify(new URL("../src/session.ts", import.meta.url).href)});
const { handlePluginStatus } = await import(${JSON.stringify(new URL("../src/plugin.ts", import.meta.url).href)});
const { PANEL_BOX_FOOTER } = await import(${JSON.stringify(new URL("../src/acp-panel.ts", import.meta.url).href)});
_resetSessionsForTest();
getSession("lane-sess", { protocol: "anthropic", label: "LANE" });
function mockRes() {
    const out = { res: undefined, status: 0, body: "" };
    const res = { writeHead(code) { out.status = code; return res; }, end(chunk) { if (typeof chunk === "string") out.body = chunk; return res; } };
    out.res = res;
    return out;
}
const deps = { core: createCore(), config: defaultConfig(200000), log: () => {} };
const r = mockRes();
handlePluginStatus("never-seen", r.res, deps, true);
const panel = JSON.parse(r.body).panel;
console.log(JSON.stringify({ status: r.status, panel }));
`;
        const { stdout, code, stderr } = await run(script, { DSH_HOME: home });
        assert.equal(code, 0, stderr);
        const { status, panel } = JSON.parse(stdout.trim().split("\n").at(-1)!) as { status: number; panel: string };
        assert.equal(status, 200);
        assert.match(panel, /dsh-our-free-model@1\.4\.4/);
        assert.match(panel, /REFUSED \(403\)/);
        assert.match(panel, /dsh profile: desktop/);
        assert.ok(panel.includes(PANEL_BOX_FOOTER), "footer present");
        assert.ok(panel.indexOf("dsh-our-free-model") < panel.indexOf(PANEL_BOX_FOOTER), "lane line sits BEFORE the footer (stripper-safe)");
        // clean home → no lane line at all
        const empty = mkdtempSync(path.join(os.tmpdir(), "lane-clean-"));
        try {
            const r2 = await run(script, { DSH_HOME: empty });
            const clean = JSON.parse(r2.stdout.trim().split("\n").at(-1)!) as { panel: string };
            assert.ok(!clean.panel.includes("dsh-our-free-model"), "no lane line when nothing is installed");
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
