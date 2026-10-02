import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, createHmac } from "node:crypto";

process.env.NODE_ENV = "test";

import {
    APIG_RESIGN_CREDENTIAL_HEADER,
    APIG_RESIGN_HEADER,
    APIG_RESIGN_SCHEME,
    apigBenefitModels,
    decodeApigCredential,
    encodeApigCredential,
    inboundSignedScheme,
    modelOfJsonBody,
    resignApig,
    resignEnabled,
    signApigHeaders,
    type ApigCredential,
} from "../src/apig-resign.ts";
import { bodySignedSchemeOf, installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { defaultConfig } from "acp-kernel";

// #1884 (CodeArts APIG, SDK-HMAC-SHA256): bili rewrites bodies, which breaks
// any body-covering signature. The re-sign arm tunnels signed requests with a
// loopback credential marker and re-signs every egress body. These tests pin
// the signer byte-semantics (against an INDEPENDENT verifier written from the
// wire format, not by calling the signer back), the loopback markers, the
// native-intercept arming / direct fallback, and the full proxy chain against
// a mock upstream that validates signatures with the ak/sk it issued.

const CRED: ApigCredential = { ak: "AKTEST123", sk: "SKTEST456", token: "tok-789" };
const NOW = new Date("2026-10-02T10:30:00.000Z");
const DATE_STAMP = "20261002T103000Z";

function sha256Hex(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
}

/** Independent verifier: recompute the SDK-HMAC-SHA256 signature from what a
 * server ACTUALLY received (method / full URL / lowercased headers / raw
 * body). Written from the wire format on purpose — the signer must round-trip
 * through an implementation that does not share its code. */
function verifySdkHmac(req: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    sk: string;
    ak?: string;
}): { ok: boolean; reason?: string; signedHeaders?: string } {
    const auth = String(req.headers["authorization"] ?? "");
    const m = /^SDK-HMAC-SHA256 Access=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(auth);
    if (m === null) return { ok: false, reason: `authorization shape: ${auth}` };
    const [, ak, signedHeaders, sig] = m;
    if (req.ak !== undefined && ak !== req.ak) return { ok: false, reason: "access key mismatch" };
    const names = signedHeaders.split(";");
    if (names.length === 0 || new Set(names).size !== names.length) return { ok: false, reason: "duplicate/empty signed headers" };
    if ([...names].sort().join(";") !== signedHeaders) return { ok: false, reason: "signed headers not sorted" };
    const u = new URL(req.url);
    let uri = u.pathname;
    if (!uri.endsWith("/")) uri += "/";
    const headerVal = (n: string): string => {
        const v = req.headers[n];
        return Array.isArray(v) ? v.join(",") : String(v ?? "");
    };
    const payloadHash = sha256Hex(req.body);
    if (headerVal("x-sdk-content-sha256") !== payloadHash) return { ok: false, reason: "declared payload hash != sha256(body)" };
    const canonical = [
        req.method.toUpperCase(),
        uri,
        u.search.slice(1),
        names.map((n) => `${n}:${headerVal(n)}`).join("\n"),
        "",
        names.join(";"),
        payloadHash,
    ].join("\n");
    const stringToSign = `SDK-HMAC-SHA256\n${headerVal("x-sdk-date")}\n${sha256Hex(canonical)}`;
    const expect = createHmac("sha256", req.sk).update(stringToSign).digest("hex");
    if (expect !== sig) return { ok: false, reason: "signature mismatch", signedHeaders };
    return { ok: true, signedHeaders };
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(patch)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of saved.entries()) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

// ---------------------------------------------------------------------------
// Signer unit tests
// ---------------------------------------------------------------------------

test("#1884 signer: deterministic golden shape and independent verification", () => {
    const body = Buffer.from(JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hello" }] }), "utf8");
    const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
    const a: Record<string, string> = {};
    signApigHeaders(a, CRED, "POST", url, body, { now: NOW });
    const b: Record<string, string> = {};
    signApigHeaders(b, CRED, "POST", url, body, { now: NOW });

    assert.equal(a["authorization"], b["authorization"], "same inputs → identical signature");
    assert.equal(a["x-sdk-date"], DATE_STAMP, "date stamp format 20261002T103000Z");
    assert.equal(a["x-sdk-content-sha256"], sha256Hex(body), "declared payload hash");
    assert.equal(a["x-security-token"], "tok-789", "temporary token shipped");
    assert.equal(a["host"], "snap-access.cn-north-4.myhuaweicloud.com");
    assert.match(a["authorization"], /^SDK-HMAC-SHA256 Access=AKTEST123,SignedHeaders=/);
    // signed set for POST: content-type, host, x-sdk-content-sha256, x-sdk-date, x-security-token (sorted)
    assert.equal(/SignedHeaders=([^,]+),/.exec(a["authorization"])?.[1], "content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token");

    const verdict = verifySdkHmac({ method: "POST", url, headers: a, body, sk: CRED.sk });
    assert.deepEqual([verdict.ok, verdict.reason], [true, undefined], "independent verifier accepts the signature");
});

test("#1884 signer: body byte flip changes the signature", () => {
    const url = "http://127.0.0.1:9/api/v2/chat/completions";
    const a: Record<string, string> = {};
    signApigHeaders(a, CRED, "POST", url, Buffer.from("{\"x\":1}"), { now: NOW });
    const b: Record<string, string> = {};
    signApigHeaders(b, CRED, "POST", url, Buffer.from("{\"x\":2}"), { now: NOW });
    assert.notEqual(a["authorization"], b["authorization"]);
    // …and both remain independently valid for their own body
    assert.equal(verifySdkHmac({ method: "POST", url, headers: a, body: Buffer.from("{\"x\":1}"), sk: CRED.sk }).ok, true);
    assert.equal(verifySdkHmac({ method: "POST", url, headers: b, body: Buffer.from("{\"x\":2}"), sk: CRED.sk }).ok, true);
});

test("#1884 signer: GET signs without content-type; query joins the canonical request", () => {
    const url = "http://127.0.0.1:9/api/v1/queue/status?session=abc";
    const a: Record<string, string> = {};
    signApigHeaders(a, CRED, "GET", url, Buffer.alloc(0), { now: NOW });
    assert.equal(a["content-type"], undefined, "GET carries no content-type");
    const verdict = verifySdkHmac({ method: "GET", url, headers: a, body: Buffer.alloc(0), sk: CRED.sk });
    assert.equal(verdict.ok, true, "canonical request includes the query string");
});

test("#1884 signer: stale signature headers are replaced, never duplicated", () => {
    const url = "http://127.0.0.1:9/v1/chat/completions";
    const target: Record<string, string> = {
        "Authorization": "SDK-HMAC-SHA256 Access=OLD,SignedHeaders=host,Signature=deadbeef",
        "X-SDK-DATE": "19990101T000000Z",
        "x-sdk-content-sha256": "00",
        "X-Security-Token": "stale-token",
        "maas_type": "benefit",
        "accept": "application/json",
    };
    signApigHeaders(target, CRED, "POST", url, Buffer.from("{}"), { now: NOW, extraSignedHeaders: { maas_type: "benefit" } });
    const own = Object.fromEntries(Object.entries(target).filter(([k]) =>
        ["authorization", "x-sdk-date", "x-sdk-content-sha256", "x-security-token", "maas_type"].includes(k.toLowerCase())));
    // exactly one of each (lowercased), no stale value survives
    assert.deepEqual(Object.keys(own).map((k) => k.toLowerCase()).sort(), ["authorization", "maas_type", "x-sdk-content-sha256", "x-sdk-date", "x-security-token"]);
    assert.notEqual(target["authorization"], "SDK-HMAC-SHA256 Access=OLD,SignedHeaders=host,Signature=deadbeef");
    assert.equal(target["x-sdk-date"], DATE_STAMP, "old X-SDK-DATE (mixed case) was removed too");
    assert.equal(target["maas_type"], "benefit", "extra signed header re-stamped");
    assert.equal(target["accept"], "application/json", "unrelated headers survive");
});

test("#1884 benefit: maas_type only for benefit models; env override honored", async () => {
    assert.deepEqual([...apigBenefitModels()].sort(), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
    const url = "http://127.0.0.1:9/v1/chat/completions";
    const benefitBody = JSON.stringify({ model: "GLM-5.3-FLASH", messages: [] });
    const plainBody = JSON.stringify({ model: "deepseek-v4-flash", messages: [] }); // near-miss, NOT benefit

    const a: Record<string, string> = {};
    resignApig(a, CRED, "POST", url, benefitBody, NOW);
    assert.equal(a["maas_type"], "benefit", "benefit model (case-insensitive) gets the signed maas_type");
    assert.equal(verifySdkHmac({ method: "POST", url, headers: a, body: Buffer.from(benefitBody), sk: CRED.sk }).ok, true, "maas_type joins the signature");

    const b: Record<string, string> = {};
    resignApig(b, CRED, "POST", url, plainBody, NOW);
    assert.equal(b["maas_type"], undefined, "non-benefit model signs without maas_type");

    await withEnv({ BILI_RESIGN_BENEFIT: "custom-model" }, async () => {
        const c: Record<string, string> = {};
        resignApig(c, CRED, "POST", url, JSON.stringify({ model: "custom-model", messages: [] }), NOW);
        assert.equal(c["maas_type"], "benefit", "env override replaces the default set");
    });
});

test("#1884 detection: inboundSignedScheme classifies body-covering schemes", () => {
    assert.equal(inboundSignedScheme({ authorization: "SDK-HMAC-SHA256 Access=X" }), "sdk-hmac-sha256");
    assert.equal(inboundSignedScheme({ authorization: "sdk-hmac-sha256 Access=X" }), "sdk-hmac-sha256");
    assert.notEqual(inboundSignedScheme({ authorization: "AWS4-HMAC-SHA256 Credential=X" }), APIG_RESIGN_SCHEME, "AWS4 detected but NOT re-signable");
    assert.equal(inboundSignedScheme({ authorization: "Bearer sk-123" }), undefined, "bearer is not body-covering");
    assert.equal(inboundSignedScheme({ "x-sdk-content-sha256": "aa" }), "x-sdk-content-sha256", "content-hash header alone implies body-covering");
    assert.equal(inboundSignedScheme({ "x-amz-content-sha256": "aa" }), "x-amz-content-sha256");
    assert.equal(inboundSignedScheme({}), undefined);
});

test("#1884 detection: bodySignedSchemeOf reads fetch(input, init) shapes", () => {
    assert.equal(bodySignedSchemeOf("http://127.0.0.1:9/v1/chat/completions", { method: "POST", headers: { authorization: "SDK-HMAC-SHA256 Access=X" } }), "sdk-hmac-sha256");
    assert.equal(bodySignedSchemeOf(new Request("http://127.0.0.1:9/v1/chat/completions", { method: "POST", headers: { "x-sdk-content-sha256": "aa" } })), "x-sdk-content-sha256");
    assert.equal(bodySignedSchemeOf("http://127.0.0.1:9/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer x" } }), undefined);
});

test("#1884 markers: credential encode/decode roundtrip, garbage tolerated", () => {
    const enc = encodeApigCredential(CRED);
    assert.deepEqual(decodeApigCredential(enc), { ak: "AKTEST123", sk: "SKTEST456", token: "tok-789" });
    assert.equal(decodeApigCredential(undefined), undefined);
    assert.equal(decodeApigCredential(""), undefined);
    assert.equal(decodeApigCredential("!!!not-base64-json!!!") ?? undefined, undefined, "malformed payload degrades, never throws");
    assert.equal(decodeApigCredential(Buffer.from(JSON.stringify({ ak: "x" })).toString("base64")), undefined, "missing sk rejected");
    assert.equal(decodeApigCredential(Buffer.from(JSON.stringify({ ak: "", sk: "y" })).toString("base64")), undefined, "empty ak rejected");
});

test("#1884 kill switch: BILI_RESIGN=0 disables the arm only", async () => {
    assert.equal(resignEnabled(), true);
    await withEnv({ BILI_RESIGN: "0" }, async () => assert.equal(resignEnabled(), false));
    assert.equal(resignEnabled(), true);
});

test("#1884 modelOfJsonBody: best-effort extraction", () => {
    assert.equal(modelOfJsonBody("{\"model\":\"m\"}"), "m");
    assert.equal(modelOfJsonBody("{\"other\":1}"), undefined);
    assert.equal(modelOfJsonBody("not json"), undefined);
});

// ---------------------------------------------------------------------------
// Native intercept: arming, markers, direct fallbacks
// ---------------------------------------------------------------------------

interface RecordedCall {
    url: string;
    headers: Record<string, string>;
}

function recordingFetch(sink: RecordedCall[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const src = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
        const headers: Record<string, string> = {};
        if (src !== undefined) for (const [k, v] of new Headers(src).entries()) headers[k] = v;
        sink.push({ url, headers });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withIntercept<T>(state: NativeInterceptState, fn: (fetch: typeof fetch) => Promise<T>): Promise<{ sink: RecordedCall[]; result: T }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: RecordedCall[] = [];
    globalThis.fetch = recordingFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn(globalThis.fetch);
        return { sink, result };
    } finally {
        // Order matters: _resetForTest first (drops the accessor, restoring
        // the pre-install descriptor — which snapshots the FAKE fetch we
        // installed over), THEN the plain assignment puts the true fetch
        // back. The opposite order routes the assignment through the guard's
        // setter and leaves the chain installed, poisoning every later
        // network test in this file.
        _resetForTest();
        globalThis.fetch = saved;
    }
}

const SIGNED_INIT = (extra: Record<string, string> = {}): RequestInit => ({
    method: "POST",
    headers: {
        "content-type": "application/json",
        authorization: "SDK-HMAC-SHA256 Access=CLIENT,SignedHeaders=host;x-sdk-content-sha256;x-sdk-date,Signature=0000",
        "x-sdk-date": "20260101T000000Z",
        "x-sdk-content-sha256": "1111",
        ...extra,
    },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
});

function armedState(overrides: Partial<NativeInterceptState> = {}): NativeInterceptState {
    return {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        takeoverGate: () => true,
        headersFor: () => ({}),
        resignCredentialFor: async () => CRED,
        ...overrides,
    };
}

test("#1884 intercept: signed + credential → tunneled with re-sign markers", async () => {
    const { sink } = await withIntercept(armedState(), async (fetch) =>
        fetch("http://127.0.0.1:9199/v1/chat/completions", SIGNED_INIT()));
    assert.equal(sink.length, 1);
    assert.equal(sink[0].url, "http://127.0.0.1:40001/bili/http://127.0.0.1:9199/v1/chat/completions", "rewritten into the proxy tunnel");
    assert.equal(sink[0].headers[APIG_RESIGN_HEADER], APIG_RESIGN_SCHEME, "arm marker rides the tunnel");
    assert.deepEqual(decodeApigCredential(sink[0].headers[APIG_RESIGN_CREDENTIAL_HEADER]), { ak: CRED.ak, sk: CRED.sk, token: CRED.token }, "credential marker is decodable");
    assert.equal(sink[0].headers["authorization"], "SDK-HMAC-SHA256 Access=CLIENT,SignedHeaders=host;x-sdk-content-sha256;x-sdk-date,Signature=0000", "inbound (stale) signature rides for the server to replace");
});

test("#1884 intercept: no credential → direct, untouched bytes (#1886 fallback)", async () => {
    const dispatches: string[] = [];
    const state = armedState({ resignCredentialFor: async () => undefined, onDispatch: (_u, action) => dispatches.push(action) });
    const { sink } = await withIntercept(state, async (fetch) =>
        fetch("http://127.0.0.1:9199/v1/chat/completions", SIGNED_INIT()));
    assert.equal(sink.length, 1);
    assert.equal(sink[0].url, "http://127.0.0.1:9199/v1/chat/completions", "original URL, never rewritten");
    assert.equal(sink[0].headers[APIG_RESIGN_HEADER], undefined);
    assert.deepEqual(dispatches, ["direct"]);
});

test("#1884 intercept: resolver throws → direct (never fail the request)", async () => {
    const state = armedState({ resignCredentialFor: async () => { throw new Error("credentials service down"); } });
    const { sink } = await withIntercept(state, async (fetch) =>
        fetch("http://127.0.0.1:9199/v1/chat/completions", SIGNED_INIT()));
    assert.equal(sink[0].url, "http://127.0.0.1:9199/v1/chat/completions");
    assert.equal(sink[0].headers[APIG_RESIGN_HEADER], undefined);
});

test("#1884 intercept: BILI_RESIGN=0 → direct even with a live credential", async () => {
    await withEnv({ BILI_RESIGN: "0" }, async () => {
        const { sink } = await withIntercept(armedState(), async (fetch) =>
            fetch("http://127.0.0.1:9199/v1/chat/completions", SIGNED_INIT()));
        assert.equal(sink[0].url, "http://127.0.0.1:9199/v1/chat/completions", "kill switch forces direct");
        assert.equal(sink[0].headers[APIG_RESIGN_HEADER], undefined);
    });
});

test("#1884 intercept: AWS4 (unsupported scheme) → direct even with a credential", async () => {
    const { sink } = await withIntercept(armedState(), async (fetch) =>
        fetch("http://127.0.0.1:9199/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "AWS4-HMAC-SHA256 Credential=AK/20260101/cn-north-4/sms/sdk_request", "x-amz-content-sha256": "aa" },
            body: "{}",
        }));
    assert.equal(sink[0].url, "http://127.0.0.1:9199/v1/chat/completions");
    assert.equal(sink[0].headers[APIG_RESIGN_HEADER], undefined);
});

test("#1884 intercept: unsigned model traffic is unaffected", async () => {
    const dispatches: string[] = [];
    const state = armedState({ onDispatch: (_u, action) => dispatches.push(action) });
    const { sink } = await withIntercept(state, async (fetch) =>
        fetch("http://127.0.0.1:9199/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-1" }, body: "{}" }));
    assert.equal(sink[0].url, "http://127.0.0.1:40001/bili/http://127.0.0.1:9199/v1/chat/completions", "normal rewrite path");
    assert.equal(sink[0].headers[APIG_RESIGN_HEADER], undefined);
    assert.deepEqual(dispatches, ["rewrite"]);
});

// ---------------------------------------------------------------------------
// E2E through the proxy server: mock upstream verifies every signature
// ---------------------------------------------------------------------------

interface UpstreamRecord {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}

function startVerifyingUpstream(sk: string): Promise<{ server: http.Server; port: number; calls: UpstreamRecord[] }> {
    const calls: UpstreamRecord[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            calls.push({ method: req.method ?? "POST", url: req.url ?? "/", headers: req.headers, body });
            const verdict = verifySdkHmac({ method: req.method ?? "POST", url: `http://${req.headers["host"]}${req.url}`, headers: req.headers, body, sk });
            if (!verdict.ok) {
                res.writeHead(401, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { code: "APIG.0301", message: `signature verification failed: ${verdict.reason}` } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "cmpl-test", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: (server.address() as { port: number }).port, calls });
        });
    });
}

async function startResignProxy(upstreamPort: number): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4.1-flash": { context: 200_000 }, "glm-5.3-flash": { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: (proxy.address() as { port: number }).port };
}

function chatBody(model: string, session: string): string {
    return JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: `hello from ${session}` }],
        max_tokens: 512,
        session_id: session,
    });
}

test("e2e #1884: armed tunnel — every egress body is re-signed, markers never leak upstream", async () => {
    const { server: upstream, port: upstreamPort, calls } = await startVerifyingUpstream(CRED.sk);
    const { proxy, port: proxyPort } = await startResignProxy(upstreamPort);
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const staleAuth = "SDK-HMAC-SHA256 Access=CLIENT,SignedHeaders=host;x-sdk-content-sha256;x-sdk-date,Signature=0000";
        const r = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: staleAuth,
                "x-sdk-date": "20260101T000000Z",
                "x-sdk-content-sha256": "1111",
                [APIG_RESIGN_HEADER]: APIG_RESIGN_SCHEME,
                [APIG_RESIGN_CREDENTIAL_HEADER]: encodeApigCredential(CRED),
                "x-acp-session": "resign-e2e-1",
            },
            body: chatBody("glm-5.3-flash", "resign-e2e-1"),
        });
        assert.equal(r.status, 200, `upstream accepted the re-signed body: ${await r.text()}`);
        assert.equal(calls.length, 1);
        const up = calls[0];
        assert.notEqual(up.headers["authorization"], staleAuth, "stale client signature replaced at egress");
        assert.equal(up.headers[APIG_RESIGN_HEADER], undefined, "loopback arm marker stripped before egress");
        assert.equal(up.headers[APIG_RESIGN_CREDENTIAL_HEADER], undefined, "credential marker NEVER reaches the wire");
        assert.equal(up.headers["maas_type"], "benefit", "benefit model carries the signed maas_type");
        assert.match(String(up.headers["authorization"]), /Access=AKTEST123/, "re-signed with the tunneled credential");
    } finally {
        proxy.close();
        (proxy as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        upstream.close();
        upstream.closeAllConnections?.();
    }
});

test("e2e #1884: signed without the arm → byte-untouched passthrough (#1886 twin)", async () => {
    const { server: upstream, port: upstreamPort, calls } = await startVerifyingUpstream(CRED.sk);
    const { proxy, port: proxyPort } = await startResignProxy(upstreamPort);
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const staleAuth = "SDK-HMAC-SHA256 Access=CLIENT,SignedHeaders=host;x-sdk-content-sha256;x-sdk-date,Signature=0000";
        // client signs its OWN body with its OWN (client-side) key — an
        // independent signature the verifying upstream accepts as-is
        const bodyStr = chatBody("deepseek-v4.1-flash", "signed-passthrough-1");
        const clientHeaders: Record<string, string> = { "content-type": "application/json", "x-sdk-date": "20261002T120000Z" };
        signApigHeaders(clientHeaders, { ak: "CLIENT", sk: CRED.sk }, "POST", `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, Buffer.from(bodyStr, "utf8"), { now: new Date("2026-10-02T12:00:00.000Z") });
        const r = await fetch(url, { method: "POST", headers: clientHeaders, body: bodyStr });
        assert.equal(r.status, 200, `original signature stays valid because bytes are untouched: ${await r.text()}`);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.toString("utf8"), bodyStr, "body forwarded byte-for-byte (no injection, no rewrite)");
        assert.equal(String(calls[0].headers["authorization"]), clientHeaders["authorization"], "client signature preserved");
    } finally {
        proxy.close();
        (proxy as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        upstream.close();
        upstream.closeAllConnections?.();
    }
});
