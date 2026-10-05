import { performance } from "node:perf_hooks";
import { configuredSummarySettings } from "./external-summary-config.js";
import { SummaryCredentialStore } from "./external-summary-credentials.js";
import { createSummaryHttpCandidate } from "./external-summary-http.js";
import { parseExternalSummarySettings, type ExternalSummarySettings } from "./external-summary-settings.js";
import { ExternalSummaryExecutor, type ExternalSummaryBatchResult, type SummaryCandidate, type SummaryWork } from "./external-summary.js";

// One shared queue across all sessions and all compression entry points.
const executor = new ExternalSummaryExecutor(4);

export class ConfiguredSummaryPlan {
    private readonly candidates: readonly SummaryCandidate[];
    readonly deadline: number;

    constructor(private readonly settings: ExternalSummarySettings, store = new SummaryCredentialStore(), env: NodeJS.ProcessEnv = process.env) {
        this.settings = parseExternalSummarySettings(settings);
        const proxyUrl = env.BILI_UPSTREAM_PROXY?.trim() || undefined;
        this.deadline = performance.now() + this.settings.budget.totalTimeoutMs;
        this.candidates = this.settings.targets.map((target) => {
            try {
                const key = store.resolve(target.credentialRef, env);
                if (!key) throw new Error();
                const headers: Record<string, string> = target.protocol === "anthropic" ? { "x-api-key": key }
                    : target.protocol === "google" ? { "x-goog-api-key": key }
                    : { authorization: `Bearer ${key}` };
                return createSummaryHttpCandidate({ ...target, headers, proxyUrl }, this.settings.budget.maxSummaryBytes * 4 + 65536);
            } catch {
                // Preserve order without leaking private errors or borrowing main auth.
                return { async summarize(): Promise<string> { throw new Error("External summary candidate unavailable"); } };
            }
        });
    }

    async summarize(work: readonly SummaryWork[], signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        const remaining = Math.floor(this.deadline - performance.now());
        if (remaining <= 0) return { status: "deadline", results: [] };
        return executor.executeBatch(work, this.candidates, {
            ...this.settings.budget, totalTimeoutMs: remaining,
            targetTimeoutMs: Math.min(remaining, this.settings.budget.targetTimeoutMs),
        }, signal);
    }
}

/** undefined means disabled; invalid settings must fail, never silently use main. */
export function configuredSummaryPlan(): ConfiguredSummaryPlan | undefined {
    const settings = configuredSummarySettings();
    return settings?.enabled ? new ConfiguredSummaryPlan(settings) : undefined;
}
