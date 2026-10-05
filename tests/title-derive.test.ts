import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveTitle, isContextualUserFragment } from "../src/server.js";
import type { CoreMessage } from "acp-kernel";

let seq = 0;
function msg(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string): CoreMessage {
    return { id: `m${++seq}`, role, contentType, text };
}

const AGENTS_MD = "# AGENTS.md instructions for /home/dev/app\n\n<INSTRUCTIONS>\nAlways run lint before committing.\n</INSTRUCTIONS>";
const ENV_CTX = "<environment_context>\n<cwd>/home/dev/app</cwd>\n<shell>bash</shell>\n</environment_context>";

describe("#2118 deriveTitle skips host-injected contextual fragments", () => {
    it("AGENTS.md fragment ahead of the real question does not become the title", () => {
        const t = deriveTitle([msg("user", "text", AGENTS_MD), msg("user", "text", "How do I fix my build?")]);
        assert.equal(t, "How do I fix my build?");
    });

    it("environment_context fragment ahead of the real question does not become the title", () => {
        const t = deriveTitle([msg("user", "text", ENV_CTX), msg("user", "text", "为什么部署失败?")]);
        assert.equal(t, "为什么部署失败?");
    });

    it("both fragments in codex order resolve to the first real question", () => {
        const t = deriveTitle([msg("user", "text", ENV_CTX), msg("user", "text", AGENTS_MD), msg("user", "text", "help me debug the proxy")]);
        assert.equal(t, "help me debug the proxy");
    });

    it("only fragments present: no title yet (retries on later requests)", () => {
        assert.equal(deriveTitle([msg("user", "text", AGENTS_MD), msg("user", "text", ENV_CTX)]), undefined);
        assert.equal(deriveTitle([]), undefined);
    });

    it("plain client without fragments keeps existing behavior", () => {
        assert.equal(deriveTitle([msg("user", "text", "Fix auth bug")]), "Fix auth bug");
    });

    it("long real questions still truncate at 60 chars with ellipsis", () => {
        const q = "a".repeat(80) + " tail";
        const t = deriveTitle([msg("user", "text", q)])!;
        assert.equal(t.length, 58);
        assert.ok(t.endsWith("\u2026"));
    });

    it("whitespace inside the question collapses as before", () => {
        assert.equal(deriveTitle([msg("user", "text", "  why   is\nthe\tbuild red?")]), "why is the build red?");
    });

    it("non-user roles and non-text content never contribute", () => {
        assert.equal(deriveTitle([
            msg("system", "text", "system prompt"),
            msg("assistant", "text", "assistant reply"),
            msg("user", "tool-call", "bash tool"),
            msg("user", "text", ""),
        ]), undefined);
    });
});

describe("#2118 isContextualUserFragment mirrors codex matches_marked_text", () => {
    it("matches trimmed text starting with open AND ending with close marker", () => {
        assert.equal(isContextualUserFragment(AGENTS_MD), true);
        assert.equal(isContextualUserFragment(ENV_CTX), true);
        assert.equal(isContextualUserFragment(`\n${ENV_CTX}\n`), true);
    });

    it("is ASCII case-insensitive like codex eq_ignore_ascii_case", () => {
        assert.equal(isContextualUserFragment("<ENVIRONMENT_CONTEXT>x</ENVIRONMENT_CONTEXT>"), true);
        assert.equal(isContextualUserFragment("# agents.md instructions for x\n\n<INSTRUCTIONS>y</INSTRUCTIONS>"), true);
    });

    it("requires BOTH markers — a real question mentioning one is not filtered", () => {
        assert.equal(isContextualUserFragment("# AGENTS.md instructions are confusing, how do I change them?"), false);
        assert.equal(isContextualUserFragment("<environment_context>foo</environment_context> what does this output mean?"), false);
        assert.equal(isContextualUserFragment("random </INSTRUCTIONS> closing tag in prose"), false);
    });

    it("does not match empty or whitespace-only text", () => {
        assert.equal(isContextualUserFragment(""), false);
        assert.equal(isContextualUserFragment("   \n\t "), false);
    });
});
