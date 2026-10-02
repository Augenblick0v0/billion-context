// #1849 (client half): when the dsh host structurally cannot produce a model
// window — no llm.resolveModelInfo, a resolver whose answer carries no
// contextWindow, or the model services never binding (web-profile flavor) —
// the x-bili-plugin-context-window header goes unstamped and the proxy silently
// sizes against registry guesses. The plugin must SAY so on the client surface:
// console.warn + a durable [dsh-client] line via persistClientEvent (GUI hosts
// swallow stderr, #1158). One line per process, each degradation branch
// reachable, and stamps with services bound never warn.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { apply, _resetRegisterForTest, _resetWindowWarningForTest, _setSpawnForTest, _settleNativeForTest, _stateHeadersForTest, _stateToolsReadyForTest } from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

// #1797: drain ALL in-flight attach/recovery chains after each test.
afterEach(() => { void _settleNativeForTest(); });

const HEADER_TARGET = "http://example.test/v1/chat/completions";

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

type MockTool = { name: string; description?: string; inputSchema: unknown };

function startMockProxy(): Promise<{ origin: string; close: () => void }> {
    const manifestTools: MockTool[] = [
        { name: "compress", description: "Compress a range of messages", inputSchema: { type: "object", properties: { summary: { type: "string" }, range: { type: "string" } }, required: ["summary"] } },
    ];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

const POLL_DEADLINE_MS = 15000;
async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function mockCtx() {
    const tools: RegisteredTool[] = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    let llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> } | undefined = undefined;
    let agentDefaultModel: { currentSelection?: () => { provider?: string; model?: string } | undefined } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
        commands: { register: () => undefined },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        inject: (deps: readonly string[], callback: (sub: unknown) => void) => {
            if (deps.includes("llm") && deps.includes("agentDefaultModel") && llm !== undefined && agentDefaultModel !== undefined) {
                callback({ llm, agentDefaultModel });
            }
        },
        setModelServices: (l: typeof llm, a: typeof agentDefaultModel) => {
            llm = l;
            agentDefaultModel = a;
        },
    };
}

function windowWarnLines(logFile: string): string[] {
    return fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("[dsh-client]") && l.includes("#1849"))
        : [];
}

test("#1849 apply(): a resolver answer without a context window warns once in the durable log", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ww1-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ww1-state-"));
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    _setSpawnForTest(async () => undefined);
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetWindowWarningForTest();
            const ctx = mockCtx();
            ctx.setModelServices(
                { resolveModelInfo: async () => ({ defaultMaxTokens: 8192 }) },
                { currentSelection: () => ({ provider: "deepseek", model: "qwen-ww" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ww)");
            ctx.setInitiator({ session: { id: "session-ww" } });
            await waitFor(() => windowWarnLines(logFile).length === 1, "no-context-window warn line");
            const line = windowWarnLines(logFile)[0];
            assert.match(line, /carries no context window/);
            assert.match(line, /x-bili-plugin-context-window goes unstamped/);
            // once per process: repeated refreshes add nothing
            _stateHeadersForTest()?.(HEADER_TARGET);
            _stateHeadersForTest()?.(HEADER_TARGET);
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(windowWarnLines(logFile).length, 1);
            await _stateToolsReadyForTest();
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        _resetWindowWarningForTest();
    }
});

test("#1849 apply(): an host without llm.resolveModelInfo warns", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ww2-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ww2-state-"));
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    _setSpawnForTest(async () => undefined);
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetWindowWarningForTest();
            const ctx = mockCtx();
            // llm service exists but exposes no resolver
            ctx.setModelServices({}, { currentSelection: () => ({ provider: "deepseek", model: "qwen-ww2" }) });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ww2)");
            ctx.setInitiator({ session: { id: "session-ww2" } });
            await waitFor(() => windowWarnLines(logFile).length === 1, "no-resolver warn line");
            assert.match(windowWarnLines(logFile)[0], /resolveModelInfo is unavailable/);
            await _stateToolsReadyForTest();
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        _resetWindowWarningForTest();
    }
});

test("#1849 apply(): model services that never bind warn after three stamps; bound services never warn", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ww3-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ww3-state-"));
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    _setSpawnForTest(async () => undefined);
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            // scenario 1: web-profile flavor — no model services at all
            _resetRegisterForTest(proxy.origin);
            _resetWindowWarningForTest();
            const bare = mockCtx();
            apply(bare);
            await waitFor(() => bare.registeredTools.length === 1, "manifest tool registration (ww3-bare)");
            bare.setInitiator({ session: { id: "session-ww3" } });
            for (let i = 0; i < 3; i++) _stateHeadersForTest()?.(HEADER_TARGET);
            await waitFor(() => windowWarnLines(logFile).length === 1, "services-never-bound warn line");
            assert.match(windowWarnLines(logFile)[0], /never became available/);
            await _stateToolsReadyForTest();

            // scenario 2: healthy services — stamps carry the window, no warn
            _resetRegisterForTest(proxy.origin);
            _resetWindowWarningForTest();
            fs.rmSync(logFile, { force: true });
            const healthy = mockCtx();
            healthy.setModelServices(
                { resolveModelInfo: async () => ({ context: { contextWindow: 262144 }, defaultMaxTokens: 32768 }) },
                { currentSelection: () => ({ provider: "deepseek", model: "qwen-ww3h" }) },
            );
            apply(healthy);
            await waitFor(() => healthy.registeredTools.length === 1, "manifest tool registration (ww3-healthy)");
            healthy.setInitiator({ session: { id: "session-ww3h" } });
            await waitFor(() => {
                const headers = _stateHeadersForTest()?.(HEADER_TARGET);
                return headers?.["x-bili-plugin-context-window"] === "262144";
            }, "model-info refresh stamped headers");
            assert.equal(windowWarnLines(logFile).length, 0);
            await _stateToolsReadyForTest();
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        _resetWindowWarningForTest();
    }
});
