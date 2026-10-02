import { createHash, createHmac } from "node:crypto";

/**
 * #1884 (CodeArts APIG): requests signed with SDK-HMAC-SHA256 carry a
 * signature over the exact request bytes. bili's pipeline rewrites bodies
 * (compression, compat), which invalidates the inbound signature — the
 * upstream then rejects every rewritten request with 401 (APIG.0301 body
 * hash mismatch). The native lane tunnels these requests with a re-sign
 * arm instead: the dsh credential service supplies the signing credential
 * via `x-bili-resign` / `x-bili-resign-credential` markers, and every
 * egress body bili produces (initial forward, role-ladder retry, overflow
 * refold, compress-loop rounds, degenerate continuation refetch) is
 * re-signed here before it hits the wire.
 *
 * The signer is a byte-exact port of the CodeArts plugin's signRequestHuawei
 * (dsh codearts plugin src/sign.ts — itself aligned with the Rust reference
 * implementation `sign_request_huawei`): same canonical-request layout, same
 * date format, same header set. Verified by the hermetic mock upstream in
 * tests/apig-resign.test.ts which validates signatures with the ak/sk it
 * issued.
 *
 * Kill switch: BILI_RESIGN=0 disables both the native-lane arming and the
 * server-side re-sign (signed traffic then rides the #1886 direct fallback /
 * byte-untouched passthrough).
 *
 * Credential refresh is intentionally NOT ported: the plugin refreshes its
 * own credentials; when they expire, the upstream 401 is visible and the
 * plugin's next successful refresh re-arms a fresh credential.
 */

/** Internal marker headers (loopback only — stripped before egress). */
export const APIG_RESIGN_HEADER = "x-bili-resign";
export const APIG_RESIGN_CREDENTIAL_HEADER = "x-bili-resign-credential";
/** Marker value for the scheme this module can re-sign. */
export const APIG_RESIGN_SCHEME = "sdk-hmac-sha256";

/** The minimal signing credential (subset of the plugin's CodeArtsCredential). */
export interface ApigCredential {
    ak: string;
    sk: string;
    /** Temporary-credential security token; empty string for permanent keys. */
    token?: string;
}

/** Benefit (free-quota) models require the signed `maas_type: benefit` header
 *  (InferHub.002002009.404 "model is not registered" otherwise). Static
 *  fallback mirrors the plugin's CODEARTS_BENEFIT_FALLBACK; override with
 *  BILI_RESIGN_BENEFIT (comma-separated model list). */
const DEFAULT_BENEFIT_MODELS = ["glm-5.3-flash", "deepseek-v4.1-flash"];

export function apigBenefitModels(): Set<string> {
    const raw = process.env.BILI_RESIGN_BENEFIT;
    if (raw !== undefined && raw.trim() !== "") {
        return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
    }
    return new Set(DEFAULT_BENEFIT_MODELS);
}

export function resignEnabled(): boolean {
    return process.env.BILI_RESIGN !== "0";
}

function sha256Hex(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function hmacSha256Hex(key: Uint8Array, data: Uint8Array): string {
    return createHmac("sha256", key).update(data).digest("hex");
}

/** Body-covering signature schemes we can detect on the wire. */
const BODY_SIGNED_AUTH = /^(?:SDK-HMAC-SHA256|AWS4-HMAC-SHA256|HMAC-SHA256)\b/i;

/** Detect a body-covering signature from request headers (lowercased keys,
 *  as node delivers them). Returns the scheme token or undefined. */
export function inboundSignedScheme(headers: Record<string, string | string[] | undefined>): string | undefined {
    const auth = String(headers["authorization"] ?? "").trim();
    const match = BODY_SIGNED_AUTH.exec(auth);
    if (match !== null) return match[0].toLowerCase();
    if (headers["x-sdk-content-sha256"] !== undefined) return "x-sdk-content-sha256";
    if (headers["x-amz-content-sha256"] !== undefined) return "x-amz-content-sha256";
    return undefined;
}

/** Decode the loopback credential marker. Tolerates malformed payloads by
 *  returning undefined — a broken marker degrades to the direct fallback,
 *  never to a thrown error mid-dispatch. */
export function decodeApigCredential(encoded: string | undefined): ApigCredential | undefined {
    if (typeof encoded !== "string" || encoded === "") return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
        const ak = typeof parsed["ak"] === "string" ? parsed["ak"] : undefined;
        const sk = typeof parsed["sk"] === "string" ? parsed["sk"] : undefined;
        if (ak === undefined || sk === undefined || ak === "" || sk === "") return undefined;
        const token = typeof parsed["token"] === "string" ? parsed["token"] : "";
        return { ak, sk, token };
    } catch {
        return undefined;
    }
}

export function encodeApigCredential(cred: ApigCredential): string {
    return Buffer.from(JSON.stringify({ ak: cred.ak, sk: cred.sk, token: cred.token ?? "" }), "utf8").toString("base64");
}

/** Header names this signer owns on the egress request. All forms are
 *  removed (case-insensitively) before re-signing so a rewrite can never
 *  leak the previous round's stale signature as a duplicate header. */
const SIGNED_HEADER_NAMES = new Set([
    "authorization",
    "x-sdk-date",
    "x-sdk-content-sha256",
    "x-security-token",
    "maas_type",
]);

function deleteSignedHeaders(target: Record<string, string>): void {
    for (const key of Object.keys(target)) {
        if (SIGNED_HEADER_NAMES.has(key.toLowerCase())) delete target[key];
    }
}

function apigDateStamp(now: Date): string {
    return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface ApigSignOptions {
    /** Extra headers that join the signature (e.g. `maas_type: benefit`). */
    extraSignedHeaders?: Record<string, string>;
    /** Clock injection for deterministic tests. */
    now?: Date;
}

/** Sign `body` for `urlStr` into `target` (mutated in place). Byte-exact
 *  port of the plugin's signRequestHuawei: canonical request over the
 *  sorted signed-header set, `SDK-HMAC-SHA256\n<date>\n<canonical-hash>`
 *  string-to-sign, HMAC-SHA256 with the secret key. Always includes
 *  `x-security-token` (empty for permanent keys — the plugin does the same)
 *  and `content-type: application/json` on non-GET requests. */
export function signApigHeaders(
    target: Record<string, string>,
    cred: ApigCredential,
    method: string,
    urlStr: string,
    body: Uint8Array,
    opts: ApigSignOptions = {},
): void {
    const url = new URL(urlStr);
    let uri = url.pathname;
    if (!uri.endsWith("/")) uri += "/";
    const query = url.search.slice(1);
    const dateStamp = apigDateStamp(opts.now ?? new Date());
    const payloadHash = sha256Hex(body);

    const signed = new Map<string, string>();
    signed.set("host", url.host);
    signed.set("x-sdk-date", dateStamp);
    signed.set("x-sdk-content-sha256", payloadHash);
    signed.set("x-security-token", cred.token ?? "");
    if (opts.extraSignedHeaders !== undefined) {
        for (const [key, value] of Object.entries(opts.extraSignedHeaders)) signed.set(key, value);
    }
    if (method.toUpperCase() !== "GET") signed.set("content-type", "application/json");

    const names = [...signed.keys()].sort();
    const canonicalRequest = [
        method.toUpperCase(),
        uri,
        query,
        names.map((k) => `${k}:${signed.get(k) ?? ""}`).join("\n"),
        "",
        names.join(";"),
        payloadHash,
    ].join("\n");
    const canonicalHash = sha256Hex(Buffer.from(canonicalRequest, "utf8"));
    const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
    const signature = hmacSha256Hex(Buffer.from(cred.sk, "utf8"), Buffer.from(stringToSign, "utf8"));

    deleteSignedHeaders(target);
    target["host"] = url.host;
    target["x-sdk-date"] = dateStamp;
    target["x-sdk-content-sha256"] = payloadHash;
    target["x-security-token"] = cred.token ?? "";
    if (opts.extraSignedHeaders !== undefined) {
        for (const [key, value] of Object.entries(opts.extraSignedHeaders)) target[key] = value;
    }
    if (method.toUpperCase() !== "GET") target["content-type"] = "application/json";
    target["authorization"] = `SDK-HMAC-SHA256 Access=${cred.ak},SignedHeaders=${names.join(";")},Signature=${signature}`;
}

/** Extract the request model from a wire body JSON (best effort — used to
 *  resolve the benefit set for `maas_type`). */
export function modelOfJsonBody(body: string): string | undefined {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return typeof parsed["model"] === "string" ? parsed["model"] : undefined;
    } catch {
        return undefined;
    }
}

/** Convenience: sign `target` for `body`, adding `maas_type: benefit` when
 *  the request's model is in the benefit set. */
export function resignApig(
    target: Record<string, string>,
    cred: ApigCredential,
    method: string,
    urlStr: string,
    body: string | Buffer,
    now?: Date,
): void {
    const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const model = modelOfJsonBody(bodyBuf.toString("utf8"));
    const benefit = model !== undefined && apigBenefitModels().has(model.toLowerCase());
    signApigHeaders(target, cred, method, urlStr, bodyBuf, {
        extraSignedHeaders: benefit ? { maas_type: "benefit" } : undefined,
        now,
    });
}
