import type { SummaryBudget } from "./external-summary.js";
import type { PreflightProtocol } from "./preflight.js";

export interface ExternalSummaryTarget {
    name: string;
    protocol: PreflightProtocol;
    url: string;
    model: string;
    credentialRef: string;
    contextWindow: number;
    outputTokens: number;
    stream: boolean;
}

export interface ExternalSummarySettings {
    enabled: boolean;
    targets: ExternalSummaryTarget[];
    budget: SummaryBudget;
}

export const SUMMARY_DEFAULT_BUDGET: Readonly<SummaryBudget> = {
    totalTimeoutMs: 50_000, targetTimeoutMs: 25_000, maxSummaryBytes: 64 * 1024,
};

export function validSummaryCredentialName(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an external summary object");
    return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown external summary setting; credentials must use credentialRef");
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid external summary budget");
    return result;
}

function text(value: unknown, limit: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid external summary target");
    return value.trim();
}

/** External summary chain. Three-level like every other `compress` field:
 *  a deeper level (provider/model) replaces the whole chain — no per-target
 *  or per-budget sub-merge. */
export function parseExternalSummarySettings(value: unknown): ExternalSummarySettings {
    const settings = object(value);
    knownKeys(settings, ["enabled", "targets", "budget"]);
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error("External summary enabled must be boolean");
    const enabled = settings.enabled === true;
    if (!enabled) {
        // A disabled chain never reads targets or budget — rejecting the
        // whole compress block over a stale typo here would disable
        // compression itself. Strict validation re-engages the moment the
        // (possibly deeper-level) chain is enabled.
        return { enabled: false, targets: [], budget: SUMMARY_DEFAULT_BUDGET };
    }
    if (settings.targets !== undefined && !Array.isArray(settings.targets)) throw new Error("External summary targets must be an array");
    const values = (settings.targets ?? []) as unknown[];
    if (values.length > 16 || values.length === 0) throw new Error("External summary requires 1 to 16 targets when enabled");
    const names = new Set<string>();
    const targets = values.map((value): ExternalSummaryTarget => {
        const target = object(value);
        knownKeys(target, ["name", "protocol", "url", "model", "credentialRef", "contextWindow", "outputTokens", "stream"]);
        const name = text(target.name, 64);
        if (!validSummaryCredentialName(name) || names.has(name)) throw new Error("External summary target names must be unique identifiers");
        names.add(name);
        const protocol = target.protocol;
        if (protocol !== "anthropic" && protocol !== "openai" && protocol !== "responses" && protocol !== "google") throw new Error("Invalid external summary protocol");
        const endpoint = text(target.url, 2048);
        let url: URL;
        try { url = new URL(endpoint); } catch { throw new Error("Invalid external summary endpoint"); }
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash
            || [...url.searchParams.keys()].some((key) => !["alt"].includes(key))
            || url.pathname.includes("/bili/") || url.pathname.startsWith("/__bili/")) throw new Error("Invalid external summary endpoint; use HTTPS and no embedded credentials or proxy recursion");
        const credentialRef = text(target.credentialRef, 128);
        if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)
            && !(credentialRef.startsWith("secret:") && validSummaryCredentialName(credentialRef.slice(7)))) throw new Error("Invalid external summary credential reference");
        const contextWindow = integer(target.contextWindow, 128_000, 2048, 10_000_000);
        const outputTokens = integer(target.outputTokens, Math.min(8192, Math.floor(contextWindow / 4)), 128, contextWindow - 1);
        if (target.stream !== undefined && typeof target.stream !== "boolean") throw new Error("External summary stream must be boolean");
        const model = text(target.model, 200);
        if (protocol === "google") {
            const suffix = target.stream === true ? "streamGenerateContent" : "generateContent";
            if (!url.pathname.endsWith(`/models/${encodeURIComponent(model.replace(/^models\//, ""))}:${suffix}`)) throw new Error("Google summary endpoint must match the model and stream mode");
        }
        return { name, protocol, url: url.href, model, credentialRef, contextWindow, outputTokens, stream: target.stream === true };
    });
    const rawBudget = settings.budget === undefined ? {} : object(settings.budget);
    knownKeys(rawBudget, ["totalTimeoutMs", "targetTimeoutMs", "maxSummaryBytes"]);
    const totalTimeoutMs = integer(rawBudget.totalTimeoutMs, SUMMARY_DEFAULT_BUDGET.totalTimeoutMs, 100, 50_000);
    const targetTimeoutMs = integer(rawBudget.targetTimeoutMs, Math.min(SUMMARY_DEFAULT_BUDGET.targetTimeoutMs, totalTimeoutMs), 100, totalTimeoutMs);
    const maxSummaryBytes = integer(rawBudget.maxSummaryBytes, SUMMARY_DEFAULT_BUDGET.maxSummaryBytes, 128, 1024 * 1024);
    return { enabled, targets, budget: { totalTimeoutMs, targetTimeoutMs, maxSummaryBytes } };
}
