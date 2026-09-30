import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #1781: the responses pipe's delta fast path forwards plain prose WITHOUT
// crossing tagFilter, so the #673 detector — fed only filter stats — saw
// outputChars: 0 on every healthy plain-text turn and warned on all of them.
// These tests pin both halves of the fix: the fast path accounts visible text,
// and the detector reads what the client assembled, not filter stats.

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A healthy message turn; every prose delta takes the fast path when plain. */
function proseTurn(deltas: string[], responseId = "resp_1", itemId = "item_1"): string[] {
    const text = deltas.join("");
    return [
        sse("response.created", { type: "response.created", response: { id: responseId, status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, part: { type: "output_text", text: "" } }),
        ...deltas.map((d) => sse("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: d })),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, text }),
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: itemId, type: "message", content: [{ type: "output_text", text }] } }),
        sse("response.completed", { type: "response.completed", response: { id: responseId, status: "completed", output: [{ id: itemId, type: "message", content: [{ type: "output_text", text }] }] } }),
    ];
}

/** The turn shape from the issue's e2e probe: an echo-only turn whose only
 *  text the tag filter empties — the genuine #673 signal. */
function echoOnlyTurn(): string[] {
    const tag = `${TAG_OPEN}m00155${TAG_CLOSE}`;
    return [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "item_1", output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: tag }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "item_1", output_index: 0, text: tag }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "message", content: [{ type: "output_text", text: tag }] }] } }),
    ];
}

const degenerateWarns = (logs: string[]) => logs.filter((l) => l.includes("[degenerate-turn]"));

test("responses pipe: a plain-text turn never warns degenerate (#1781)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn(["unwanted"])));
    };
    // Many small plain deltas — exactly what the e2e probe's 96+1 text turns look like.
    await pipePluginResponsesWithStrip(streamOf(proseTurn(["Hel", "lo ", "wor", "ld"])), makeRes(out), makeSession(), (m) => logs.push(m), refetch);
    assert.equal(calls, 0, "a healthy turn burns no continuation retry");
    assert.deepEqual(degenerateWarns(logs), [], `expected zero degenerate warns, got: ${JSON.stringify(logs)}`);
    const text = [...out.join("").matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
    assert.equal(text, "Hello world", "the client still assembles the full answer");
});

test("responses pipe: reasoning + plain text with a bare completion does not burn a retry (#1781)", async () => {
    // No done-family event carries text: a deltas-only completion. Before the
    // fix, visibleTextChars stayed 0 on the fast path, so sawReasoning alone
    // pushed this healthy turn through the retryEmptyTurn gate.
    const events = [
        sse("response.created", { type: "response.created", response: { id: "resp_9", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_r", type: "reasoning", content: [] } }),
        sse("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: "item_r", output_index: 0, summary_index: 0, delta: "let me think" }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: "item_m", type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "item_m", output_index: 1, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_m", output_index: 1, delta: "answer" }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_9", status: "completed", output: [] } }),
    ];
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn(["unwanted"])));
    };
    await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession(), (m) => logs.push(m), refetch);
    assert.equal(calls, 0, "forwarded deltas are visible text — no spurious retry");
    assert.deepEqual(degenerateWarns(logs), [], `expected zero degenerate warns, got: ${JSON.stringify(logs)}`);
});

test("responses pipe: a genuinely empty echo-only turn STILL warns (#673)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(echoOnlyTurn()), makeRes(out), makeSession(), (m) => logs.push(m));
    const warns = degenerateWarns(logs);
    assert.equal(warns.length, 1, `expected exactly one degenerate warn, got: ${JSON.stringify(logs)}`);
    assert.match(warns[0]!, /zero visible text and zero tool calls/);
    assert.match(warns[0]!, /stripped as render-tag echo/, "the stripped-echo bit survives the merged accounting");
    assert.ok(!out.join("").includes("m00155"), "the echoed tag never leaks");
});

test("responses pipe: a recovered echo-only turn (retry succeeded) stays quiet", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn(["recovered after the nudge"])));
    };
    await pipePluginResponsesWithStrip(streamOf(echoOnlyTurn()), makeRes(out), makeSession(), (m) => logs.push(m), refetch);
    assert.equal(calls, 1, "the retry still fires for the genuine empty turn");
    assert.deepEqual(degenerateWarns(logs), [], "a recovered turn delivers text — no warn at stream end");
});

test("responses pipe: a function-call-only turn never warns (#673)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn(["unwanted"])));
    };
    const events = [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "function_call", name: "read" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "function_call" }] } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession(), (m) => logs.push(m), refetch);
    assert.equal(calls, 0);
    assert.deepEqual(degenerateWarns(logs), [], "a tool call is not an empty turn");
});

test("responses pipe: a single-line non-ASCII answer stays quiet (marker-filter slow path sanity)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(proseTurn(["好"])), makeRes(out), makeSession(), (m) => logs.push(m));
    assert.deepEqual(degenerateWarns(logs), [], `expected zero degenerate warns, got: ${JSON.stringify(logs)}`);
    const text = [...out.join("").matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
    assert.ok(text.includes("好"), `the held CJK tail is released to the client, got: ${text}`);
});
