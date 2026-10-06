import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import {
  collectLatestProtected,
  collectProtectedToolCallIds,
  isMessageLatestProtected,
  isMessageProtected,
  isMessageProtectedWithPairing,
  matchToolPath,
  projectToolPath,
} from "../src/protected.js";
import type { Config, CoreMessage } from "../src/types.js";

function toolCall(
  id: string,
  toolName: string,
  callId: string,
  args: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: args,
  };
}

function toolResult(id: string, callId: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    text,
  };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, overrides);
}

test("projectToolPath: opencode skill({name}) shape", () => {
  const m = toolCall("m1", "skill", "c1", '{"name":"git-master"}');
  assert.equal(projectToolPath(m), "skill/git-master");
});

test("projectToolPath: Claude/ZCode Skill({skill}) shape, case-insensitive tool name", () => {
  const m = toolCall("m1", "Skill", "c1", '{"skill":"review-loop"}');
  assert.equal(projectToolPath(m), "skill/review-loop");
});

test("projectToolPath: command field fallback", () => {
  const m = toolCall("m1", "skill", "c1", '{"command":"pdf-tools"}');
  assert.equal(projectToolPath(m), "skill/pdf-tools");
});

test("projectToolPath: pi agentskills file-read shapes (absolute / relative / backslash)", () => {
  assert.equal(
    projectToolPath(
      toolCall("m1", "read", "c1", '{"filePath":"/home/u/.claude/skills/pdf-tools/SKILL.md"}'),
    ),
    "skill/pdf-tools",
  );
  assert.equal(
    projectToolPath(toolCall("m1", "Read", "c1", '{"path":"skills/foo/SKILL.md"}')),
    "skill/foo",
  );
  assert.equal(
    projectToolPath(
      toolCall("m1", "read_file", "c1", '{"file_path":"C:\\\\agents\\\\skills\\\\bar\\\\SKILL.md"}'),
    ),
    "skill/bar",
  );
});

test("projectToolPath: degrades to tool name on failure or non-skill traffic", () => {
  assert.equal(projectToolPath(toolCall("m1", "skill", "c1", "not json")), "skill");
  assert.equal(projectToolPath(toolCall("m1", "skill", "c1", '{"other":"x"}')), "skill");
  assert.equal(projectToolPath(toolCall("m1", "skill", "c1", '["array"]')), "skill");
  assert.equal(projectToolPath(toolCall("m1", "skill", "c1", "")), "skill");
  assert.equal(
    projectToolPath(toolCall("m1", "bash", "c1", '{"command":"grep SKILL md"}')),
    "bash",
  );
  assert.equal(
    projectToolPath(toolCall("m1", "write", "c1", '{"filePath":"/tmp/a.txt"}')),
    "write",
  );
});

test("projectToolPath: tool-results never parse output content", () => {
  const r = toolResult("r1", "c1", 'loaded {"path":"skills/evil/SKILL.md"} now');
  assert.equal(r.toolName, undefined);
  assert.equal(projectToolPath({ ...r, toolName: "read" }), "read");
});

test("matchToolPath: node-and-descendants for slash-free patterns", () => {
  assert.ok(matchToolPath("skill/git-master", "skill"));
  assert.ok(matchToolPath("skill", "skill"));
  assert.ok(matchToolPath("skill/a/b", "skill"));
  assert.ok(matchToolPath("TODO_LIST", "todo*"));
  assert.ok(matchToolPath("todo_list", "todo_list"));
  assert.ok(!matchToolPath("skillfoo", "skill"));
  assert.ok(!matchToolPath("read", "skill"));
});

test("matchToolPath: exact path patterns", () => {
  assert.ok(matchToolPath("skill/release-orchestrator", "skill/release-orchestrator"));
  assert.ok(!matchToolPath("skill/release-orchestrator-x", "skill/release-orchestrator"));
  assert.ok(!matchToolPath("skill/release-orchestrator/sub", "skill/release-orchestrator"));
  // deeper segments are case-sensitive (identifiers typed exactly)
  assert.ok(!matchToolPath("skill/Review-Loop", "skill/review-loop"));
  // leading segment stays case-insensitive (#1725)
  assert.ok(matchToolPath("skill/review-loop", "SKILL/review-loop"));
});

test("matchToolPath: trailing-segment glob never crosses /", () => {
  assert.ok(matchToolPath("skill/review-loop", "skill/review-*"));
  assert.ok(!matchToolPath("skill/review/deep", "skill/review-*"));
  assert.ok(!matchToolPath("skill/review", "skill/review-*"));
});

test("matchToolPath: bare final star is the subtree wildcard (skill ≡ skill/*)", () => {
  assert.ok(matchToolPath("skill/a", "skill/*"));
  assert.ok(matchToolPath("skill/a/b", "skill/*"));
  assert.ok(!matchToolPath("skill", "skill/*"));
  assert.ok(!matchToolPath("other/a", "skill/*"));
});

test("matchToolPath: intermediate star spans exactly one segment", () => {
  assert.ok(matchToolPath("a/b/c", "*/b/*"));
  // intermediate star must not skip levels
  assert.ok(!matchToolPath("a/x/b/c", "*/b/*"));
  assert.ok(!matchToolPath("a/b", "*/b/*"));
});

test("matchToolPath: degenerate inputs never match", () => {
  assert.ok(!matchToolPath("", "skill"));
  assert.ok(!matchToolPath("skill", ""));
});

test("isMessageProtected: protectedTools path syntax across client shapes", () => {
  const oc = toolCall("m1", "skill", "c1", '{"name":"git-master"}');
  const cc = toolCall("m2", "Skill", "c2", '{"skill":"review-loop"}');
  const pi = toolCall("m3", "read", "c3", '{"filePath":"~/.claude/skills/pdf-tools/SKILL.md"}');
  const bash = toolCall("m4", "bash", "c4", '{"command":"ls"}');

  const all = cfg({ protectedTools: ["skill"] });
  for (const m of [oc, cc, pi]) assert.ok(isMessageProtected(m, all), m.id);
  assert.ok(!isMessageProtected(bash, all));

  const exact = cfg({ protectedTools: ["skill/pdf-tools"] });
  assert.ok(isMessageProtected(pi, exact));
  assert.ok(!isMessageProtected(oc, exact));
  assert.ok(!isMessageProtected(cc, exact));

  const glob = cfg({ protectedTools: ["skill/review-*"] });
  assert.ok(isMessageProtected(cc, glob));
  assert.ok(!isMessageProtected(oc, glob));
});

test("isMessageProtected: pairing covers the result half of path-protected calls", () => {
  const oc = toolCall("m1", "skill", "c1", '{"name":"git-master"}');
  const res = toolResult("m2", "c1", "skill body");
  res.toolName = "skill";
  const config = cfg({ protectedTools: ["skill/git-master"] });
  const ids = collectProtectedToolCallIds([oc, res], config);
  assert.deepEqual([...ids], ["c1"]);
  assert.ok(isMessageProtectedWithPairing(res, config, ids));
  // direct check on the result degrades to its tool name — no false positive
  assert.ok(!isMessageProtected(res, config));
});

test("collectLatestProtected: path patterns keep one latest per distinct path", () => {
  const a1 = toolCall("m1", "skill", "ca1", '{"name":"alpha"}');
  const b1 = toolCall("m2", "skill", "cb1", '{"name":"beta"}');
  const a2 = toolCall("m3", "skill", "ca2", '{"name":"alpha"}');
  const b2 = toolCall("m4", "Skill", "cb2", '{"skill":"beta"}');
  const messages = [a1, b1, a2, b2];
  const perName = collectLatestProtected(messages, cfg({ protectedLatestTools: ["skill/*"] }));
  assert.deepEqual(new Set(perName.callIds), new Set(["ca2", "cb2"]));
  assert.ok(isMessageLatestProtected(a2, perName));
  assert.ok(!isMessageLatestProtected(a1, perName));
});

test("collectLatestProtected: slash-free pattern keeps legacy single-latest semantics", () => {
  const a1 = toolCall("m1", "skill", "ca1", '{"name":"alpha"}');
  const b1 = toolCall("m2", "skill", "cb1", '{"name":"beta"}');
  const messages = [a1, b1];
  const legacy = collectLatestProtected(messages, cfg({ protectedLatestTools: ["skill"] }));
  assert.deepEqual(new Set(legacy.callIds), new Set(["cb1"]));
});

test("collectLatestProtected: legacy name-only tools unchanged", () => {
  const t1 = toolCall("m1", "todo_list", "ct1", "{}");
  const t2 = toolCall("m2", "todo_list", "ct2", "{}");
  const legacy = collectLatestProtected([t1, t2], cfg({ protectedLatestTools: ["todo_list"] }));
  assert.deepEqual(new Set(legacy.callIds), new Set(["ct2"]));
  const glob = collectLatestProtected([t1, t2], cfg({ protectedLatestTools: ["todo*"] }));
  assert.deepEqual(new Set(glob.callIds), new Set(["ct2"]));
});
