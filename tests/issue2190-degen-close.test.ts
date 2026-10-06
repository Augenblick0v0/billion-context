import { test } from "node:test";
import assert from "node:assert/strict";
import {
    composeStreamFilters,
    containsEchoResidue,
    createBiliArtifactFilter,
    createMarkerLineFilter,
    createTagEchoFilter,
    isOrphanMarkupText,
    mayStartBiliInternal,
    mayStartDegenerateRenderTag,
    mayStartMarkerLine,
    mayStartRenderTag,
    stripAcpTags,
} from "../src/loop/tag-echo-filter.ts";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

const OPEN = "\x3cacp tokens=\"23\" type=\"text\"\x3e";
const REF = "m05712";

function streamThrough(chunks: string[]): string {
    const tagFilter = composeStreamFilters(
        composeStreamFilters(createTagEchoFilter(), createMarkerLineFilter()),
        createBiliArtifactFilter(),
    );
    let out = "";
    for (const delta of chunks) {
        if (!mayStartRenderTag(delta) && !mayStartMarkerLine(delta) && !mayStartBiliInternal(delta) && !mayStartDegenerateRenderTag(delta) && !tagFilter.pending()) {
            out += delta;
            continue;
        }
        out += tagFilter.push(delta);
    }
    return out + tagFilter.flush();
}

test("#2190 streaming: real field chunk sequence with degenerate close strips the residue", () => {
    const chunks = ["\x3c", "ac", "p", " tokens", "=\u0022", "173", "\u0022", " type", "=\u0022", "text", "\u0022", "\u003e", "m", "057", "12", "\u003c/", "ap", "\u003e\n", "Let me first survey the workspace."];
    const out = streamThrough(chunks);
    assert.ok(!out.includes(REF), "ref must not leak");
    assert.ok(!out.includes("\u003c/ap\u003e"), "degenerate close must not leak");
    assert.ok(!out.includes("\u003cacp"), "open tag must not leak");
    assert.equal(out, "\nLet me first survey the workspace.", "surrounding prose survives verbatim");
});

test("#2190 streaming: every attested degenerate close name is stripped character-by-character", () => {
    for (const name of ["ap", "p", "a", "apc", "cap", "ck", "div", "warn", "aph", "ambient", "apm"]) {
        const whole = `intro ${OPEN}${REF}\u003c/${name}\u003e after prose here.`;
        const out = streamThrough([...whole]);
        assert.ok(!out.includes(REF), `${name}: ref leaked`);
        assert.ok(!out.includes(`\u003c/${name}\u003e`), `${name}: close leaked`);
        assert.ok(out.startsWith("intro "), `${name}: leading prose lost`);
        assert.ok(out.endsWith("after prose here."), `${name}: trailing prose lost`);
    }
});

test("#2190 streaming: multi-tag blob with mixed valid and degenerate closes", () => {
    const blob = `\u003cacp tokens="419" type="text"\u003em00501\u003c/acp\u003e \u003cacp tokens="193" type="text"\u003em00503\u003c/acp\u003e \u003cacp tokens="0"\u003em00505\u003c/p\u003e \u003cacp tokens="291"\u003em00502\u003c/p\u003e done.`;
    assert.equal(streamThrough([blob]), "    done.");
});

test("#2190 streaming: degenerate close near stream end no longer eats the following prose", () => {
    const out = streamThrough([`\u003cacp tokens="1" type="text"\u003em00042\u003c/ck\u003e End of message.`]);
    assert.equal(out, " End of message.");
});

test("#2190 streaming: prose body with a valid close keeps the prose (#1720 guard)", () => {
    const out = streamThrough([`\u003cacp tokens="1" type="text"\u003eLet me check the file.\u003c/acp\u003e`]);
    assert.equal(out, "Let me check the file.");
});

test("#2190 fast path: prose with stray HTML closes or comparison tails passes byte-identical", () => {
    const prose = "The model wrote \u003c/p\u003e and \u003c/a\u003e in its reply.";
    assert.equal(streamThrough([prose]), prose);
    assert.equal(streamThrough(["if a\u003cb"]), "if a\u003cb");
    assert.equal(streamThrough([" and c\u003ed then ok"]), " and c\u003ed then ok");
});

test("#2190 gate predicates: broad tail engages the machine while orphan-markup accounting stays prose", () => {
    assert.equal(mayStartDegenerateRenderTag("\u003c"), true);
    assert.equal(mayStartDegenerateRenderTag("\u003c/"), true);
    assert.equal(mayStartDegenerateRenderTag("a\u003cb"), true);
    assert.equal(mayStartDegenerateRenderTag("\u003cabcdefghijklmnopq"), false);
    assert.equal(mayStartDegenerateRenderTag("\u003cdiv class="), false);
    assert.equal(mayStartDegenerateRenderTag("OK"), false);
    assert.equal(isOrphanMarkupText("\u003c/p\u003e"), false);
    assert.equal(mayStartRenderTag("a\u003cb"), false);
    assert.equal(containsEchoResidue("m05712\u003c/ap\u003e"), true);
    assert.equal(containsEchoResidue("m05712 \u003c/ap\u003e"), true);
    assert.equal(containsEchoResidue("see m1234"), false);
    assert.equal(containsEchoResidue("m12345\u003cp\u003e"), false);
});

test("#2190 wrapped imitation: payload with ref-shaped content is still swallowed whole", () => {
    const f = createTagEchoFilter();
    let out = f.push(`\u003cacp tokens="1" type="text \u003cfoo\u003e${REF}\u003c/p\u003e more payload`);
    out += f.flush();
    assert.equal(out, "");
});

test("#2190 stripAcpTags: degenerate pairs die atomically, genuine HTML untouched", () => {
    assert.equal(stripAcpTags(`\u003cacp tokens="1" type="text"\u003em05712\u003c/ck\u003e`), "");
    assert.equal(stripAcpTags(`before \u003cacp\u003em00042\u003c/p\u003e after`), "before  after");
    assert.equal(stripAcpTags(`\u003cacp tokens="419" type="text"\u003em00501\u003c/acp\u003e \u003cacp tokens="0"\u003em00505\u003c/p\u003e`), " ");
    assert.equal(stripAcpTags(`\u003cdiv class="x"\u003ehello\u003c/div\u003e`), `\u003cdiv class="x"\u003ehello\u003c/div\u003e`);
    assert.equal(stripAcpTags(`see \u003c/p\u003e and \u003ca\u003em1234 text\u003c/a\u003e`), `see \u003c/p\u003e and \u003ca\u003em1234 text\u003c/a\u003e`);
    assert.equal(stripAcpTags(`\u003cacp tokens="5" type="text"\u003em00001\u003c/acp\u003e`), "");
});

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "responses",
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

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
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

test("#2190 responses pipe: micro-fragmented degenerate tag never reaches the client", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const whole = `ok \u003cacp tokens="23" type="text"\u003em05712\u003c/ck\u003e tail`;
    const micro = whole.match(/.{1,4}/gs) ?? [];
    const events = [
        ...micro.map((piece) => sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: piece })),
        sse({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m05712"), "ref never reaches the client");
    const joined = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()) as { type?: string; delta?: string })
        .filter((ev) => ev.type === "response.output_text.delta" && typeof ev.delta === "string")
        .map((ev) => ev.delta as string)
        .join("");
    assert.equal(joined, "ok  tail", "surrounding prose reassembles to the tag-free text");
});

test("#2190 responses pipe: done-family full-text payload with degenerate pair is cleaned", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "clean" }),
        sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: `clean \u003cacp tokens="1" type="text"\u003em00001\u003c/p\u003e` }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00001"), "done-family payload must be cleaned");
    assert.ok(text.includes("clean "), "prose survives");
});

// #2190 round 2: field-attested drift names outside the core+insertion set
// (229-session census: acacp×455, accessp×339, acb×229, acpx×217). These must
// be stripped too — every name-derived matcher consumes ACP_NAME_ALT, so the
// single-point extension in buildAcplikeName() covers gate and filter alike.
const DRIFT_FORMS: Array<[string, string, string]> = [
    ["acacp", "\x3cacacp tokens=\"34\" type=\"text\"\x3em00375\x3c/acacp\x3e", "m00375"],
    ["accessp", "\x3caccessp tokens=\"37\" type=\"text\"\x3em07960\x3c/accessp\x3e", "m07960"],
    ["acb", "\x3c" + "acb" + "\x3e" + "m00123" + "\x3c/" + "acb" + "\x3e", "m00123"],
    ["acpx", "\x3cacpx\x3em00456\x3c/acpx\x3e", "m00456"],
];

test("#2190 round 2 streaming: attested drift-name forms are stripped character-by-character", () => {
    for (const [name, whole, ref] of DRIFT_FORMS) {
        const out = streamThrough([...whole]);
        assert.ok(!out.includes(ref), `${name}: ref leaked`);
        assert.ok(!out.toLowerCase().includes(`\x3c${name}`), `${name}: open leaked`);
        assert.equal(out, "", `${name}: whole span must die, got ${JSON.stringify(out)}`);
        const withProse = [`before ${whole} after`];
        const out2 = streamThrough(withProse[0].split(""));
        assert.equal(out2, "before  after", `${name}: surrounding prose must survive verbatim`);
    }
});

test("#2190 round 2 streaming: case-folded drift names strip; cross-name pairing strips", () => {
    const cases = [
        "\x3cACACP tokens=\"34\"\x3em00375\x3c/aCaCp\x3e",
        "\x3cacP tokens=\"1\" type=\"text\"\x3em00001\x3c/acacp\x3e",
        "\x3cAcAcP tokens=\"2\"\x3em00002\x3c/ACCESSP\x3e",
    ];
    for (const c of cases) {
        const out = streamThrough([...c]);
        assert.equal(out, "", `case/cross form must die, got ${JSON.stringify(out)}`);
    }
});

test("#2190 round 2 stripAcpTags: drift forms die whole-text, genuine words survive byte-identical", () => {
    const leaky = DRIFT_FORMS.map(([, w]) => w).join(" ");
    assert.equal(stripAcpTags(leaky), "   ", "all four drift spans strip atomically");
    const legit = [
        "\x3caccount\x3em00375\x3c/account\x3e",
        "\x3caction\x3em00375\x3c/action\x3e",
        "\x3cACTIVE\x3em00375\x3c/active\x3e",
        "\x3cacgroup\x3em00375\x3c/acgroup\x3e",
        "\x3cacmap\x3em00375\x3c/acmap\x3e",
        "\x3cacstep\x3em00375\x3c/acstep\x3e",
        "\x3cacpipe\x3em00375\x3c/acpipe\x3e",
    ];
    for (const l of legit) {
        assert.equal(stripAcpTags(l), l, `legit word must stay verbatim: ${l}`);
        assert.equal(streamThrough([...l]), l, `legit word must stream verbatim: ${l}`);
    }
});

test("#2190 round 2 gate: drift-name heads engage the render-tag predicates once spaced", () => {
    assert.equal(mayStartRenderTag("\x3cacacp "), true);
    assert.equal(mayStartRenderTag("\x3caccessp x"), true);
    assert.equal(mayStartRenderTag("\x3c" + "acb" + " "), true);
    assert.equal(mayStartRenderTag("\x3cacpx"), false, "bare head without terminator: BROAD tail covers it");
    assert.equal(mayStartDegenerateRenderTag("\x3cacpx"), true, "BROAD tail engages on the bare head");
    assert.equal(mayStartRenderTag("\x3cacpx\x3e"), true);
    assert.equal(mayStartRenderTag("\x3caccount"), false, "genuine word stays prose");
    assert.equal(mayStartRenderTag("\x3cacgroup"), false, "custom tag stays prose");
});
