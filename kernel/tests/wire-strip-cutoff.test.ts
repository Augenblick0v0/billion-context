import { test } from "node:test";
import assert from "node:assert/strict";
import { stripHistoricalImages } from "../src/wire/strip-images.js";
import { anthropicToCore } from "../src/wire/anthropic.js";
import { hasMediaPayload } from "../src/protected.js";
import type { AnthropicRequestBody } from "../src/wire/anthropic.js";

const DATA_URL = "data:image/png;base64,AAAA";
const antImg = () => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
});
const antTxt = (t: string) => ({ type: "text", text: t });
const oaiImg = (url: string) => ({ type: "image_url", image_url: { url } });
const oaiTxt = (t: string) => ({ type: "text", text: t });
const rspImg = (url: string) => ({ type: "input_image", image_url: url });
const rspTxt = (t: string) => ({ type: "input_text", text: t });

/** #1995 gap 2: an explicit cutoffIndex replaces the sliding window. The
 *  stripped PREFIX must be byte-identical turn-over-turn (prompt-cache
 *  stability) — with an anchor, appending a new message does not move the
 *  boundary; with the legacy sliding window it does. */
test("anthropic: cutoffIndex anchors the strip boundary; sliding moves it", () => {
  const build = (n: number): AnthropicRequestBody => ({
    model: "claude",
    messages: [
      { role: "user", content: [antTxt("look"), antImg()] },
      { role: "assistant", content: [antImg()] },
      { role: "user", content: [antTxt("hi"), antImg()] },
      ...Array.from({ length: n }, (_, i) => ({
        role: "user" as const,
        content: [antTxt(`tail ${i}`)],
      })),
    ],
  });
  const t0 = build(0);
  const t1 = build(1); // one new message appended next turn

  // Anchor says: everything before wire index 3 is fold-covered.
  const anchored0 = stripHistoricalImages(t0, "anthropic", 1, { cutoffIndex: 3 });
  const anchored1 = stripHistoricalImages(t1, "anthropic", 1, { cutoffIndex: 3 });
  assert.equal(anchored0.removed, 3);
  assert.equal(anchored1.removed, 3);
  const p0 = (anchored0.body as AnthropicRequestBody).messages.slice(0, 3);
  const p1 = (anchored1.body as AnthropicRequestBody).messages.slice(0, 3);
  assert.deepEqual(p1, p0); // prefix stable → cache break stays at the anchor

  // Legacy sliding window with keepRecent=1: the boundary moves every turn —
  // at t0 (3 messages) the window keeps message 2 untouched; at t1 (one tail
  // appended) message 2 crosses the window and gets freshly stripped (new
  // cache break), while the anchor strips it IDENTICALLY in both turns.
  const slide0 = stripHistoricalImages(t0, "anthropic", 1);
  assert.deepEqual(
    (slide0.body as AnthropicRequestBody).messages[2].content,
    [antTxt("hi"), antImg()],
  );
  const slide1 = stripHistoricalImages(t1, "anthropic", 1);
  assert.deepEqual(
    (slide1.body as AnthropicRequestBody).messages[2].content,
    [antTxt("hi")],
  );
  assert.deepEqual(
    (anchored1.body as AnthropicRequestBody).messages[2].content,
    [antTxt("hi")],
  );
  // The uncovered tail never gets stripped under the anchor:
  assert.deepEqual(
    (anchored1.body as AnthropicRequestBody).messages[3].content,
    [antTxt("tail 0")],
  );
});

test("cutoffIndex works for all four protocols (strip strictly before cutoff)", () => {
  // openai
  const oai = {
    model: "gpt",
    messages: [
      { role: "user", content: [oaiTxt("a"), oaiImg(DATA_URL)] },
      { role: "user", content: [oaiTxt("b")] },
      { role: "user", content: [oaiTxt("c"), oaiImg(DATA_URL)] },
    ],
  };
  const r1 = stripHistoricalImages(oai, "openai", 5, { cutoffIndex: 3 });
  assert.equal(r1.removed, 2); // keepRecent=5 would strip nothing; anchor overrides

  // responses
  const rsp = {
    model: "gpt",
    input: [
      { role: "user", content: [rspTxt("a"), rspImg(DATA_URL)] },
      { role: "user", content: [rspTxt("b")] },
    ],
  };
  const r2 = stripHistoricalImages(rsp, "responses", 5, { cutoffIndex: 2 });
  assert.equal(r2.removed, 1);

  // google
  const goo = {
    contents: [
      { role: "user", parts: [{ text: "a" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      { role: "user", parts: [{ text: "b" }] },
    ],
  };
  const r3 = stripHistoricalImages(goo, "google", 5, { cutoffIndex: 2 });
  assert.equal(r3.removed, 1);
});

test("cutoffIndex clamps negative/NaN to the sliding fallback contract", () => {
  const body = {
    model: "claude",
    messages: [
      { role: "user", content: [antTxt("a"), antImg()] },
      { role: "user", content: [antTxt("b")] },
    ],
  };
  // Non-finite → ignored (sliding applies: keepRecent 2 keeps everything)
  const r = stripHistoricalImages(body, "anthropic", 2, { cutoffIndex: Number.NaN });
  assert.equal(r.removed, 0);
  // Negative clamps to 0 → strip nothing (same as keep-all)
  const r2 = stripHistoricalImages(body, "anthropic", 2, { cutoffIndex: -3 });
  assert.equal(r2.removed, 0);
});

/** #1995 fold-anchoring id-stability invariant: stripping must not perturb
 *  the ids of messages a fold can COVER. Image-bearing messages (top-level
 *  image blocks, mixed/image-only tool_results with non-text content) are
 *  hasMediaPayload gaps — never compressible — so their ids may flip or drop
 *  without orphaning any fold. The ids that MUST survive are: text messages
 *  (no-op), image-only top-level messages (placeholder "[image]" IS the
 *  converter's id seed for image blocks), and image-only tool_results (the
 *  empty-string collapse added in this change — a "[image]" text part would
 *  have joined as "[image]" instead of "" and flipped the seed). */
test("anthropic: strip keeps fold-coverable message ids stable", () => {
  const body: AnthropicRequestBody = {
    model: "claude",
    messages: [
      { role: "user", content: [antTxt("plain question")] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
        ],
      },
      { role: "user", content: [antImg()] }, // image-only top-level
      { role: "user", content: [antTxt("q"), antImg()] }, // mixed top-level
    ],
  };
  const before = anthropicToCore(body).msgs;
  const strippedBody = stripHistoricalImages(body, "anthropic", 0).body as AnthropicRequestBody;
  const after = anthropicToCore(strippedBody).msgs;

  const keyOf = (m: { text?: string; toolCallId?: string }) =>
    m.toolCallId ?? m.text ?? "";
  const beforeById = new Map(before.map((m) => [keyOf(m), m.id]));
  for (const m of after) {
    const pre = beforeById.get(keyOf(m));
    if (pre === undefined) continue;
    // Every fold-coverable (non-media) message that survives strip keeps its id:
    if (!hasMediaPayload(before.find((b) => b.id === pre)!)) {
      assert.equal(m.id, pre, `id flipped for ${JSON.stringify(keyOf(m))}`);
    }
  }
  // Spot-check the three stable classes explicitly:
  assert.equal(after.find((m) => m.text === "plain question")?.id, beforeById.get("plain question"));
  const t1After = after.find((m) => m.toolCallId === "t1");
  assert.equal(t1After?.id, beforeById.get("t1")); // image-only tool_result
  const imgOnlyAfter = after.find((m) => m.text === "[image]");
  assert.equal(imgOnlyAfter?.id, before.find((m) => m.text === "[image]" && m.rawAnthropicBlock !== undefined)?.id);

  // The collapsed tool_result is string-empty, not a "[image]" part:
  const mTool = strippedBody.messages[1];
  assert.equal((mTool.content as Array<{ type: string }>)[0].content, "");
});

/** wireIndex tagging (#1995): every core message a wire message flattens into
 *  carries that wire message's ordinal, so host-side anchoring can map fold
 *  coverage (core ids) back to wire positions. */
test("anthropic: wireIndex tags every flattened core message", () => {
  const body: AnthropicRequestBody = {
    model: "claude",
    messages: [
      { role: "user", content: [antTxt("one")] },
      {
        role: "user",
        content: [antTxt("two-a"), antImg(), { type: "text", text: "two-b" }],
      },
      { role: "assistant", content: [antTxt("three")] },
    ],
  };
  const flat = anthropicToCore(body);
  const byWire = new Map<number, number>();
  for (const m of flat.msgs) {
    assert.notEqual(m.wireIndex, undefined, `message ${m.id} lacks wireIndex`);
    byWire.set(m.wireIndex!, (byWire.get(m.wireIndex!) ?? 0) + 1);
  }
  assert.equal(byWire.get(0), 1);
  assert.equal(byWire.get(1), 3); // text + image + text from one wire message
  assert.equal(byWire.get(2), 1);
});
