// E2E: REAL `dsh` — the #2241 regression shape, on the native lane.
//
// A model switch mid-conversation must NOT fork the main lane off the raw
// conversation key. dsh rebuilds its main system per model, so the persona
// fingerprint (db21309d: "a different system forks onto <id>|sub:<fp>") fired
// on EVERY /model switch: the main turn landed on a fresh `|sub:` session,
// compression refs renumbered from zero, and the folding state was lost for
// the rest of the session (#2241). The fix (PR #2247) keys persona forking on
// prefix-affinity CONTINUITY: a system change whose history byte-exactly
// continues the raw key's chain MIGRATES the anchor (same conversation);
// only a history-discontinuous request (the auto-review blob) still forks.
//
// This suite reproduces the incident shape with a real dsh headless client:
//   turn 1  dsh --profile headless --json "remember the codeword"   (model A)
//   [flip the profile's default model to B — dsh recomposes its main system]
//   turn 2  dsh --profile headless --session-id <id> "recall it"    (model B)
// Both turns stamp the SAME native conversation id. Acceptance:
//   1. both dsh runs exit 0 and the oracle sees one stable conv + the model
//      switch + a continued history (turn 2 carries more messages);
//   2. exactly ONE bili session persists under the RAW conversation id —
//      no `|sub:` sibling — with requests >= 2 and refs accumulated.
//
// Zero tokens: the upstream is an in-process deterministic fake. Gated by
// ACP_TEST_E2E_DSH_NATIVE=1 (needs a real `dsh` >= 0.2.0-rc.2 with
// --session-id + `npm run build`; the profile loads dist/agent/dsh-native.js).
// On pre-fix master this suite fails with a `|sub:` sibling session — that is
// the regression it pins.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const DSH_BIN = process.env.E2E_DSH_BIN ?? "dsh";
const GATE = process.env.ACP_TEST_E2E_DSH_NATIVE === "1";
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const TMO = 180_000;

function dshAvailable(): boolean {
    const r = spawnSync(DSH_BIN, ["--version"], { timeout: 15_000 });
    return r.status === 0;
}

function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("BILI") || key.startsWith("BILLION_CONTEXT") || key.startsWith("ACP_") || key.startsWith("DSH_") || key.startsWith("ZCODE")) delete env[key];
    }
    for (const key of ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_TEST_CONTEXT", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) delete env[key];
    return env;
}

// Deterministic streaming-capable chat upstream. Records every stamped
// request (conv id, model, message count) to a JSONL oracle file.
function startFakeUpstream(port: number, reqLog: string): Promise<http.Server> {
    let n = 0;
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url?.endsWith("/models")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ object: "list", data: [
                { id: "fake-a", object: "model" },
                { id: "fake-b", object: "model" },
            ] }));
            return;
        }
        if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
            let raw = "";
            req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
            req.on("end", () => {
                try {
                    const body = JSON.parse(raw) as { messages?: { role: string; content: unknown }[]; model?: string; stream?: boolean };
                    const messages = body.messages ?? [];
                    fs.appendFileSync(reqLog, JSON.stringify({
                        conv: req.headers["x-bili-plugin-conversation"] ?? null,
                        plugin: req.headers["x-bili-plugin"] ?? null,
                        model: body.model ?? null,
                        nmsgs: messages.length,
                    }) + "\n");
                    const id = `chatcmpl-${++n}`;
                    const model = body.model ?? "fake-a";
                    const content = `ok-${n}`;
                    if (body.stream) {
                        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                        for (const delta of [{ role: "assistant" }, { content }]) {
                            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                        }
                        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`);
                        res.write("data: [DONE]\n\n");
                        res.end();
                    } else {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
                    }
                } catch (e) {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: String(e) } }));
                }
            });
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

interface Oracle { conv: string | null; plugin: string | null; model: string | null; nmsgs: number }

function readOracle(reqLog: string): Oracle[] {
    if (!fs.existsSync(reqLog)) return [];
    return fs.readFileSync(reqLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Oracle);
}

function dshRun(env: NodeJS.ProcessEnv, cwd: string, args: string[], tag: string, outDir: string): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
        const child = spawn(DSH_BIN, ["--profile", "headless", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => { out += c.toString("utf8"); });
        child.stderr.on("data", (c) => { err += c.toString("utf8"); });
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } }, TMO);
        child.on("close", (code) => {
            clearTimeout(timer);
            try {
                fs.writeFileSync(path.join(outDir, `persona-2241.${tag}.out`), out);
                fs.writeFileSync(path.join(outDir, `persona-2241.${tag}.err`), err);
            } catch { /* artifacts best-effort */ }
            resolve({ code: code ?? -1, out, err });
        });
    });
}

interface PersistedSession { id: string; requests: number | null; refs: number; blocks: number }

function readPersistedSessions(sessionsRoot: string): PersistedSession[] {
    const found: PersistedSession[] = [];
    if (!fs.existsSync(sessionsRoot)) return found;
    const walk = (d: string): void => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) walk(p);
            else if (f.name.endsWith(".json")) {
                try {
                    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { payload?: { id?: string; stats?: { requests?: number }; state?: { messageRefs?: { byRaw?: Record<string, unknown> }; blocks?: Record<string, unknown> } } };
                    const inner = j.payload ?? (j as { id?: string });
                    found.push({
                        id: String(inner.id ?? "?"),
                        requests: (j.payload?.stats?.requests) ?? null,
                        refs: Object.keys(j.payload?.state?.messageRefs?.byRaw ?? {}).length,
                        blocks: Object.keys(j.payload?.state?.blocks ?? {}).length,
                    });
                } catch { /* skip unreadable */ }
            }
        }
    };
    walk(sessionsRoot);
    return found;
}

test("real dsh #2241: a mid-session model switch keeps the raw conversation key (no |sub: fork)", { skip: (!GATE || !dshAvailable()) ? "set ACP_TEST_E2E_DSH_NATIVE=1 with a real dsh >= 0.2.0-rc.2" : false }, async (t) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "agent", "dsh-native.js")), "npm run build first — the profile loads dist/agent/dsh-native.js");

    const outDir = path.join(REPO_ROOT, "tmp", `e2e-dsh-persona-${process.pid}`);
    fs.mkdirSync(outDir, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-dsh-persona-"));
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const dshHome = path.join(root, "dsh");
    const xdg = { config: path.join(root, "config"), cache: path.join(root, "cache"), state: path.join(root, "state"), data: path.join(root, "data") };
    const cwd = path.join(root, "cwd");
    for (const d of [home, tmp, dshHome, cwd, ...Object.values(xdg)]) fs.mkdirSync(d, { recursive: true });
    const reqLog = path.join(outDir, "oracle.jsonl");

    const fakePort = 18931;
    const fake = await startFakeUpstream(fakePort, reqLog);
    t.after(() => { fake.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

    // --- headless profile wiring (production lane shape, no package manager) ---
    const profileDir = path.join(dshHome, "profiles", "headless");
    const pkgDir = path.join(profileDir, "node_modules", "billion-context");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(pkgDir, "package.json"));
    fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(pkgDir, "dist"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "dsh.bundle.patch.yml"), path.join(pkgDir, "dsh.bundle.patch.yml"));
    const biliVersion = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
    fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
        name: "e2e-dsh-persona-headless",
        private: true,
        dependencies: { "billion-context": biliVersion },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"], patchReload: "startup" } },
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(profileDir, "cordis.yml"), "[]\n");
    fs.writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n");
    // Two models; the default flips between the turns — dsh recomposes its
    // main system per model, the exact #2241 trigger. Model B also carries a
    // different context window so the two system texts are guaranteed apart.
    const patchYml = (model: string): string => [
        "- id: llm-pi-ai",
        "  config:",
        "    providers:",
        "      fake:",
        "        displayName: Fake Upstream",
        "        apiKeyEnv: E2E_FAKE_KEY",
        "        api: openai-completions",
        `        baseURL: http://127.0.0.1:${fakePort}/v1`,
        "        models:",
        "          - id: fake-a",
        "            name: Model Alpha",
        "            contextWindow: 60000",
        "            maxTokens: 4096",
        "          - id: fake-b",
        "            name: Model Beta",
        "            contextWindow: 32000",
        "            maxTokens: 4096",
        "- id: agent-default-model",
        "  config:",
        "    provider: fake",
        `    model: ${model}`,
        "",
    ].join("\n");
    fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), patchYml("fake-a"));
    fs.mkdirSync(path.join(xdg.config, "billion-context"), { recursive: true });
    fs.writeFileSync(path.join(xdg.config, "billion-context", "billion-context.json"),
        JSON.stringify({ providers: {}, compress: { preserveRecentTokens: 0 } }, null, 2) + "\n");

    const env: NodeJS.ProcessEnv = {
        ...cleanEnv(),
        HOME: home,
        TMPDIR: tmp,
        DSH_HOME: dshHome,
        XDG_CONFIG_HOME: xdg.config,
        XDG_CACHE_HOME: xdg.cache,
        XDG_STATE_HOME: xdg.state,
        XDG_DATA_HOME: xdg.data,
        E2E_FAKE_KEY: "e2e-fake-key",
        DSH_TELEMETRY_MODE: "DISABLED",
        LANG: "C.UTF-8",
        // #1158/#1187 coexistence: a dead proxy policy must not leak in; the
        // loopback NO_PROXY keeps fixture traffic direct.
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "127.0.0.1,localhost",
    };

    try {
        // ---- turn 1: model A claims the raw key ----
        const r1 = await dshRun(env, cwd, ["--json", "We are setting up a workspace. Remember the codeword ZX7. Then reply with exactly: setup done."], "t1", outDir);
        assert.equal(r1.code, 0, `turn 1 dsh exit (${r1.err.slice(-300)})`);
        let sessionId: string | undefined;
        for (const line of r1.out.split("\n")) {
            if (!line.trim().startsWith("{")) continue;
            try {
                const ev = JSON.parse(line) as { type?: string; sessionId?: string };
                if (ev.type === "session" && typeof ev.sessionId === "string") { sessionId = ev.sessionId; break; }
            } catch { /* skip partial */ }
        }
        assert.ok(sessionId, "turn 1 --json events expose the dsh session id");

        // ---- the model switch: same dsh session, recomposed main system ----
        fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), patchYml("fake-b"));
        const r2 = await dshRun(env, cwd, ["--session-id", sessionId, "--json", "What was the codeword? Answer with the word only."], "t2", outDir);
        assert.equal(r2.code, 0, `turn 2 dsh exit (${r2.err.slice(-300)})`);

        // ---- oracle: one conversation, a real model switch, history grew ----
        const oracle = readOracle(reqLog);
        const convs = new Set(oracle.map((o) => o.conv).filter(Boolean));
        assert.equal(convs.size, 1, "both turns stamped ONE conversation id");
        const conv = [...convs][0] as string;
        const turn1 = oracle.filter((o) => o.model === "fake-a");
        const turn2 = oracle.filter((o) => o.model === "fake-b");
        assert.ok(turn1.length >= 1, "turn 1 rode model fake-a");
        assert.ok(turn2.length >= 1, "turn 2 rode model fake-b — the switch reached the wire");
        assert.ok(Math.max(...turn2.map((o) => o.nmsgs)) > Math.max(...turn1.map((o) => o.nmsgs)), "turn 2 continues the SAME history (more messages on the wire)");

        // ---- graceful-stop the hermetic proxies so sessions flush ----
        const instancesDir = path.join(xdg.state, "billion-context", "instances");
        try {
            for (const f of fs.readdirSync(instancesDir)) {
                try {
                    const rec = JSON.parse(fs.readFileSync(path.join(instancesDir, f), "utf8")) as { pid?: number };
                    if (typeof rec.pid === "number" && rec.pid > 0) { try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ } }
                } catch { /* unreadable record */ }
            }
        } catch { /* no instances dir */ }
        await new Promise((r) => setTimeout(r, 1500));

        // ---- acceptance: ONE session under the RAW key, no |sub: sibling ----
        const sessions = [
            ...readPersistedSessions(path.join(xdg.state, "billion-context", "sessions")),
            ...readPersistedSessions(path.join(xdg.data, "billion-context", "sessions")),
        ].filter((s) => s.id === conv || s.id.startsWith(`${conv}|sub:`));
        const main = sessions.find((s) => s.id === conv);
        const forks = sessions.filter((s) => s.id.startsWith(`${conv}|sub:`));
        assert.equal(forks.length, 0, `#2241: the model switch must NOT fork the main lane (found ${forks.map((f) => f.id).join(", ")})`);
        assert.ok(main, "the raw conversation key persisted a session");
        assert.ok((main?.requests ?? 0) >= 2, `both turns rode the raw key (requests=${main?.requests})`);
        assert.ok((main?.refs ?? 0) >= 4, `refs accumulated across the switch (refs=${main?.refs})`);
    } finally {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});
