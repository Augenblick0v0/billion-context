// #1958 (direction change): "native plugin + hand-written /bili/ provider
// baseURL" is a CONFLICTING configuration — two mutually exclusive access
// paths claiming routing ownership of the same requests. Per maintainer
// decision it must be EXPOSED, not silently absorbed, and NOT auto-repaired:
//   - runtime: the V2 native route warns once per (session, origin) with a
//     fix-it guide; an explicit pin of the SAME origin
//     (BILLION_CONTEXT_PROXY pointing at the proxy the URLs already ride)
//     stays silent;
//   - the request itself is left on the plain-proxy path it already encodes:
//     no rewrite, no plugin stamping (s.proxyBase stays unset);
//   - install: intentionally NOT gated — warning is the correction, and a
//     refusal could permanently block installs on scanner false positives.
import test from "node:test";
import assert from "node:assert/strict";

// Module-level guards read env while opencode-native EVALUATES; static imports
// hoist above any assignment, so set the marker first and import dynamically.
process.env.NODE_TEST_CONTEXT = "1";

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";

const { createNativeRoute } = await import("../src/agent/opencode-native.ts");

const BAKED = "http://127.0.0.1:9999";
const ROUTED_URL = `${BAKED}/bili/http://example.invalid/v1/chat/completions`;

function routedEvent(sessionID: string | undefined, url = ROUTED_URL): V2HttpRequestEvent {
    const e: V2HttpRequestEvent = { request: new Request(url, { method: "POST" }) };
    if (sessionID !== undefined) e.sessionID = sessionID;
    return e;
}

async function capturedErrors(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
        await fn();
    } finally {
        console.error = orig;
    }
    return lines.filter((l) => l.includes("conflicting configuration"));
}

function spawnState(): NativeInterceptState {
    return { origin: "http://127.0.0.1:7777", ready: Promise.resolve("http://127.0.0.1:7777") };
}

test("#1958: conflicting pre-routed URL warns once per (session, origin), request untouched", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    try {
        const route = createNativeRoute(spawnState());
        const s: V2State = {};
        const otherUrl = `${BAKED.replace(":9999", ":9998")}/bili/http://other.invalid/v1/chat/completions`;
        const run = async (): Promise<void> => {
            await route(routedEvent("ses_a"), s);
            assert.equal(s.proxyBase, undefined, "no silent compat: the pre-routed path is NOT stamped");
            await route(routedEvent("ses_a"), s);
            await route(routedEvent("ses_b"), s);
            await route(routedEvent("ses_a", otherUrl), s);
        };
        const lines = await capturedErrors(run);
        assert.equal(lines.length, 3, "one per distinct (session, origin) pair");
        assert.match(lines[0], new RegExp(BAKED));
        assert.match(lines[0], /pick one/i);
        assert.equal(s.proxyBase, undefined, "the plugin never claims routing of pre-routed URLs");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});

test("#1958: an explicit pin of the SAME origin is the supported attach posture — silent", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = BAKED;
    try {
        const state: NativeInterceptState = { origin: BAKED, ready: Promise.resolve(BAKED), attach: true };
        const s: V2State = {};
        const lines = await capturedErrors(async () => {
            await createNativeRoute(state)(routedEvent("ses_pin"), s);
            await createNativeRoute(state)(routedEvent("ses_pin"), s);
        });
        assert.equal(lines.length, 0, "benign explicit pin must not warn");
        // Trailing slash / default-port spelling differences normalize away.
        process.env.BILLION_CONTEXT_PROXY = `${BAKED}/`;
        const s2: V2State = {};
        const lines2 = await capturedErrors(async () => {
            await createNativeRoute(state)(routedEvent("ses_pin"), s2);
        });
        assert.equal(lines2.length, 0);
        process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:80";
        const s3: V2State = {};
        const lines3 = await capturedErrors(async () => {
            await createNativeRoute({ origin: "http://127.0.0.1", ready: Promise.resolve("http://127.0.0.1") })(routedEvent("ses_pin", "http://127.0.0.1:80/bili/http://example.invalid/v1/chat/completions"), s3);
        });
        assert.equal(lines3.length, 0, "default ports fold in URL.origin comparison");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});

test("#1958: attach to a DIFFERENT origin than the baked URL warns (real conflict)", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:7777";
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:7777", ready: Promise.resolve("http://127.0.0.1:7777"), attach: true };
        const s: V2State = {};
        const lines = await capturedErrors(async () => {
            await createNativeRoute(state)(routedEvent("ses_mismatch"), s);
        });
        assert.equal(lines.length, 1);
        assert.equal(s.proxyBase, undefined, "the pinned channel is left on its own path — no stamping, no rewrite");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});

test("#1958: non-model /bili/ traffic and /__bili/health never warn", async () => {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    try {
        const s: V2State = {};
        const lines = await capturedErrors(async () => {
            await createNativeRoute(spawnState())(routedEvent("ses_nm", `${BAKED}/bili/http://example.invalid/some/other/path`), s);
            await createNativeRoute(spawnState())(routedEvent("ses_nm", `${BAKED}/__bili/health`), s);
        });
        assert.equal(lines.length, 0, "only model API URLs carry the routing claim");
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
});
