import { readFileSync, statSync } from "node:fs";
import { configFile } from "./paths.js";
import { parseExternalSummarySettings, type ExternalSummarySettings } from "./external-summary-settings.js";

type SettingsCache = {
    path: string;
    mtimeMs: number;
    size: number;
    settings: ExternalSummarySettings | undefined;
};

let cache: SettingsCache | undefined;

/** Missing means disabled; unreadable or invalid configuration never means disabled. */
export function configuredSummarySettings(): ExternalSummarySettings | undefined {
    const path = configFile();
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("External summary configuration unavailable");
    }
    if (cache?.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.settings;

    let file: unknown;
    try { file = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("External summary configuration unavailable");
    }
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("External summary configuration unavailable");
    const compress = (file as Record<string, unknown>).compress;
    const raw = compress && typeof compress === "object" ? (compress as Record<string, unknown>).externalSummary : undefined;
    const settings = raw === undefined ? undefined : parseExternalSummarySettings(raw);
    cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, settings };
    return settings;
}
