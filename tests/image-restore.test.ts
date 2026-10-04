import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicToCore, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { createInitialState } from "acp-kernel";
import {
    buildIncomingImageIndex,
    describeRestorable,
    messageImageBytes,
    writeRestoredImage,
    type RestorableImage,
} from "../src/image-restore.ts";
import { resolveDecompress, type ProxyToolCtx } from "../src/decompress-shared.ts";
import type { WireProtocol } from "../src/util.js";

// Isolate stateDir() (hence restoreExportDir()) under a throwaway dir before any
// write. node --test gives each file its own process, so the env mutation is safe.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bili-img-restore-"));

// A valid 1x1 PNG so decodeImageDims() resolves real dimensions.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngImg: RestorableImage = { mediaType: "image/png", b64: PNG, bytes: Buffer.byteLength(PNG, "base64") };
const dataUrl = `data:image/png;base64,${PNG}`;

// Each wire converter has a distinct concrete signature; the test drives them
// uniformly on already-shaped bodies, so they are widened at the single call
// site below rather than forced into one callable type here.
const TO_CORE = {
    anthropic: anthropicToCore,
    openai: openaiToCore,
    responses: responsesToCore,
    google: googleToCore,
};
function coreMsgs(r: unknown): Array<{ id?: string }> {
    const m = Array.isArray(r) ? r : (r as { msgs?: unknown }).msgs;
    return (Array.isArray(m) ? m : []) as Array<{ id?: string }>;
}
// Run the protocol parser, assign each produced core message a deterministic ref
// (m00001..), then build the index. excludeImaged leaves imaged messages unref'd to
// exercise the "unref'd tail messages are skipped" path.
function buildIndex(proto: WireProtocol, body: unknown, excludeImaged = false) {
    const conv = TO_CORE[proto] as unknown as (b: unknown) => unknown;
    const msgs = coreMsgs(conv(body));
    const state = createInitialState();
    msgs.forEach((m, i) => {
        if (!m.id) return;
        if (excludeImaged && messageImageBytes(m as never).length > 0) return;
        state.messageRefs.byRaw[m.id] = `m${String(i + 1).padStart(5, "0")}`;
    });
    return buildIncomingImageIndex(body, proto, state);
}
function ctxWith(index: Map<string, RestorableImage[]> | undefined): ProxyToolCtx {
    // Only the imageRef branch of resolveDecompress is exercised here; it touches
    // nothing but session.incomingImageIndex and log, so a minimal ctx suffices.
    return { session: { incomingImageIndex: index }, log: () => undefined } as unknown as ProxyToolCtx;
}

test("messageImageBytes: extracts base64 across all four wire sidecars", () => {
    const anthro = messageImageBytes({ rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } } } as never);
    assert.equal(anthro.length, 1);
    assert.equal(anthro[0].b64, PNG);
    assert.equal(anthro[0].mediaType, "image/png");

    const anthroUrl = messageImageBytes({ rawAnthropicBlock: { type: "image", source: { type: "url", url: dataUrl } } } as never);
    assert.equal(anthroUrl.length, 1);
    assert.equal(anthroUrl[0].b64, PNG);

    // A tool_result block shares the sidecar field but is not an image.
    assert.deepEqual(messageImageBytes({ rawAnthropicBlock: { type: "tool_result", content: [] } } as never), []);

    const oaMulti = messageImageBytes({ rawOpenaiContentParts: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: dataUrl } }] } as never);
    assert.equal(oaMulti.length, 1);
    assert.equal(oaMulti[0].b64, PNG);

    const resp = messageImageBytes({ rawResponsesItem: { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: dataUrl }] } } as never);
    assert.equal(resp.length, 1);
    assert.equal(resp[0].b64, PNG);

    const g = messageImageBytes({ rawGoogleParts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: PNG } }] } as never);
    assert.equal(g.length, 1);
    assert.equal(g[0].b64, PNG);

    // Singular fallback: the shared imageBase64 sidecar.
    const single = messageImageBytes({ imageBase64: PNG, imageMediaType: "image/jpeg" } as never);
    assert.equal(single.length, 1);
    assert.equal(single[0].mediaType, "image/jpeg");

    // Plain text carries nothing.
    assert.deepEqual(messageImageBytes({ role: "user", text: "hello" } as never), []);
});

test("messageImageBytes: multi-image yields every part, not just the first", () => {
    const two = messageImageBytes({ rawGoogleParts: [{ inlineData: { mimeType: "image/png", data: PNG } }, { inlineData: { mimeType: "image/gif", data: PNG } }] } as never);
    assert.equal(two.length, 2);
    assert.equal(two[0].mediaType, "image/png");
    assert.equal(two[1].mediaType, "image/gif");
});

test("buildIncomingImageIndex: indexes carried images by mNNNNN ref (all protocols)", () => {
    const openai = buildIndex("openai", { model: "gpt", messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: dataUrl } }] },
        { role: "assistant", content: "ok" },
    ] });
    assert.equal(openai.size, 1, "exactly one imaged message indexed");
    const [ref, imgs] = [...openai.entries()][0];
    assert.match(ref, /^m\d+$/);
    assert.equal(imgs[0].b64, PNG);

    // Anthropic splits a multi-block message into one core msg per block; only the
    // image block is indexed.
    const anthro = buildIndex("anthropic", { model: "claude", messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ] });
    assert.equal(anthro.size, 1);
    assert.equal([...anthro.values()][0][0].b64, PNG);

    const responses = buildIndex("responses", { model: "gpt", input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: dataUrl }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ] });
    assert.equal(responses.size, 1);
    assert.equal([...responses.values()][0][0].b64, PNG);

    const google = buildIndex("google", { contents: [{ role: "user", parts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: PNG } }] }] });
    assert.equal(google.size, 1);
    assert.equal([...google.values()][0][0].b64, PNG);
});

test("buildIncomingImageIndex: skips unref'd tail messages and image-free bodies", () => {
    const body = { model: "gpt", messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
        { role: "assistant", content: "ok" },
    ] };
    // Leave the imaged message unref'd -> nothing recoverable even though an image is present.
    assert.equal(buildIndex("openai", body, true).size, 0);
    // No images at all -> empty.
    assert.equal(buildIndex("openai", { model: "gpt", messages: [{ role: "user", content: "plain" }] }).size, 0);
});

test("describeRestorable: one line per image, sorted, capped", () => {
    const idx = new Map<string, RestorableImage[]>([
        ["m00005", [pngImg, { ...pngImg, mediaType: "image/gif" }]],
        ["m00002", [pngImg]],
    ]);
    const lines = describeRestorable(idx);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^m00002 \[png 1x1 · \d+KB\]$/);
    assert.match(lines[1], /^m00005 \[png 1x1 · \d+KB\]$/);
    assert.match(lines[2], /^m00005\[-1\] \[gif 1x1 · \d+KB\]$/);
    assert.equal(describeRestorable(idx, 1).length, 1, "cap honored");
});

test("writeRestoredImage: writes decoded bytes 0600 under retrieve/img, idempotent", () => {
    const p = writeRestoredImage("m00042", 0, pngImg);
    assert.ok(p && p.endsWith(join("retrieve", "img", "m00042.png")), `path ${p}`);
    assert.ok(existsSync(p!));
    assert.deepEqual(readFileSync(p!), Buffer.from(PNG, "base64"), "decoded bytes round-trip");
    assert.equal(statSync(p!).mode & 0o777, 0o600, "not world-readable");
    // Multi-image suffix + extension mapping.
    const p2 = writeRestoredImage("m00042", 1, pngImg);
    assert.ok(p2!.endsWith("m00042-1.png"));
    const jpg = writeRestoredImage("m00042", 0, { ...pngImg, mediaType: "image/jpeg" });
    assert.ok(jpg!.endsWith("m00042.jpg"));
    // Idempotent rewrite of identical bytes.
    assert.equal(writeRestoredImage("m00042", 0, pngImg), p);
});

test("resolveDecompress({ imageRef }): lists, restores to file, and reports misses", () => {
    const idx = new Map<string, RestorableImage[]>([["m00042", [pngImg]]]);
    const list = resolveDecompress({ imageRef: "list" }, ctxWith(idx));
    assert.match(list, /\[Restorable images \(1\):\]/);
    assert.match(list, /m00042/);

    const restored = resolveDecompress({ imageRef: "m00042" }, ctxWith(idx));
    assert.match(restored, /Restored 1 image\(s\) for m00042/);
    const pathMatch = restored.match(/(\S*m00042\.png)/);
    assert.ok(pathMatch && existsSync(pathMatch[1]), "restored file exists");
    assert.deepEqual(readFileSync(pathMatch![1]), Buffer.from(PNG, "base64"));

    assert.match(resolveDecompress({ imageRef: "m99999" }, ctxWith(idx)), /no restorable image for ref "m99999"/);
    assert.match(resolveDecompress({ imageRef: "" }, ctxWith(idx)), /\[Restorable images \(1\):\]/, "empty string == list");
    assert.match(resolveDecompress({ imageRef: "list" }, ctxWith(undefined)), /No restorable images right now/, "absent index degrades gracefully");
});
