import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAcpTags, createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";

// #2176: a render-tag CLOSE name degrades into an open set the model produces
// (near-acplike short names). The OPEN stays the strict acplike legitimacy
// anchor; only PAIRED's close side relaxes to any bounded letter-name. Standalone
// closes stay strict so prose markup is never eaten (#1039). Brackets are
// escaped throughout so the source carries no literal angle-bracket pairs.
const LT = "\u003c";
const GT = "\u003e";
function op(tok: string, extra?: string): string {
    return LT + 'acp tokens="' + tok + '"' + (extra ?? "") + GT;
}
const TATTR = ' type="text"';
const C_ACCP = LT + "/acp" + GT;
const C_AP = LT + "/ap" + GT;
const C_APH = LT + "/aph" + GT;
const C_P = LT + "/p" + GT;
const C_CK = LT + "/ck" + GT;

function streamWhole(input: string): string {
    const f = createTagEchoFilter();
    let out = "";
    for (let i = 0; i < input.length; i += 3) out += f.push(input.slice(i, i + 3));
    return out + f.flush();
}

const ANSWER = "这里有个我必须诚实处理的点，而且它削弱了我一条论据、同时加强了另一条。";
// Shape captured verbatim from the #2176 category-A screenshot: two well-formed
// tags then two degraded-close tags, answer after.
const BURST =
    op("419", TATTR) + "m00501" + C_ACCP + " " +
    op("193", TATTR) + "m00503" + C_ACCP + " " +
    op("0") + "m00505" + C_P + " " +
    op("291") + "m00502" + C_P + " " +
    ANSWER;

test("#2176 stripAcpTags removes a single well-formed pair (regression)", () => {
    assert.equal(stripAcpTags(op("5", TATTR) + "m00123" + C_ACCP + " tail"), " tail");
});

test("#2176 stripAcpTags removes a DEGRADED-close pair (whole-text)", () => {
    assert.equal(stripAcpTags(op("48", TATTR) + "m00558" + C_AP), "");
    assert.equal(stripAcpTags(op("137") + "m00559" + C_APH), "");
    assert.equal(stripAcpTags(op("502") + "m00560" + C_P), "");
    assert.equal(stripAcpTags(op("28") + "m00370" + C_CK), "");
});

test("#2176 stripAcpTags strips a multi-tag burst incl. degraded closes, keeps the answer", () => {
    const out = stripAcpTags(BURST);
    assert.equal(out.trim(), ANSWER);
    assert.ok(!out.includes(LT), "no angle-bracket residue may reach the client");
    assert.ok(!/m0\d{3}/.test(out), "no message-ref residue may reach the client");
});

test("#2176 streaming filter removes a DEGRADED-close pair", () => {
    assert.equal(streamWhole(op("48", TATTR) + "m00558" + C_AP), "");
});

test("#2176 streaming filter strips a multi-tag burst incl. degraded closes, keeps the answer", () => {
    const out = streamWhole(BURST);
    assert.equal(out.trim(), ANSWER);
    assert.ok(!out.includes(LT), "no angle-bracket residue may reach the client");
    assert.ok(!/m0\d{3}/.test(out), "no message-ref residue may reach the client");
});

test("#2176 whitespace-padded ref with a degraded close drops the span wholesale", () => {
    assert.equal(stripAcpTags("pre " + op("0") + " m00505 " + C_P + " post"), "pre  post");
});

test("#2176 does NOT eat prose markup without an acplike open (#1039 guard)", () => {
    const prose = "bold " + LT + "b" + GT + "strong" + LT + "/b" + GT + " end html " +
        LT + "div" + GT + "x" + LT + "/div" + GT + " plus " + LT + "/p" + GT + " tail";
    assert.equal(stripAcpTags(prose), prose);
    assert.equal(streamWhole(prose), prose);
});
