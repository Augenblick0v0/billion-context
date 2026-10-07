import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    coreMessagesFor,
    foldAnchoredCutoff,
    messageImageBytes,
    pruneRetrieveImgExports,
    restoreExportDir,
    restoreExportDirName,
} from "../src/image-restore.ts";
import { imagePlaceholdersForSummary } from "../src/image-note.ts";
import type { CompressionState, Config, CoreMessage } from "acp-kernel";

const antTxt = (t: string) => ({ type: "text", text: t });
const antImg = () => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
});

function bodyOf(...contents: unknown[]) {
    return { model: "claude", messages: contents.map((content) => ({ role: "user", content })) };
}

function stateWithCovers(ids: string[]): CompressionState {
    return {
        blocks: [{ blockId: "b1", effectiveMessageIds: ids, active: true }],
    } as unknown as CompressionState;
}

test("foldAnchoredCutoff: full boundary → cutoff just past the last covered wire message", () => {
    const body = bodyOf([antTxt("a")], [antTxt("b")], [antTxt("c")], [antTxt("d")]);
    const msgs = coreMessagesFor(body, "anthropic")!;
    assert.equal(msgs.length, 4);
    const cutoff = foldAnchoredCutoff(body, "anthropic", stateWithCovers([msgs[0].id, msgs[1].id]));
    assert.equal(cutoff, 2);
});

test("foldAnchoredCutoff: partially-covered boundary wire message (live image) is NOT stripped", () => {
    // Wire message 2 flattens to [text, image]; the fold covers the text but
    // the image is a media gap — stripping wire 2 would strip a LIVE image.
    const body = bodyOf([antTxt("a")], [antTxt("b")], [antTxt("c"), antImg()], [antTxt("d")]);
    const msgs = coreMessagesFor(body, "anthropic")!;
    assert.equal(msgs.length, 5); // a, b, c, image, d
    const ids = [msgs[0].id, msgs[1].id, msgs[2].id]; // fold covers a, b, c — stops at the image gap
    const cutoff = foldAnchoredCutoff(body, "anthropic", stateWithCovers(ids));
    assert.equal(cutoff, 2); // wire 2 stays intact
});

test("foldAnchoredCutoff: no active folds / other protocols → undefined (sliding fallback)", () => {
    const body = bodyOf([antTxt("a")], [antTxt("b")]);
    const empty = { blocks: [] } as unknown as CompressionState;
    assert.equal(foldAnchoredCutoff(body, "anthropic", empty), undefined);
    const inactive = {
        blocks: [{ blockId: "b1", effectiveMessageIds: ["x"], active: false }],
    } as unknown as CompressionState;
    assert.equal(foldAnchoredCutoff(body, "anthropic", inactive), undefined);
    const oai = { model: "gpt", messages: [{ role: "user", content: "hi" }] };
    assert.equal(foldAnchoredCutoff(oai, "openai", stateWithCovers(["whatever"])), undefined);
});

test("foldAnchoredCutoff: covered ids the client no longer sends anchor from the rest", () => {
    const body = bodyOf([antTxt("a")], [antTxt("b")], [antTxt("c")]);
    const msgs = coreMessagesFor(body, "anthropic")!;
    // a deleted remotely, b still covered → still anchors at wire 1
    const cutoff = foldAnchoredCutoff(body, "anthropic", stateWithCovers(["h_gone", msgs[1].id]));
    assert.equal(cutoff, 2);
});

test("foldAnchoredCutoff + stripHistoricalImages: stripped prefix byte-stable across turns", async () => {
    // The cache-stability contract end-to-end: same body + same anchor two
    // turns in a row (client re-sends identical history plus one new tail)
    // → stripped messages 0..cutoff-1 serialize identically.
    const base = bodyOf([antTxt("a"), antImg()], [antImg()], [antTxt("c"), antImg()]);
    const msgs = coreMessagesFor(base, "anthropic")!;
    const state = stateWithCovers(msgs.filter((m) => m.wireIndex !== undefined && m.wireIndex < 2).map((m) => m.id)); // covers wires 0 and 1
    const cutoff = foldAnchoredCutoff(base, "anthropic", state);
    assert.equal(cutoff, 2);

    const { stripHistoricalImages } = await import("acp-kernel/wire");
    const t0 = stripHistoricalImages(base, "anthropic", 1, { cutoffIndex: cutoff });
    const t1Body = {
        ...base,
        messages: [...base.messages, { role: "user" as const, content: [antTxt("d")] }],
    };
    const t1 = stripHistoricalImages(t1Body, "anthropic", 1, { cutoffIndex: cutoff });
    assert.equal(
        JSON.stringify((t0.body as { messages: unknown[] }).messages.slice(0, cutoff)),
        JSON.stringify((t1.body as { messages: unknown[] }).messages.slice(0, cutoff)),
    );
});

test("pruneRetrieveImgExports: removes files older than TTL, keeps fresh ones, drops emptied dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-prune-"));
    process.env.XDG_STATE_HOME = dir;
    try {
        const sid = "prune-test";
        const target = restoreExportDir(sid);
        mkdirSync(target, { recursive: true });
        const fresh = join(target, "m00001.png");
        const stale = join(target, "m00002.png");
        writeFileSync(fresh, "fresh");
        writeFileSync(stale, "stale");
        const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        utimesSync(stale, old, old);
        const removed = pruneRetrieveImgExports(sid, 7 * 24 * 3600 * 1000);
        assert.equal(removed, 1);
        assert.ok(!existsSync(stale));
        assert.ok(existsSync(fresh));
        // Dir still holds the fresh file → survives.
        assert.ok(existsSync(target));
        // Backdate the survivor and tighten the TTL — deterministic instead of
        // racing wall-clock milliseconds.
        utimesSync(fresh, old, old);
        const removed2 = pruneRetrieveImgExports(sid, 7 * 24 * 3600 * 1000 + 1);
        assert.equal(removed2, 1);
        assert.ok(!existsSync(target));
    } finally {
        delete process.env.XDG_STATE_HOME;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("imagePlaceholdersForSummary: appends the ref, degrades without one", () => {
    const m = {
        id: "x",
        role: "user" as const,
        contentType: "text" as const,
        text: "[image]",
        rawAnthropicBlock: {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
    };
    assert.deepEqual(imagePlaceholdersForSummary(m, "m00042"), ["[image: png · m00042]"]);
    assert.deepEqual(imagePlaceholdersForSummary(m, undefined), ["[image: png]"]);
});

test("restoreExportDirName: sanitizer collisions are salted apart; pure ids keep their historical name (#1995 review ①)", () => {
    assert.equal(restoreExportDirName("plain-session"), "plain-session", "no sanitizer change → no salt");
    const slash = restoreExportDirName("a/b");
    const dash = restoreExportDirName("a-b");
    assert.notEqual(slash, dash, "'a/b' and 'a-b' must not share a spill dir");
    assert.match(slash, /^a-b-[0-9a-f]{8}$/);
    assert.equal(dash, "a-b", "already-safe ids keep their historical unsalted name");
    assert.equal(slash, restoreExportDirName("a/b"), "salt is deterministic across restarts");
    const long = "L".repeat(120);
    assert.match(restoreExportDirName(long), /^L{100}-[0-9a-f]{8}$/, "truncation also salts");
});

test("messageImageBytes: mirrors the Gemini-3 $ref guard — ref-pointed parts are not indexed (#1995 review ⑤)", () => {
    const imgPart = { inlineData: { mimeType: "image/png", data: "QUJD" } };
    const bodyOf = (response: unknown) => ({
        model: "gemini",
        contents: [{ role: "user", parts: [{ functionResponse: { name: "shot", response, parts: [imgPart] } }] }],
    });
    const guarded = coreMessagesFor(bodyOf({ $ref: "part_0" }), "google")!;
    const guardedCarrier = guarded.find((m) => Array.isArray((m as { rawGoogleParts?: unknown }).rawGoogleParts));
    assert.ok(guardedCarrier, "google wire produced a sidecar-carrying core message");
    assert.equal(messageImageBytes(guardedCarrier).length, 0, "$ref-pointed response parts are skipped (strip side keeps them)");
    const plain = coreMessagesFor(bodyOf({ ok: true }), "google")!;
    const plainCarrier = plain.find((m) => Array.isArray((m as { rawGoogleParts?: unknown }).rawGoogleParts));
    assert.ok(plainCarrier);
    assert.equal(messageImageBytes(plainCarrier).length, 1, "ordinary nested inlineData is indexed");
});

test("model-driven fold: summary gains a folded-images footer carrying refs (#1995 review ④)", async () => {
    // The preflight path renders host-side image notes into its summaries; a
    // MODEL-driven fold writes whatever the model wrote. The footer keeps the
    // decompress({ imageRef }) discoverability pointer alive in that path too.
    const { createCore, defaultConfig } = await import("acp-kernel");
    const { applyRanges } = await import("../src/stream.ts");
    const { parseCompressInput } = await import("../src/compress-tool.ts");
    const { getSession } = await import("../src/session.ts");
    const { applyCompressSettings } = await import("../src/compress-settings.ts");

    const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { ccr: { enabled: false, minToolTokens: 50 } },
    ) as Config;
    const core = createCore();
    const session = getSession(`imgfoot-${Math.random().toString(36).slice(2)}`);
    const msgs: CoreMessage[] = [
        {
            id: "h_0",
            role: "assistant",
            contentType: "tool-call",
            toolCallId: "c1",
            toolName: "shot",
            text: "capture the failure",
        },
        {
            id: "h_1",
            role: "tool",
            contentType: "tool-result",
            toolCallId: "c1",
            toolName: "shot",
            text: "screenshot below",
            rawResponsesItem: {
                type: "function_call_output",
                call_id: "c1",
                output: [
                    { type: "input_text", text: "screenshot below" },
                    { type: "input_image", image_url: `data:image/png;base64,${tinyPng}` },
                ],
            },
        } as CoreMessage & Record<string, unknown>,
    ];
    for (let i = 2; i < 24; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `detail ${i} ${"x".repeat(2000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00008", summary: "Model's own summary of the early history, setup and diagnostics." }] }),
        ctx,
    );
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    assert.match(block.summary, /Model.s own summary of the early history/);
    // The image-bearing tool result is message 2 → m00002; the footer names it
    // with its ref so a later turn can find the restore channel.
    assert.match(
        block.summary,
        /\[folded images: \[image: png 1x1 · m00002\] — decompress\(\{ imageRef \}\) restores pixels\]/,
    );
    // And nothing was appended when the range has no sidecar images: fold the
    // pure-text tail in a second block and check its summary stays untouched.
    applyRanges(
        parseCompressInput({ content: [{ startId: "m00009", endId: "m00014", summary: "Second stretch of text-only history and diagnostics notes." }] }),
        ctx,
    );
    const blocks = [...session.state.blocks].filter((b) => b.active);
    const textOnly = blocks.find((b) => b.summary.startsWith("Second stretch"));
    assert.ok(textOnly, "second fold landed");
    assert.ok(!textOnly.summary.includes("[folded images:"), "no footer without covered images");
});
