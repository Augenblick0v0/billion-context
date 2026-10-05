import assert from "node:assert/strict";
import test from "node:test";
import { demoteGate, isSideRequest, resolveSideLane, SIDE_REQUEST_MAX_TOKENS } from "../src/server/side-request.ts";

// #2170 measure 1: exhaustive truth-table pin for the two extracted lane
// decision functions. These tables ARE the regression net: any future edit to
// a conjunct, a veto, or a reason string changes a cell here and forces the
// author to also touch tests/ — which is exactly what the lane-guard CI job
// (#2170 measure 5) demands. The reference formulas below are the pre-#2170
// inline expressions from src/server.ts, copied verbatim.

const AGENT_STATES: (string | undefined)[] = [undefined, "main", "title"];

test("demoteGate: exhaustive over every signal combination vs the reference conjunction", () => {
    for (const countTokens of [false, true]) {
        for (const responsesCompact of [false, true]) {
            for (const protocol of [null, "anthropic", "responses"] as const) {
                for (const pluginMode of [false, true]) {
                    for (const requestAgent of AGENT_STATES) {
                        for (const wsLaneEnvelope of [false, true]) {
                            for (const publicForkPrefix of [false, true]) {
                                const got = demoteGate({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix });
                                // reference: the original inline expression (pre-#2170 server.ts)
                                const want = !countTokens && !responsesCompact && protocol !== null && pluginMode
                                    && requestAgent !== "main" && !wsLaneEnvelope && !publicForkPrefix;
                                assert.equal(got, want, JSON.stringify({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix }));
                            }
                        }
                    }
                }
            }
        }
    }
});

test("demoteGate: the #2164 fork veto is structural — publicForkPrefix=true always vetoes, for every other signal combination", () => {
    let combos = 0;
    for (const countTokens of [false, true]) {
        for (const responsesCompact of [false, true]) {
            for (const protocol of [null, "anthropic"] as const) {
                for (const pluginMode of [false, true]) {
                    for (const requestAgent of AGENT_STATES) {
                        for (const wsLaneEnvelope of [false, true]) {
                            combos++;
                            assert.equal(demoteGate({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix: true }), false, "a verified public-fork prefix must veto heuristic demotion in every configuration");
                        }
                    }
                }
            }
        }
    }
    assert.ok(combos >= 24, `exercised ${combos} combinations`);
});

test("resolveSideLane: exhaustive over every signal combination vs the reference expression", () => {
    for (const countTokens of [false, true]) {
        for (const responsesCompact of [false, true]) {
            for (const protocol of [null, "anthropic"] as const) {
                for (const stripApplied of [false, true]) {
                    for (const sideIntent of [false, true]) {
                        for (const requestAgent of AGENT_STATES) {
                            const d = resolveSideLane({ countTokens, responsesCompact, protocol, stripApplied, sideIntent, requestAgent });
                            // reference: the original inline lane condition (pre-#2170 server.ts)
                            const side = !countTokens && !responsesCompact && protocol !== null && (stripApplied || sideIntent);
                            assert.equal(d.lane, side ? "side" : "main", JSON.stringify({ countTokens, responsesCompact, protocol, stripApplied, sideIntent, requestAgent }));
                            assert.equal(d.demoted, side && stripApplied, `demoted ⊆ side, and equals the strip: ${JSON.stringify(d)}`);
                            if (d.lane === "main") {
                                const expected = countTokens || responsesCompact || protocol === null ? "not a model turn" : "main turn";
                                assert.equal(d.reason, expected, `main-lane reason: ${JSON.stringify(d)}`);
                            }
                        }
                    }
                }
            }
        }
    }
});

test("resolveSideLane: reason strings for the three side shapes", () => {
    assert.equal(resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: true, sideIntent: false, requestAgent: undefined }).reason, "leaked bili tools stripped (#1897)");
    assert.equal(resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: "title" }).reason, "agent=title");
    assert.equal(resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: undefined }).reason, `max_tokens<=${SIDE_REQUEST_MAX_TOKENS}`);
});

test("resolveSideLane: no fork input exists — intent-certain side requests ride the lane under a fork receipt (#2164 fix pin)", () => {
    // The #2157→#2164 regression was exactly this cell: a fork-child
    // title-gen. resolveSideLane has no fork field to consult, so the cell
    // cannot regress without removing the function's inputs (a visible,
    // reviewable change). Pin the decision:
    const d = resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: "title" });
    assert.equal(d.lane, "side");
    assert.equal(d.demoted, false);
    // and the fork-vetoed demote shape stays OFF the strip path while still
    // riding via intent (the two gates are complementary, not redundant):
    assert.equal(demoteGate({ countTokens: false, responsesCompact: false, protocol: "anthropic", pluginMode: true, requestAgent: "title", wsLaneEnvelope: false, publicForkPrefix: true }), false);
});

test("SIDE_REQUEST_MAX_TOKENS stays 200 (budget-heuristic width is load-bearing)", () => {
    assert.equal(SIDE_REQUEST_MAX_TOKENS, 200);
});

test("isSideRequest sanity anchors for the table above (agent wins, main never demotes, tools veto, budget path)", () => {
    assert.equal(isSideRequest({}, "title"), true);
    assert.equal(isSideRequest({ max_tokens: 64 }, "main"), false);
    assert.equal(isSideRequest({ max_tokens: 64, tools: [{ name: "x" }] }, undefined), false);
    assert.equal(isSideRequest({ max_tokens: 64 }, undefined), true);
    assert.equal(isSideRequest({ max_tokens: 1024 }, undefined), false);
    assert.equal(isSideRequest({ tools: [{ name: "bili_compact" }] }, undefined), false);
});
