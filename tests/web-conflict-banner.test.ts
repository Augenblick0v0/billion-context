// Web conflicts banner: the aggregate line must NAME the conflicting
// plugin/mechanism, not just counts (#1206 ledger carries per-event identity;
// the banner used to force users into acp_status to find out WHAT it was).
import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

const START_MARK = "function escapeHtml";
const END_MARK = "window.bili_conflictLine = bili_conflictLine;";

function bannerLine(): (c: { events?: number; sessions?: number; kinds?: Record<string, number>; latest?: Array<{ kind: string; detail?: string }> }) => string {
    const s = WEB_CLIENT.indexOf(START_MARK);
    const e = WEB_CLIENT.indexOf(END_MARK);
    assert.ok(s >= 0 && e > s, "conflict-banner helpers missing from WEB_CLIENT");
    const src = WEB_CLIENT.slice(s, e) + "\nreturn bili_conflictLine;";
    return new Function(src)() as (c: { events?: number; sessions?: number; kinds?: Record<string, number>; latest?: Array<{ kind: string; detail?: string }> }) => string;
}

test("banner line shows FULL identity (client: entry + source), dedupe, weights, suspected marker (#2045)", () => {
    const f = bannerLine();
    const out = f({
        events: 40, sessions: 23,
        kinds: { "third-party-plugin": 40 },
        latest: [
            { kind: "third-party-plugin", detail: "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)" },
            { kind: "third-party-plugin", detail: "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]" },
            { kind: "third-party-plugin", detail: "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]" },
            { kind: "third-party-plugin", detail: "opencode: opencode-acp (~/.config/opencode/opencode.json)" },
        ],
    });
    assert.equal(out,
        "40 event(s) in 23 session(s): third-party-plugin×40 — pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json) · pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]×2 · opencode: opencode-acp (~/.config/opencode/opencode.json)");
});

test("banner line escapes HTML across the full detail incl. source path", () => {
    const f = bannerLine();
    const out = f({
        events: 1, sessions: 1, kinds: { "third-party-plugin": 1 },
        latest: [{ kind: "third-party-plugin", detail: "pi: npm:a<b&c (settings.json)" }],
    });
    assert.equal(out, "1 event(s) in 1 session(s): third-party-plugin×1 — pi: npm:a&lt;b&amp;c (settings.json)");
});

test("banner line lists ALL distinct entries without truncation (#2045: 显示全尽量)", () => {
    const f = bannerLine();
    const latest = ["a-one", "a-two", "a-three", "a-four", "a-five"].map((n) => ({
        kind: "third-party-plugin" as const, detail: `pi: ${n} (/tmp/settings.json)`,
    }));
    const out = f({ events: 5, sessions: 5, kinds: { "third-party-plugin": 5 }, latest });
    assert.equal(out,
        "5 event(s) in 5 session(s): third-party-plugin×5 — pi: a-one (/tmp/settings.json) · pi: a-two (/tmp/settings.json) · pi: a-three (/tmp/settings.json) · pi: a-four (/tmp/settings.json) · pi: a-five (/tmp/settings.json)");
});

test("banner line degrades gracefully: no latest / non-plugin kinds keep old count shape", () => {
    const f = bannerLine();
    assert.equal(
        f({ events: 39, sessions: 22, kinds: { "third-party-plugin": 39 } }),
        "39 event(s) in 22 session(s): third-party-plugin×39");
    const nativeOnly = f({
        events: 2, sessions: 1, kinds: { "native-compaction": 1, "unannounced-rewrite": 1 },
        latest: [
            { kind: "native-compaction", detail: "codex: compaction_trigger item" },
            { kind: "unannounced-rewrite", detail: "history rewrite without marker" },
        ],
    });
    assert.equal(nativeOnly, "2 event(s) in 1 session(s): native-compaction×1, unannounced-rewrite×1");
    assert.equal(nativeOnly.indexOf("—"), -1, "non-plugin mechanisms keep the count-only row");
});

test("banner wiring: conflicts-banner branch renders bili_conflictLine (drift guard)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_conflictLine = bili_conflictLine;"), "test seam export present");
    assert.ok(WEB_CLIENT.includes("bili_conflictLine(c)"), "banner branch calls the helper");
    const occurrences = WEB_CLIENT.split(" event(s) in ").length - 1;
    assert.equal(occurrences, 1, "'event(s) in' phrasing lives only inside bili_conflictLine");
});
