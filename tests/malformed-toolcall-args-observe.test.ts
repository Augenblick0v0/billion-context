// #1518 stage 1: model-emitted tool-call arguments on the VERBATIM plugin lane
// are host-parsed strictly at the host's terminal (DSH: message_stop); a
// malformed one kills the whole turn while bili has already forwarded the bytes
// untouched (#1039). These pins lock the observe-only pass: exactly one warn per
// bad argument carrying tool name / V8 error class / length / position, zero
// forwarding-byte changes, proxy-mode lanes (no bound session) stay silent, and
// well-formed traffic produces nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/session.js";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip, pipePluginJson } from "../src/plugin.js";
import { setLogCapture } from "../src/logger.js";

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

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function sseLf(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// The logged class must equal V8's own parse-error class with the unstable
// suffixes stripped — the same taxonomy the issue reporter computed on 21
// production failures. Recomputed here so the pin holds across Node versions.
function v8Class(payload: string): string {
    let msg = "";
    try {
        JSON.parse(payload);
    } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
    }
    assert.ok(msg, "test bug: payload must be malformed");
    return msg
        .replace(/\s*in JSON at position \d+/, "")
        .replace(/\s*\(line \d+ column \d+\)$/, "")
        .replace(/,\s*".*" is not valid JSON$/s, "");
}

const QUOTE_ARGS = '{"topic":"summary","content":[{"startId":"m00001","endId":"m00002","summary":"he said "hi" and left"}]}';
const ESCAPE_ARGS = '{"note":"escape demo: \\d and \\w"}';

function captureWarns(fn: () => Promise<void>): Promise<string[]> {
    const warns: string[] = [];
    setLogCapture((level, msg) => {
        if (level === "warn") warns.push(msg);
    });
    const done = fn().finally(() => setLogCapture(null));
    return done.then(() => warns);
}

test("#1518 chat openai: malformed tool-call args reach client verbatim + exactly one warn", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_c1", type: "function", function: { name: "compress", arguments: QUOTE_ARGS.slice(0, 40) } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: QUOTE_ARGS.slice(40) } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    const warns = await captureWarns(() => pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession()));
    const text = out.join("");
    assert.ok(text.includes("call_c1"), "upstream call-id bytes reach the client untouched");
    assert.ok(text.includes(JSON.stringify(QUOTE_ARGS.slice(0, 40))), "first argument fragment passes through verbatim");
    assert.ok(text.includes(JSON.stringify(QUOTE_ARGS.slice(40))), "second argument fragment passes through verbatim");
    const w = warns.filter((m) => m.includes("malformed tool-call args"));
    assert.equal(w.length, 1, "exactly one warn per bad argument");
    assert.ok(w[0].includes("[testsess]"), "warn carries the session id");
    assert.ok(w[0].includes("openai"), "warn carries the protocol");
    assert.ok(w[0].includes("tool=compress"), "warn carries the tool name");
    assert.ok(w[0].includes(`len=${QUOTE_ARGS.length}`), "warn carries the argument byte count");
    assert.ok(w[0].includes(v8Class(QUOTE_ARGS)), "warn carries V8's native error class");
});

test("#1518 chat openai: well-formed tool-call args produce no warn (negative control)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const good = '{"c":1}';
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_ok", type: "function", function: { name: "get_weather", arguments: good } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    const warns = await captureWarns(() => pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession()));
    assert.ok(out.join("").includes("get_weather"), "named call passes through verbatim");
    assert.equal(warns.filter((m) => m.includes("malformed tool-call args")).length, 0, "no warn for well-formed traffic");
});

test("#1518 chat openai: empty argument string is skipped, not reported", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_e", type: "function", function: { name: "noop", arguments: "" } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    const warns = await captureWarns(() => pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession()));
    assert.equal(warns.filter((m) => m.includes("malformed tool-call args")).length, 0, "empty args never reach a host parser");
});

test("#1518 chat anthropic: malformed input_json_delta args reach client verbatim + exactly one warn", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        sseLf("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant" } }),
        sseLf("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c1", name: "compress" } }),
        sseLf("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ESCAPE_ARGS.slice(0, 20) } }),
        sseLf("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ESCAPE_ARGS.slice(20) } }),
        sseLf("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseLf("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
        sseLf("message_stop", { type: "message_stop" }),
    ];
    const warns = await captureWarns(() => pipePluginChatWithStrip(streamOf(events), res, "anthropic", makeSession()));
    const text = out.join("");
    assert.ok(text.includes("toolu_c1"), "upstream block bytes reach the client untouched");
    assert.ok(text.includes(JSON.stringify(ESCAPE_ARGS.slice(0, 20))), "first partial_json fragment passes through verbatim");
    const w = warns.filter((m) => m.includes("malformed tool-call args"));
    assert.equal(w.length, 1, "exactly one warn per bad argument");
    assert.ok(w[0].includes("anthropic"), "warn carries the protocol");
    assert.ok(w[0].includes("tool=compress"), "warn carries the tool name");
    assert.ok(w[0].includes(`len=${ESCAPE_ARGS.length}`), "warn carries the argument byte count");
    assert.ok(w[0].includes(v8Class(ESCAPE_ARGS)), "warn carries V8's native error class (bad escaped character)");
});

test("#1518 chat google: structured-object args never flagged (negative control)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "compress", args: { content: ["字"] } } }] } }] })}\n\n`,
        DONE,
    ];
    const warns = await captureWarns(() => pipePluginChatWithStrip(streamOf(events), res, "google", makeSession()));
    assert.ok(out.join("").includes("functionCall"), "upstream part reaches the client untouched");
    assert.equal(warns.filter((m) => m.includes("malformed tool-call args")).length, 0, "structured args are parse-valid by construction");
});

test("#1518 responses: malformed function_call_arguments reach client verbatim + exactly one warn", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const frag = QUOTE_ARGS.slice(0, 30);
    const events = [
        sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_m1", call_id: "call_m1", name: "compress", arguments: "" } }),
        sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_m1", output_index: 0, delta: frag }),
        sseLf("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_m1", output_index: 0, arguments: QUOTE_ARGS }),
        sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_m1", call_id: "call_m1", name: "compress", arguments: QUOTE_ARGS } }),
        sseLf("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    const warns = await captureWarns(() => pipePluginResponsesWithStrip(streamOf(events), res, makeSession()));
    const text = out.join("");
    assert.ok(text.includes("fc_m1"), "item bytes reach the client untouched");
    assert.ok(text.includes(JSON.stringify(frag)), "argument delta passes through verbatim");
    const w = warns.filter((m) => m.includes("malformed tool-call args"));
    assert.equal(w.length, 1, "exactly one warn per bad argument");
    assert.ok(w[0].includes("responses"), "warn carries the protocol");
    assert.ok(w[0].includes("tool=compress"), "warn carries the tool name");
    assert.ok(w[0].includes(`len=${QUOTE_ARGS.length}`), "warn carries the final argument byte count");
    assert.ok(w[0].includes(v8Class(QUOTE_ARGS)), "warn carries V8's native error class");
});

test("#1518 responses: well-formed function_call produces no warn (negative control)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_ok", call_id: "call_ok", name: "get_weather", arguments: "" } }),
        sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_ok", output_index: 0, delta: '{"c":1}' }),
        sseLf("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_ok", output_index: 0, arguments: '{"c":1}' }),
        sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_ok", call_id: "call_ok", name: "get_weather", arguments: '{"c":1}' } }),
        sseLf("response.completed", { type: "response.completed", response: { id: "resp_2", status: "completed", output: [] } }),
    ];
    const warns = await captureWarns(() => pipePluginResponsesWithStrip(streamOf(events), res, makeSession()));
    assert.equal(warns.filter((m) => m.includes("malformed tool-call args")).length, 0, "no warn for well-formed traffic");
});

test("#1518 non-streaming openai JSON: malformed tool_call arguments kept verbatim + one warn", async () => {
    const body = {
        id: "chatcmpl-x", object: "chat.completion", created: 1, model: "gpt",
        choices: [{
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "compress", arguments: QUOTE_ARGS } }] },
            finish_reason: "tool_calls",
        }],
    };
    const raw = JSON.stringify(body);
    const out: string[] = [];
    const res = makeRes(out);
    const warns = await captureWarns(() => pipePluginJson(streamOf([raw]), res, makeSession(), "openai"));
    assert.equal(out.join(""), raw, "body bytes untouched (no tag in sight: no reserialize)");
    const w = warns.filter((m) => m.includes("malformed tool-call args"));
    assert.equal(w.length, 1, "exactly one warn per bad argument");
    assert.ok(w[0].includes("tool=compress"), "warn carries the tool name");
    assert.ok(w[0].includes(v8Class(QUOTE_ARGS)), "warn carries V8's native error class");
});

test("#1518 non-streaming responses JSON: malformed function_call arguments kept verbatim + one warn", async () => {
    const body = {
        id: "resp_x", object: "response", status: "completed",
        output: [{ type: "function_call", id: "fc_j1", call_id: "call_j1", name: "compress", arguments: QUOTE_ARGS }],
    };
    const raw = JSON.stringify(body);
    const out: string[] = [];
    const res = makeRes(out);
    const warns = await captureWarns(() => pipePluginJson(streamOf([raw]), res, makeSession(), "responses"));
    assert.equal(out.join(""), raw, "body bytes untouched");
    const w = warns.filter((m) => m.includes("malformed tool-call args"));
    assert.equal(w.length, 1, "exactly one warn per bad argument");
    assert.ok(w[0].includes("tool=compress"), "warn carries the tool name");
    assert.ok(w[0].includes(v8Class(QUOTE_ARGS)), "warn carries V8's native error class");
});

test("#1518 proxy-mode lane (no bound session): malformed args stay silent — diagnostics belong to the ladder", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_p1", type: "function", function: { name: "compress", arguments: QUOTE_ARGS } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    const warns = await captureWarns(() => pipePluginChatWithStrip(streamOf(events), res, "openai", undefined));
    assert.ok(out.join("").includes("call_p1"), "bytes still forward verbatim on the #460 lane");
    assert.equal(warns.filter((m) => m.includes("malformed tool-call args")).length, 0, "observe-only pass is gated on a bound session");
});
