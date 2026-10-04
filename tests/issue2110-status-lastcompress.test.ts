// #2110: the pi/omp plugin's takeover watchdog reads lastCompressAt from
// /__bili/plugin/status to tell "owning compaction" apart from "compaction
// actually producing". Pin the 200-path field contract: epoch ms of the last
// landed fold (model-driven compress OR preflight — both stamp it in
// applyRanges), null until the first fold in this process. An OLDER proxy
// omits the field entirely; the plugin treats absent (legacy unconditional
// cancel) differently from null (new proxy, no folds yet), so presence itself
// is part of the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createCore, defaultConfig } from "acp-kernel";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { handlePluginStatus, recordPluginSession } from "../src/plugin.ts";

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

test("#2110: /__bili/plugin/status exposes lastCompressAt (null until the first fold)", () => {
    _resetSessionsForTest();
    try {
        const deps = { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} };

        const before = getSession("sess-wd-before", { protocol: "anthropic", label: "WD" });
        recordPluginSession("conv-wd-before", before.id);
        const r0 = mockRes();
        handlePluginStatus("conv-wd-before", r0.res, deps, false);
        assert.equal(r0.status, 200);
        const j0 = JSON.parse(r0.body) as { ok: boolean; conversationId: string; lastCompressAt: number | null };
        assert.equal(j0.ok, true);
        assert.equal(j0.conversationId, "conv-wd-before");
        assert.equal(j0.lastCompressAt, null, "no fold yet → null (field PRESENT, unlike an older proxy)");

        const after = getSession("sess-wd-after", { protocol: "anthropic", label: "WD" });
        after.lastCompress = { at: 1_760_000_000_123, shrinkRatio: 0.42, foldPoint: "m00042", blocks: 3, tokensCompressed: 55_000 };
        recordPluginSession("conv-wd-after", after.id);
        const r1 = mockRes();
        handlePluginStatus("conv-wd-after", r1.res, deps, false);
        assert.equal(r1.status, 200);
        const j1 = JSON.parse(r1.body) as { ok: boolean; lastCompressAt: number | null };
        assert.equal(j1.ok, true);
        assert.equal(j1.lastCompressAt, 1_760_000_000_123, "fold landed → epoch ms passes through byte-exact");
    } finally {
        _resetSessionsForTest();
    }
});
