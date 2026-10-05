import { readFileSync } from "node:fs";
import { configFile } from "./paths.js";
import { parseExternalSummarySettings, type ExternalSummarySettings } from "./external-summary-settings.js";

/** Missing means disabled; unreadable or invalid configuration never means disabled. */
export function configuredSummarySettings(): ExternalSummarySettings | undefined {
    let file: unknown;
    try { file = JSON.parse(readFileSync(configFile(), "utf8").replace(/^\uFEFF/, "")); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("External summary configuration unavailable");
    }
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("External summary configuration unavailable");
    const compress = (file as Record<string, unknown>).compress;
    const raw = compress && typeof compress === "object" ? (compress as Record<string, unknown>).externalSummary : undefined;
    return raw === undefined ? undefined : parseExternalSummarySettings(raw);
}
