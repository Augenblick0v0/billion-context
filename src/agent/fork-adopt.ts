import { createHash } from "node:crypto";
import { openaiToCore } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "../acp-panel.js";

/**
 * Agent-side fork adoption (#2399): the dsh native extension reads its host
 * session header (parentSession + isSeeded), and before a fork child's first
 * model request replays into the proxy, adopts the parent conversation's
 * compression state through the plugin fork protocol (PLUGIN.md §8). This
 * module is the client half: it projects the outgoing OpenAI body the same
 * way the server's incomingCoreMessages does, matches the longest parent
 * prefix by identity hash, and posts the fork receipt.
 *
 * HASH PARITY CONTRACT: forkStableJson/forkIdentityHashOf/forkOrderHashOf
 * below are byte-for-byte replicas of src/plugin.ts stableJson/
 * forkMessageIdentityHash/forkOrderHash. The server's publicForkInputMatches
 * rejects the child's first request (409 FORK_PREFIX_CONFLICT) when the
 * replayed prefix does not hash-match the receipt, so any drift here poisons
 * the child conversation permanently. The parity is pinned by
 * tests/dsh-fork-adopt.test.ts against the exported plugin.ts hash.
 */

const SNAPSHOT_TIMEOUT_MS = 15_000;
const FORK_TIMEOUT_MS = 15_000;

export type ForkIdentity = { rawId: string; ref: string; identityHash: string };

type SnapshotResponse = {
    ok?: boolean;
    protocolVersion?: number;
    status?: string;
    sessionId?: string;
    parentRevision?: string;
    orderHash?: string;
    orderedMessages?: ForkIdentity[];
};

export type ForkAdoptionResult =
    | { outcome: "adopted"; branchPoint: number; replayed: boolean }
    | { outcome: "degraded"; reason: string };

function forkStableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(forkStableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${forkStableJson(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function forkHash(value: unknown): string {
    return createHash("sha256").update(forkStableJson(value), "utf8").digest("hex");
}

/** Byte-identical to src/plugin.ts forkMessageIdentityHash. */
export function forkIdentityHashOf(message: CoreMessage): string {
    const toolIsError = (message as CoreMessage & { toolIsError?: boolean }).toolIsError === true;
    return forkHash([message.role, message.contentType, message.text ?? null, message.toolName ?? null, message.toolCallId ?? null, message.thinkingTokens ?? null, message.summaryOfBlockId ?? null, toolIsError]);
}

/** Byte-identical to src/plugin.ts forkOrderHash (plain JSON.stringify over
 *  the identity array as received — snapshot identities arrive with the
 *  server's literal key order rawId, ref, identityHash, so re-serialization
 *  reproduces it). */
export function forkOrderHashOf(messages: ForkIdentity[]): string {
    return createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex");
}

/** Project an outgoing OpenAI chat body to CoreMessages exactly the way the
 *  server's incomingCoreMessages openai branch does (src/fork-adoption.ts):
 *  clone → strip bili panel echoes → strip ACP status markers → openaiToCore.
 *  The leading system/developer prefix is hoisted out by openaiToCore on both
 *  sides, so projections align 1:1 with the parent snapshot. Returns null for
 *  bodies that do not carry a messages array. */
export function openaiBodyToCore(body: unknown): CoreMessage[] | null {
    if (body === null || typeof body !== "object") return null;
    try {
        const clone = structuredClone(body) as Record<string, unknown>;
        if (!Array.isArray(clone.messages)) return null;
        stripAcpPanelMessages(clone.messages);
        stripAcpStatusMarkers(clone.messages);
        return openaiToCore(clone as Parameters<typeof openaiToCore>[0]).msgs;
    } catch {
        return null;
    }
}

/** Longest prefix of `core` whose identity hashes equal the snapshot's, in
 *  order. 0 means the child body shares nothing with the parent — sending a
 *  fork would poison the child id, so the caller degrades instead. */
export function matchForkPrefix(core: CoreMessage[], identities: ForkIdentity[]): number {
    let n = 0;
    while (n < core.length && n < identities.length && forkIdentityHashOf(core[n]!) === identities[n]!.identityHash) n += 1;
    return n;
}

function snapshotOf(raw: unknown): { parentRevision: string; orderHash: string; orderedMessages: ForkIdentity[] } | null {
    if (raw === null || typeof raw !== "object") return null;
    const snap = raw as SnapshotResponse;
    if (typeof snap.parentRevision !== "string" || typeof snap.orderHash !== "string" || !Array.isArray(snap.orderedMessages)) return null;
    for (const identity of snap.orderedMessages) {
        if (identity === null || typeof identity !== "object" || typeof identity.rawId !== "string" || typeof identity.ref !== "string" || typeof identity.identityHash !== "string") return null;
    }
    return { parentRevision: snap.parentRevision, orderHash: snap.orderHash, orderedMessages: snap.orderedMessages };
}

async function codeOf(res: Response): Promise<string> {
    try {
        const parsed = await res.json() as { code?: unknown };
        return typeof parsed.code === "string" ? parsed.code : "";
    } catch {
        return "";
    }
}

/**
 * GET parent snapshot → match longest prefix → POST fork receipt. Every
 * failure path returns { outcome: "degraded" } — the child then simply starts
 * a fresh conversation, exactly today's behavior; adoption is best effort.
 * A 409 PARENT_REVISION_CONFLICT (parent mutated between snapshot and fork)
 * is retried once with a fresh snapshot before degrading.
 */
export async function tryForkAdoption(opts: {
    base: string;
    parentConversationId: string;
    childConversationId: string;
    body: unknown;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
}): Promise<ForkAdoptionResult> {
    const doFetch = opts.fetchImpl ?? fetch;
    const snapshotUrl = `${opts.base}/__bili/plugin/snapshot?conversationId=${encodeURIComponent(opts.parentConversationId)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let snapshot: Awaited<ReturnType<typeof snapshotOf>>;
        try {
            const res = await doFetch(snapshotUrl, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
            if (!res.ok) return { outcome: "degraded", reason: `snapshot http ${res.status}` };
            snapshot = snapshotOf(await res.json());
        } catch (err) {
            return { outcome: "degraded", reason: `snapshot error ${err instanceof Error ? err.message : String(err)}` };
        }
        if (snapshot === null) return { outcome: "degraded", reason: "snapshot malformed" };
        const core = openaiBodyToCore(opts.body);
        if (core === null || core.length === 0) return { outcome: "degraded", reason: "body unmappable" };
        const branchPoint = matchForkPrefix(core, snapshot.orderedMessages);
        if (branchPoint === 0) return { outcome: "degraded", reason: "no prefix match" };
        const prefix = snapshot.orderedMessages.slice(0, branchPoint);
        const orderHash = branchPoint === snapshot.orderedMessages.length ? snapshot.orderHash : forkOrderHashOf(prefix);
        const payload = {
            protocolVersion: 1,
            parentConversationId: opts.parentConversationId,
            childConversationId: opts.childConversationId,
            parentRevision: snapshot.parentRevision,
            branchPoint: { messageCount: branchPoint, orderHash },
            orderedMessages: prefix,
            idempotencyKey: `fork:${opts.childConversationId}`,
        };
        let res: Response;
        try {
            res = await doFetch(`${opts.base}/__bili/plugin/fork`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(FORK_TIMEOUT_MS),
            });
        } catch (err) {
            return { outcome: "degraded", reason: `fork error ${err instanceof Error ? err.message : String(err)}` };
        }
        if (res.status === 201 || res.status === 200) {
            let replayed = false;
            try {
                const parsed = await res.json() as { replayed?: unknown };
                replayed = parsed.replayed === true;
            } catch {
                replayed = false;
            }
            opts.log?.(`fork child ${opts.childConversationId} adopted parent ${opts.parentConversationId} at branch point ${branchPoint}${replayed ? " (replayed)" : ""} (#2399)`);
            return { outcome: "adopted", branchPoint, replayed };
        }
        const code = await codeOf(res);
        if (res.status === 409 && code === "PARENT_REVISION_CONFLICT" && attempt === 0) {
            opts.log?.(`fork for ${opts.childConversationId} hit parent revision conflict, retrying once with a fresh snapshot (#2399)`);
            continue;
        }
        return { outcome: "degraded", reason: `fork http ${res.status}${code ? ` ${code}` : ""}` };
    }
    return { outcome: "degraded", reason: "parent revision conflict retry exhausted" };
}

const forkCapabilityCache = new Map<string, boolean>();

export function resetForkCapabilityCacheForTest(): void {
    forkCapabilityCache.clear();
}

/** Old proxies have no fork endpoints at all; probing manifest keeps adoption
 *  off their request path (and avoids harmless 404 noise). Cached per base —
 *  register.base changes when the extension re-registers with a new proxy. */
export async function manifestForkCapable(base: string, fetchImpl?: typeof fetch): Promise<boolean> {
    const cached = forkCapabilityCache.get(base);
    if (cached !== undefined) return cached;
    const doFetch = fetchImpl ?? fetch;
    try {
        const res = await doFetch(`${base}/__bili/plugin/manifest`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return false;
        const manifest = await res.json() as { capabilities?: { fork?: { protocolVersion?: unknown } } };
        const capable = manifest.capabilities?.fork?.protocolVersion === 1;
        forkCapabilityCache.set(base, capable);
        return capable;
    } catch {
        return false;
    }
}
