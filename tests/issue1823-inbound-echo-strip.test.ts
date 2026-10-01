import assert from "node:assert";
import test from "node:test";
import { stripAcpEchoTags, stripAcpEchoTagsGoogle } from "../src/acp-panel.ts";

// Real render-tag shapes (hex escapes per repo convention for <acp> XML).
const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
// The #1823 field shape: a stack of echoed tags at the very start of the reply.
const STACK = TAG + "\x3cacp tokens=\"2\" type=\"tool:bash\"\x3em00175\x3c/acp\x3e" + "\x3cacp tokens=\"5\" type=\"text\"\x3em00042\x3c/acp\x3e";
const CASE_DRIFT = "\x3cApC tokens=\"2\" type=\"text\"\x3em00009\x3c/ApC\x3e";
const TRUNC_OPEN = "\x3cacp tokens=\"2\">";
const LONE_CLOSE = "\x3c/acp\x3e";

test("openai string content: paired echo stripped, prose kept", () => {
    const messages = [
        { role: "user", content: "q" },
        { role: "assistant", content: `${TAG}prose answer` },
    ];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1);
    assert.equal(messages[1].content, "prose answer");
});

test("three-tag stack at message start (the #1823 field shape) fully stripped", () => {
    const messages = [{ role: "assistant", content: `${STACK}关键证据出来了。` }];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1);
    assert.equal(messages[0].content, "关键证据出来了。");
});

test("case-drifted tag name (model typo tolerance, #1731 parity) stripped", () => {
    const messages = [{ role: "assistant", content: `before ${CASE_DRIFT} after` }];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1);
    assert.ok(!String(messages[0].content).includes("\x3c"));
    assert.ok(String(messages[0].content).includes("before"));
    assert.ok(String(messages[0].content).includes("after"));
});

test("truncated open tag at EOF and lone close tag stripped", () => {
    const messages = [{ role: "assistant", content: `done ${TRUNC_OPEN}` }, { role: "assistant", content: `stray ${LONE_CLOSE} here` }];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 2);
    assert.ok(!String(messages[0].content).includes("\x3c"));
    assert.ok(!String(messages[1].content).includes("\x3c"));
});

test("tag-only assistant content degrades to a space; tool_calls never orphaned", () => {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }];
    const messages = [{ role: "assistant", content: STACK, tool_calls: toolCalls }];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1);
    assert.equal(messages.length, 1, "message must survive (its tool_call result must not be orphaned)");
    assert.equal(messages[0].content, " ");
    assert.deepEqual(messages[0].tool_calls, toolCalls);
});

test("user messages are NEVER touched (user intent may legitimately contain tag-shaped text)", () => {
    const userText = `look at this: ${TAG} and ${STACK}`;
    const messages = [
        { role: "user", content: userText },
        { role: "assistant", content: `${TAG}answer` },
    ];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1, "only the assistant message counts");
    assert.equal(messages[0].content, userText, "user text byte-identical");
});

test("openai reasoning_content / reasoning siblings sanitized", () => {
    const messages = [
        { role: "assistant", content: "ok", reasoning_content: `${TAG}thinking text` },
        { role: "assistant", content: "ok", reasoning: `${CASE_DRIFT}more` },
    ];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 2);
    assert.equal(messages[0].reasoning_content, "thinking text");
    assert.ok(!String(messages[1].reasoning).includes("\x3c"));
});

test("parts array: text parts sanitized, non-prose parts untouched", () => {
    const imagePart = { type: "image_url", image_url: { url: "https://example.com/x.png" } };
    const messages = [{ role: "assistant", content: [{ type: "text", text: `${TAG}hello` }, imagePart] }];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1);
    assert.equal((messages[0].content as Array<Record<string, unknown>>)[0].text, "hello");
    assert.deepEqual((messages[0].content as Array<Record<string, unknown>>)[1], imagePart);
});

test("anthropic thinking blocks sanitized", () => {
    const messages = [{ role: "assistant", content: [{ type: "thinking", thinking: `${STACK}pondering` }, { type: "text", text: "reply" }] }];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 1);
    const parts = messages[0].content as Array<Record<string, unknown>>;
    assert.equal(parts[0].thinking, "pondering");
    assert.equal(parts[1].text, "reply");
});

test("responses input: assistant output_text sanitized, function_call arguments byte-exact (#1039)", () => {
    const args = `{"startId":"m00010","endId":"m00020","summary":"${TAG}"}`;
    const input = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `${CASE_DRIFT}result` }] },
        { type: "function_call", name: "compress", arguments: args, id: "fc1" },
    ];
    const n = stripAcpEchoTags(input);
    assert.equal(n, 1);
    assert.equal((input[1].content as Array<Record<string, unknown>>)[0].text, "result");
    assert.equal(input[2].arguments, args, "tool-call arguments are byte-exact, never filtered");
});

test("google wire form: role model parts sanitized, role user parts untouched", () => {
    const userText = `quoting a tag: ${TAG}`;
    const contents = [
        { role: "user", parts: [{ text: userText }] },
        { role: "model", parts: [{ text: `${STACK}answer` }] },
    ];
    const n = stripAcpEchoTagsGoogle(contents);
    assert.equal(n, 1);
    assert.equal(contents[0].parts[0].text, userText);
    assert.equal(contents[1].parts[0].text, "answer");
});

test("clean history is a no-op: count 0 and strings keep their identity (cache-stable)", () => {
    const prose = "a normal answer without any tags";
    const messages = [
        { role: "user", content: "q" },
        { role: "assistant", content: prose },
        { role: "assistant", content: [{ type: "text", text: "also clean" }] },
    ];
    const n = stripAcpEchoTags(messages);
    assert.equal(n, 0);
    assert.equal(messages[1].content, prose);
    assert.equal((messages[2].content as Array<Record<string, unknown>>)[0].text, "also clean");
});

test("degenerate inputs return 0 without throwing", () => {
    assert.equal(stripAcpEchoTags(undefined), 0);
    assert.equal(stripAcpEchoTags(null), 0);
    assert.equal(stripAcpEchoTags("not an array"), 0);
    assert.equal(stripAcpEchoTags([{ role: "assistant" }, null, 42]), 0);
    assert.equal(stripAcpEchoTagsGoogle(undefined), 0);
    assert.equal(stripAcpEchoTagsGoogle([{ role: "model" }]), 0);
});
