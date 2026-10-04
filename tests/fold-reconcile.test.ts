import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeMessageText,
    normalizedIdentity,
    planReconciliation,
    reconcileFoldCoverage,
    resolveFoldReconcileMode,
    noteSystemPromptFingerprint,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}

function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, b: m.text?.length ?? 0 };
    if (m.toolCallId) a.t = m.toolCallId;
    return a;
}

describe("normalizeMessageText (#1921)", () => {
    test("collapses CRLF, trailing spaces, and blank-line runs", () => {
        assert.equal(normalizeMessageText("hello  world\r\n\r\nnext \t line\n\n\nend  "), "hello world\nnext line\nend");
    });
    test("empty and undefined normalize to empty", () => {
        assert.equal(normalizeMessageText(undefined), "");
        assert.equal(normalizeMessageText(""), "");
    });
    test("NFC-composes equivalent unicode", () => {
        const decomposed = "cafe\u0301"; // e + combining acute
        const composed = "caf\u00e9"; // precomposed é
        assert.equal(normalizeMessageText(decomposed), normalizeMessageText(composed));
    });
    test("real edits survive normalization", () => {
        assert.notEqual(normalizeMessageText("please analyze module 2"), normalizeMessageText("please analyze module 2X"));
    });
});

describe("resolveFoldReconcileMode (#1921)", () => {
    test("env beats config beats default repair", () => {
        assert.equal(resolveFoldReconcileMode({} as NodeJS.ProcessEnv), "repair");
        assert.equal(resolveFoldReconcileMode({}, "warn"), "warn");
        assert.equal(resolveFoldReconcileMode({ BILI_FOLD_RECONCILE: "off" } as NodeJS.ProcessEnv, "repair"), "off");
    });
    test("invalid env falls back to config", () => {
        assert.equal(resolveFoldReconcileMode({ BILI_FOLD_RECONCILE: "sometimes" } as NodeJS.ProcessEnv, "warn"), "warn");
    });
});

describe("planReconciliation (#1921)", () => {
    const u1 = "u1", u2 = "u2", u3 = "u3";
    const oldMsgs = [
        msg(u1, "user", "first turn"),
        msg(u2, "user", "please analyze module 2"),
        msg(u3, "user", "final turn"),
    ];
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of oldMsgs) anchors[m.id!] = anchorOf(m);
    const covered = new Set([u1, u2, u3]);
    const oldOrder = [u1, u2, u3];

    test("clean resend plans no claims", () => {
        const plan = planReconciliation(oldOrder, anchors, oldMsgs, covered);
        assert.equal(plan.claims.size, 0);
        assert.equal(plan.unmatched.length, 0);
    });

    test("single churned middle message is re-anchored by normalized identity", () => {
        // u2's bytes churned (client re-serialization) -> new id, same words.
        const churned = msg("u2-new", "user", "please analyze  module 2\r\n");
        const plan = planReconciliation(oldOrder, anchors, [oldMsgs[0], churned, oldMsgs[2]], covered);
        assert.equal(plan.claims.get(u2), "u2-new");
        assert.equal(plan.byNorm, 1);
        assert.equal(plan.unmatched.length, 0);
    });

    test("real edit of a covered message stays unmatched (honest re-entry)", () => {
        const edited = msg("u2-edited", "user", "please analyze module 2X");
        const plan = planReconciliation(oldOrder, anchors, [oldMsgs[0], edited, oldMsgs[2]], covered);
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, [u2]);
    });

    test("toolCallId anchor claims churned tool results across byte changes", () => {
        const oldTool = msg("t1", "tool_result", '{"rows":[1,2, 3]}', { toolCallId: "toolu_01ABC", toolName: "query" });
        const anchorsT = { t1: anchorOf(oldTool) };
        const churnedTool = msg("t1-new", "tool_result", '{"rows": [1, 2, 3]}', { toolCallId: "toolu_01ABC", toolName: "query" });
        const plan = planReconciliation(["t1"], anchorsT, [churnedTool], new Set(["t1"]));
        assert.equal(plan.claims.get("t1"), "t1-new");
        assert.equal(plan.byTool, 1);
    });

    test("duplicate-cluster shift claims the survivors, leaves the deleted one unmatched", () => {
        const mk = (id: string) => msg(id, "tool_result", "(no content)", { toolCallId: `call-${id}` });
        const dupes = ["d1", "d2", "d3"].map(mk);
        const anchorsD: Record<string, FoldAnchor> = {};
        for (const m of dupes) anchorsD[m.id!] = anchorOf(m);
        // client deleted d2's sibling d1: identical survivors re-serialized with new ids
        const survivors = [msg("d2-new", "tool_result", "(no content)", { toolCallId: "call-d2" }),
                           msg("d3-new", "tool_result", "(no content)", { toolCallId: "call-d3" })];
        const plan = planReconciliation(["d1", "d2", "d3"], anchorsD, survivors, new Set(["d1", "d2", "d3"]));
        // tool anchors are authoritative: d2 -> d2-new, d3 -> d3-new, d1 (deleted) unmatched
        assert.equal(plan.claims.get("d2"), "d2-new");
        assert.equal(plan.claims.get("d3"), "d3-new");
        assert.deepEqual(plan.unmatched, ["d1"]);
    });

    test("norm-ordinal pairing without tool ids: k-th to k-th inside the churn region", () => {
        const ids = ["n1", "n2", "n3"];
        const anchorsN: Record<string, FoldAnchor> = {};
        for (const id of ids) anchorsN[id] = anchorOf(msg(id, "user", "ok"));
        // identical texts, no tool ids, one deleted (n2), survivors churned
        const survivors = [msg("n1-new", "user", " ok"), msg("n3-new", "user", "ok ")];
        const plan = planReconciliation(ids, anchorsN, survivors, new Set(ids));
        // k-th-to-k-th pairing: after deleting n2, the survivor n3 IS the 2nd
        // occurrence — its content (identical to n2) stays covered, and the
        // truly-deleted ordinal is the unmatched one.
        assert.equal(plan.claims.get("n1"), "n1-new");
        assert.equal(plan.claims.get("n2"), "n3-new");
        assert.deepEqual(plan.unmatched, ["n3"]);
        // both survivors end up covered: zero identical-content loss
        const coveredNow = new Set(plan.claims.values());
        assert.deepEqual([...coveredNow].sort(), ["n1-new", "n3-new"].sort());
    });

    test("appended turns are never claimed", () => {
        const fresh = msg("fresh", "user", "a brand new turn");
        const plan = planReconciliation(oldOrder, anchors, [...oldMsgs, fresh], covered);
        assert.equal(plan.claims.size, 0);
        assert.equal(plan.unmatched.length, 0);
    });

    test("length guard rejects same-norm different-scale candidates", () => {
        // Same normalized identity as the anchor ("x" — non-newline whitespace
        // collapses and trims away), but raw length drifts far beyond
        // max(256, b>>2): the guard in the norm-pairing path must reject before
        // the ordinal pairing can claim it (#1930: this is the only defense
        // against a same-norm/different-scale false match).
        const anchorsL = { big: { n: normalizedIdentity(msg("big", "user", "x")), r: "user", b: 1 } };
        const incoming = [msg("big-new", "user", "x" + " ".repeat(10_000))];
        const plan = planReconciliation(["big"], anchorsL, incoming, new Set(["big"]));
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, ["big"]);
    });

    test("length guard accepts same-norm candidates within tolerance", () => {
        // Control side of the branch: identical norm, raw delta 200 <= max(256, b>>2)
        // -> the guard passes and k-th-to-k-th pairing claims the churn.
        const anchorsL = { big: { n: normalizedIdentity(msg("big", "user", "hello world")), r: "user", b: 11 } };
        const incoming = [msg("big-new", "user", "hello world" + " ".repeat(200))];
        const plan = planReconciliation(["big"], anchorsL, incoming, new Set(["big"]));
        assert.equal(plan.claims.get("big"), "big-new");
        assert.equal(plan.byNorm, 1);
    });

    test("covered-present ids inside the churn region are not claimable twice", () => {
        // u2 churns AND u1 moves after it (reorder) — u1 is present, must not be claimed
        const churned = msg("u2-new", "user", "please analyze module 2");
        const plan = planReconciliation(oldOrder, anchors, [churned, oldMsgs[0], oldMsgs[2]], covered);
        assert.equal(plan.claims.get(u2), "u2-new");
        assert.equal(plan.unmatched.includes(u1), false);
    });
});

describe("reconcileFoldCoverage (#1921)", () => {
    function fakeSession(blocks: { effectiveMessageIds: string[]; directMessageIds?: string[] }[]): Session {
        return {
            state: { blocks: blocks.map((b) => ({ active: true, ...b })) },
            metadata: {},
        } as unknown as Session;
    }
    const opts = (mode?: "off" | "warn" | "repair"): ReconcileOptions & { mode?: "off" | "warn" | "repair" } =>
        ({ mode, sessionId: "s1", log: () => {} });

    test("off mode is a no-op", () => {
        const session = fakeSession([{ effectiveMessageIds: ["a"] }]);
        const before = JSON.stringify(session.state.blocks);
        const result = reconcileFoldCoverage(session, [msg("b", "user", "changed")], opts("off"));
        assert.equal(result.kind, "off");
        assert.equal(JSON.stringify(session.state.blocks), before);
    });

    test("repair rewrites block ids and refreshes anchors", () => {
        const original = msg("a", "user", "stable words");
        const session = fakeSession([{ effectiveMessageIds: ["a"], directMessageIds: ["a"] }]);
        // real sequence: one clean pass seeds anchors+order, the next pass churns
        reconcileFoldCoverage(session, [original], opts("repair"));
        const churned = msg("a-new", "user", "stable  words\r\n");
        const result = reconcileFoldCoverage(session, [churned], opts("repair"));
        assert.equal(result.kind, "reanchored");
        assert.equal(result.byNorm, 1);
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, ["a-new"]);
        assert.deepEqual(session.state.blocks[0].directMessageIds, ["a-new"]);
        // claimed ids land in lastPassIds so the kernel's remint node
        // (reconcileLiveIdsNode) does not re-mint them before prune
        assert.deepEqual((session.state as { lastPassIds?: string[] }).lastPassIds, ["a-new"]);
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        assert.ok(anchors["a-new"] !== undefined, "anchor keyed by the new id");
        assert.ok(anchors["a"] === undefined, "old anchor dropped");
        assert.deepEqual(session.metadata.foldAnchorOrder, ["a-new"]);
    });

    test("warn mode computes but never rewrites", () => {
        const session = fakeSession([{ effectiveMessageIds: ["a"] }]);
        reconcileFoldCoverage(session, [msg("a", "user", "stable words")], opts("warn"));
        const churned = msg("a-new", "user", "stable words");
        const result = reconcileFoldCoverage(session, [churned], opts("warn"));
        assert.equal(result.claims, 1);
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, ["a"]);
    });

    test("clean resend seeds anchors without touching blocks", () => {
        const original = msg("a", "user", "stable words");
        const session = fakeSession([{ effectiveMessageIds: ["a"] }]);
        const result = reconcileFoldCoverage(session, [original], opts("repair"));
        assert.equal(result.kind, "resend");
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, ["a"]);
        assert.ok((session.metadata.foldAnchors as Record<string, FoldAnchor>)["a"] !== undefined);
    });

    test("system-only fingerprint: change logs, absence does not", () => {
        const session = fakeSession([]);
        const logs: string[] = [];
        const logOpts = { sessionId: "s1", log: (_l: string, m: string) => logs.push(m) };
        noteSystemPromptFingerprint(session, "You are Claude.", logOpts);
        assert.equal(logs.length, 0);
        noteSystemPromptFingerprint(session, [{ type: "text", text: "different" }], logOpts);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /system prompt changed/);
        assert.match(logs[0], /fold state unaffected/);
    });
});
