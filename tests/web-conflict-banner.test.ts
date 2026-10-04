// Web conflicts banner: the aggregate line must NAME the conflicting
// plugin/mechanism, not just counts (#1206 ledger carries per-event identity;
// the banner used to force users into acp_status to find out WHAT it was).
// #2102: non-plugin kinds (client-native rewrites) get time+detail items too,
// the line splits active vs historical, and non-plugin items are capped so a
// stock ledger doesn't turn the banner into a log dump.
import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

const START_MARK = "function escapeHtml";
const END_MARK = "window.bili_conflictLine = bili_conflictLine;";

type LatestEntry = { kind: string; detail?: string; at?: number; sessionId?: string };
type BannerInput = { events?: number; sessions?: number; active?: number; historical?: number; kinds?: Record<string, number>; latest?: LatestEntry[] };

function bannerLine(): (c: BannerInput) => string {
    const s = WEB_CLIENT.indexOf(START_MARK);
    const e = WEB_CLIENT.indexOf(END_MARK);
    assert.ok(s >= 0 && e > s, "conflict-banner helpers missing from WEB_CLIENT");
    const src = WEB_CLIENT.slice(s, e) + "\nreturn bili_conflictLine;";
    return new Function(src)() as (c: BannerInput) => string;
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

test("banner line lists ALL distinct plugin entries without truncation (#2045: 显示全尽量)", () => {
    const f = bannerLine();
    const latest = ["a-one", "a-two", "a-three", "a-four", "a-five"].map((n) => ({
        kind: "third-party-plugin" as const, detail: `pi: ${n} (/tmp/settings.json)`,
    }));
    const out = f({ events: 5, sessions: 5, kinds: { "third-party-plugin": 5 }, latest });
    assert.equal(out,
        "5 event(s) in 5 session(s): third-party-plugin×5 — pi: a-one (/tmp/settings.json) · pi: a-two (/tmp/settings.json) · pi: a-three (/tmp/settings.json) · pi: a-four (/tmp/settings.json) · pi: a-five (/tmp/settings.json)");
});

test("banner line degrades gracefully: no latest keeps the count-only shape", () => {
    const f = bannerLine();
    assert.equal(
        f({ events: 39, sessions: 22, kinds: { "third-party-plugin": 39 } }),
        "39 event(s) in 22 session(s): third-party-plugin×39");
});

test("banner line names non-plugin kinds with time + short session id + detail (#2102)", () => {
    const f = bannerLine();
    const out = f({
        events: 2, sessions: 1, kinds: { "native-compaction": 1, "unannounced-rewrite": 1 },
        latest: [
            { kind: "native-compaction", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "abcdef123456", detail: "codex: compaction_trigger item" },
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 4, 58), sessionId: "fedcba654321", detail: "history rewrite without marker" },
        ],
    });
    assert.equal(out,
        "2 event(s) in 1 session(s): native-compaction×1, unannounced-rewrite×1 — [2026-10-03 05:02Z] abcde…: codex: compaction_trigger item · [2026-10-03 04:58Z] fedcb…: history rewrite without marker");
});

test("banner line omits the session id for short ids and truncates long details (#2102)", () => {
    const f = bannerLine();
    const longDetail = "x".repeat(70);
    const out = f({
        events: 1, sessions: 1, kinds: { "unannounced-rewrite": 1 },
        latest: [{ kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "short1", detail: longDetail }],
    });
    const expectedDetail = longDetail.slice(0, 57) + "...";
    assert.equal(out,
        "1 event(s) in 1 session(s): unannounced-rewrite×1 — [2026-10-03 05:02Z]: " + expectedDetail);
});

test("banner line appends the active/historical split when present, degrades when absent (#2102)", () => {
    const f = bannerLine();
    const base = {
        events: 22, sessions: 6,
        kinds: { "unannounced-rewrite": 22 },
        latest: [
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "abcdef123456", detail: "d1" },
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 4, 58), sessionId: "abcdef123456", detail: "d1" },
        ],
    };
    const withSplit = f({ ...base, active: 0, historical: 22 });
    assert.equal(withSplit,
        "22 event(s) in 6 session(s): unannounced-rewrite×22 · 0 active · 22 historical — [2026-10-03 05:02Z] abcde…: d1×2");
    const withoutSplit = f(base);
    assert.equal(withoutSplit.indexOf("active"), -1, "old payloads without active/historical keep the old shape");
    assert.equal(withoutSplit,
        "22 event(s) in 6 session(s): unannounced-rewrite×22 — [2026-10-03 05:02Z] abcde…: d1×2");
});

test("banner line caps NON-plugin items at 4 with a stats pointer; plugin items stay uncapped (#2102)", () => {
    const f = bannerLine();
    const t0 = Date.UTC(2026, 9, 3, 5);
    const latest: LatestEntry[] = [
        ...["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => ({ kind: "third-party-plugin", detail: `pi: ${n} (/tmp/settings.json)` })),
        { kind: "unannounced-rewrite", at: t0, sessionId: "aaaa1111bbbb", detail: "np-one" },
        { kind: "unannounced-rewrite", at: t0 + 60000, sessionId: "cccc2222dddd", detail: "np-two" },
        { kind: "unannounced-rewrite", at: t0 + 120000, sessionId: "eeee3333ffff", detail: "np-three" },
        { kind: "unannounced-rewrite", at: t0 + 180000, sessionId: "gggg4444hhhh", detail: "np-four" },
        { kind: "unannounced-rewrite", at: t0 + 240000, sessionId: "iiii5555jjjj", detail: "np-five" },
    ];
    const out = f({ events: 11, sessions: 7, kinds: { "third-party-plugin": 6, "unannounced-rewrite": 5 }, latest });
    assert.equal(out,
        "11 event(s) in 7 session(s): third-party-plugin×6, unannounced-rewrite×5 — pi: p1 (/tmp/settings.json) · pi: p2 (/tmp/settings.json) · pi: p3 (/tmp/settings.json) · pi: p4 (/tmp/settings.json) · pi: p5 (/tmp/settings.json) · pi: p6 (/tmp/settings.json) · [2026-10-03 05:00Z] aaaa1…: np-one · [2026-10-03 05:01Z] cccc2…: np-two · [2026-10-03 05:02Z] eeee3…: np-three · [2026-10-03 05:03Z] gggg4…: np-four · …+1 more (GET /__bili/stats → conflicts)");
});

test("banner wiring: conflicts-banner branch renders bili_conflictLine (drift guard)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_conflictLine = bili_conflictLine;"), "test seam export present");
    assert.ok(WEB_CLIENT.includes("bili_conflictLine(c)"), "banner branch calls the helper");
    const occurrences = WEB_CLIENT.split(" event(s) in ").length - 1;
    assert.equal(occurrences, 1, "'event(s) in' phrasing lives only inside bili_conflictLine");
});
