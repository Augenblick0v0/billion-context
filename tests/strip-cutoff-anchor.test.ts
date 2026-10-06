import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    coreMessagesFor,
    foldAnchoredCutoff,
    pruneRetrieveImgExports,
    restoreExportDir,
} from "../src/image-restore.ts";
import { imagePlaceholdersForSummary } from "../src/image-note.ts";
import type { CompressionState } from "acp-kernel";

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
