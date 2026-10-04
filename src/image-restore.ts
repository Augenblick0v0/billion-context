// #1995: recovery channel for stripImages. Stripping drops historical image
// parts with no trace left behind — decompress is text-only and image_full only
// covers downsampled originals (#1095), so once an image is stripped the model
// can never see those pixels again. The client re-sends full raw history every
// turn, so the original bytes are always present in the incoming request; this
// module indexes them by kernel-assigned mNNNNN ref (via each message's stable
// id) so decompress({ imageRef }) can pull a specific image back. Delivery is
// file-first (a host-readable path the model opens with its read tool) — uniform
// across all four wires, no per-protocol inline-image rendering required.
//
// Scope note: this only recovers images bili itself can see in the inbound
// request. A plugin-mode agent that folded an image away in its OWN local store
// sends no such bytes to the proxy, so those belong to the agent's in-process
// recovery (cf. billion-context-pi#594), not here.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    anthropicToCore,
    googleToCore,
    openaiToCore,
    parseDataUrl,
    responsesToCore,
    type AnthropicRequestBody,
    type BiliMessage,
    type GoogleRequestBody,
    type OpenAIRequestBody,
    type ResponsesRequestBody,
} from "acp-kernel/wire";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { stateDir } from "./paths.js";
import { decodeImageDims } from "./image-tokens.js";
import type { WireProtocol } from "./util.js";

/** One recoverable image: base64 payload plus enough metadata to name the file
 *  and describe it. `bytes` is the DECODED length (base64 length × 3/4), not the
 *  b64 string length. */
export interface RestorableImage {
    mediaType: string;
    b64: string;
    bytes: number;
}

/** A spilled image as retained in the session index: metadata plus the on-disk
 *  path, but NO base64 — the bytes live in the file, so a long image-heavy
 *  session pins only O(refs) of metadata in memory instead of every pixel
 *  (unbounded-residency finding from the #1995 review). */
export interface IndexedImage {
    mediaType: string;
    bytes: number;
    width?: number;
    height?: number;
    path: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function dataUrlRef(url: unknown): { mediaType?: string; b64?: string } | undefined {
    if (typeof url !== "string") return undefined;
    const d = parseDataUrl(url);
    return d ? { mediaType: d.mediaType, b64: d.base64 } : undefined;
}

function b64Bytes(b64: string): number {
    return Math.floor((Buffer.byteLength(b64, "base64") || 0));
}

/** The base64 images this core message carries, in wire order, across all four
 *  protocols (anthropic / openai / responses / google). URL-sourced images whose
 *  bytes we cannot obtain (non-data URLs) yield no entry — only carryable
 *  base64 payloads are indexed. Returns [] for plain-text messages (the common
 *  case). */
export function messageImageBytes(m: CoreMessage): RestorableImage[] {
    const mm = m as BiliMessage;
    const out: RestorableImage[] = [];
    // Anthropic: each image block becomes its own core message; the same sidecar
    // field also carries structured tool_results, so gate on type === "image".
    const ab = mm.rawAnthropicBlock;
    if (isObj(ab) && ab.type === "image") {
        const s = ab.source;
        const mediaType = isObj(s) && typeof s.media_type === "string" ? s.media_type : "image/png";
        if (isObj(s)) {
            if (s.type === "base64" && typeof s.data === "string") {
                out.push({ mediaType, b64: s.data, bytes: b64Bytes(s.data) });
            } else if (s.type === "url") {
                const r = dataUrlRef(s.url);
                if (r?.b64) out.push({ mediaType: r.mediaType ?? mediaType, b64: r.b64, bytes: b64Bytes(r.b64) });
            }
        }
        return out;
    }
    // Responses: the original item keeps every input_image part (the singular
    // imageBase64 sidecar covers only the first), so walk the item's content.
    const ri = mm.rawResponsesItem;
    if (isObj(ri) && Array.isArray(ri.content)) {
        for (const part of ri.content) {
            if (!isObj(part) || part.type !== "input_image") continue;
            const u = isObj(part.image_url) ? part.image_url.url : part.image_url;
            const r = dataUrlRef(u);
            if (r?.b64) out.push({ mediaType: r.mediaType ?? "image/png", b64: r.b64, bytes: b64Bytes(r.b64) });
        }
        if (out.length > 0) return out;
    }
    // Multi-part sources come FIRST: the shared singular imageBase64 sidecar is
    // set by every protocol for a single data-URL image, so checking it earlier
    // would shadow the multi-part fields and drop every image after the first.
    // Google: inlineData parts (raw base64 in .data, mime in .mimeType).
    if (Array.isArray(mm.rawGoogleParts)) {
        for (const part of mm.rawGoogleParts as unknown[]) {
            if (!isObj(part)) continue;
            const inline = part.inlineData;
            if (isObj(inline) && typeof inline.data === "string") {
                const mediaType = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
                out.push({ mediaType, b64: inline.data, bytes: b64Bytes(inline.data) });
            }
        }
        if (out.length > 0) return out;
    }
    // OpenAI chat: multi-image → rawOpenaiContentParts; a lone image_url may also
    // sit in rawOpenaiContent.
    if (Array.isArray(mm.rawOpenaiContentParts)) {
        for (const p of mm.rawOpenaiContentParts) {
            if (!isObj(p) || p.type !== "image_url") continue;
            const u = isObj(p.image_url) ? p.image_url.url : undefined;
            const r = dataUrlRef(u);
            if (r?.b64) out.push({ mediaType: r.mediaType ?? "image/png", b64: r.b64, bytes: b64Bytes(r.b64) });
        }
        if (out.length > 0) return out;
    }
    if (isObj(mm.rawOpenaiContent) && mm.rawOpenaiContent.type === "image_url") {
        const u = isObj(mm.rawOpenaiContent.image_url) ? mm.rawOpenaiContent.image_url.url : undefined;
        const r = dataUrlRef(u);
        if (r?.b64) out.push({ mediaType: r.mediaType ?? "image/png", b64: r.b64, bytes: b64Bytes(r.b64) });
        if (out.length > 0) return out;
    }
    // Singular fallback: the shared imageBase64 sidecar (one data-URL image).
    if (typeof mm.imageBase64 === "string") {
        out.push({ mediaType: typeof mm.imageMediaType === "string" ? mm.imageMediaType : "image/png", b64: mm.imageBase64, bytes: b64Bytes(mm.imageBase64) });
    }
    return out;
}

/** Extract the core-message array from a protocol toCore() result, tolerating
 *  both `{ msgs }` object returns and bare arrays. Returns undefined when the
 *  shape is unrecognized (caller degrades to an empty index). */
function coreMsgsOf(result: unknown): CoreMessage[] | undefined {
    if (Array.isArray(result)) return result as CoreMessage[];
    if (isObj(result) && Array.isArray((result as { msgs?: unknown }).msgs)) {
        return (result as { msgs: CoreMessage[] }).msgs;
    }
    return undefined;
}

/** Parse the INBOUND wire body into core messages and index every carried image
 *  by its mNNNNN ref. A message is indexed only when it is already known to the
 *  session (`state.messageRefs.byRaw[message.id]` resolves) — brand-new tail
 *  messages have no ref yet and sit inside the keep window anyway, so they are
 *  never strip targets. Returns an empty map when nothing is recoverable (no
 *  images, no refs, or an unparseable body). */
export function buildIncomingImageIndex(
    parsed: unknown,
    protocol: WireProtocol,
    state: CompressionState,
): Map<string, IndexedImage[]> {
    const index = new Map<string, IndexedImage[]>();
    const byRaw = state?.messageRefs?.byRaw;
    if (!byRaw) return index;
    let result: unknown;
    try {
        switch (protocol) {
            case "anthropic": result = anthropicToCore(parsed as AnthropicRequestBody); break;
            case "openai": result = openaiToCore(parsed as OpenAIRequestBody); break;
            case "google": result = googleToCore(parsed as GoogleRequestBody); break;
            case "responses": result = responsesToCore(parsed as ResponsesRequestBody); break;
        }
    } catch {
        return index;
    }
    const msgs = coreMsgsOf(result);
    if (!msgs) return index;
    for (const m of msgs) {
        const ref = m.id ? byRaw[m.id] : undefined;
        if (!ref) continue;
        const imgs = messageImageBytes(m);
        if (imgs.length === 0) continue;
        const arr = index.get(ref) ?? [];
        if (!index.has(ref)) index.set(ref, arr);
        imgs.forEach((im, i) => {
            // #1995 review: spill at index-time so the session retains only
            // metadata + path (never base64). Skip-if-exists keeps the steady
            // state to one stat per image per turn, not a full decode + write.
            const path = writeRestoredImage(ref, i, im);
            if (!path) return;
            let width: number | undefined;
            let height: number | undefined;
            try {
                const d = decodeImageDims(im.b64);
                if (d) { width = d.w; height = d.h; }
            } catch {}
            arr.push({ mediaType: im.mediaType, bytes: im.bytes, width, height, path });
        });
    }
    return index;
}

function refNum(ref: string): number {
    const m = /^m(\d+)$/i.exec(ref.trim());
    return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Human-readable one-line-per-image listing of what is currently restorable
 *  ("m00042 [png 1024x768 · 240KB]"), sorted by ref then position. Capped so a
 *  very image-heavy history cannot blow up the tool result. */
export function describeRestorable(index: Map<string, IndexedImage[]>, cap = 50): string[] {
    const lines: string[] = [];
    const refs = [...index.keys()].sort((a, b) => refNum(a) - refNum(b));
    outer: for (const ref of refs) {
        const imgs = index.get(ref)!;
        for (let i = 0; i < imgs.length; i++) {
            const im = imgs[i];
            let note = im.mediaType.includes("/") ? im.mediaType.split("/").pop()! : im.mediaType;
            if (im.width != null && im.height != null) note += ` ${im.width}x${im.height}`;
            note += ` · ${Math.max(1, Math.round(im.bytes / 1024))}KB`;
            lines.push(`${ref}${i > 0 ? `[-${i}]` : ""} [${note}]`);
            if (lines.length >= cap) break outer;
        }
    }
    return lines;
}

/** Directory restored images are written to: <stateDir>/retrieve/img/, sharing
 *  the CCR retrieve tree so operators find both under one place. */
export function restoreExportDir(): string {
    return join(stateDir(), "retrieve", "img");
}

function extFor(mediaType: string): string {
    const sub = (mediaType.split("/")[1] ?? "").toLowerCase();
    const map: Record<string, string> = { png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp", svg: "svg" };
    return map[sub] ?? "img";
}

/** Write one restorable image to disk (decoded bytes, 0600 — conversation
 *  content is not world-readable on multi-user hosts) and return its absolute
 *  path. Content-addressed by ref (+index); a repeated call skips the rewrite
 *  when the file is already present (idempotent). Returns null on write failure. */
export function writeRestoredImage(ref: string, idx: number, img: RestorableImage): string | null {
    const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, "-");
    const dir = restoreExportDir();
    const path = join(dir, `${safeRef}${idx > 0 ? `-${idx}` : ""}.${extFor(img.mediaType)}`);
    try {
        if (existsSync(path)) return path;
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, Buffer.from(img.b64, "base64"), { mode: 0o600 });
        return path;
    } catch (e) {
        loggerLog("warn", `[image-restore] write failed (${path}): ${String(e)}`);
        return null;
    }
}
