/** dsh lane policies — the generic "this plugin's lane is never compressed" table.
 *
 *  dsh profiles are open to third-party plugins, and some of them run model
 *  traffic that bili cannot compress — either because the plugin signs the
 *  request body with a key bili has no re-signer for (#2090: the
 *  compress-or-refuse contract refuses those requests), or because the
 *  plugin deliberately transports its lane through `node:http` so no
 *  fetch-level proxy can see it at all. In both cases the user experience
 *  is confusing ("I installed bili, why is this model uncompressed?" /
 *  "why does this model 403?"), and the answer lives in ANOTHER project's
 *  release notes — not in anything bili can fix.
 *
 *  What bili CAN do is know: detect the installed plugin copies under
 *  `~/.dsh/profiles/<profile>/node_modules/<package>`, and surface a version-aware
 *  reason on every human surface (the /acp panel's before-footer slot,
 *  GET /__bili/status, the web UI, the startup log, and the dsh host's
 *  boot console). Detection is by package.json name + version — cheap,
 *  side-effect free, and TTL-cached so status reads stay fast.
 *
 *  Future plugins that own an uncompressible lane get ONE entry here and
 *  every surface picks it up; nothing else in the codebase needs to know
 *  about them. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveDshHome } from "./client-config.js";
import { isVersionNewer } from "./update.js";

/** One registry entry: how to recognize the plugin and what to say about it. */
export interface DshLanePolicy {
    /** package.json `name` of the plugin as dsh installs it. */
    packageName: string;
    /** short human label for panels and the web UI. */
    label: string;
    /** one line per installed copy; version-aware so guidance can say "upgrade". */
    describe(version: string): string;
}

export const DSH_LANE_POLICIES: readonly DshLanePolicy[] = [
    {
        packageName: "dsh-our-free-model",
        label: "dsh-our-free-model (EAC lane)",
        // #2090: the EAC lane is signed with a per-user sealed key (the
        // plugin's own vault) — no re-signer is possible, so pre-1.4.5
        // copies are refused under the compress-or-refuse contract. From
        // 1.4.5 the plugin transports the lane through node:http on
        // purpose: it never reaches bili, so it is never compressed — by
        // the plugin's design, not by any bili setting.
        describe(version: string): string {
            const below = isVersionNewer("1.4.5", version);
            return below
                ? `dsh-our-free-model@${version}: its EAC-lane requests are body-signed with a key bili cannot re-sign, so they are REFUSED (403) under the compress-or-refuse contract. Upgrade the plugin to >=1.4.5 — the lane then bypasses bili entirely and stops failing (it is never compressed on any version).`
                : `dsh-our-free-model@${version}: its EAC lane deliberately transports through node:http, outside bili's reach — those models are NEVER compressed, regardless of bili settings. This is the plugin's design (#2090), not a bili fault.`;
        },
    },
];

export interface DshLanePolicyFinding {
    packageName: string;
    label: string;
    version: string;
    /** dsh profile directory the copy was found under (informational). */
    profile: string;
    message: string;
}

const SCAN_TTL_MS = 60_000;
let cachedAt = 0;
let cachedFindings: DshLanePolicyFinding[] = [];
let scannedOnce = false;

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

/** Scan `~/.dsh/profiles/<profile>/node_modules/<package>` for every registry entry.
 *  TTL-cached (60s default): status/panel reads hit this on every render,
 *  and the walk is only worth repeating at that cadence. Pass
 *  `{ maxAgeMs: 0 }` to force a fresh walk (tests, refusals). */
export function scanDshLanePolicies(env: NodeJS.ProcessEnv = process.env, opts: { maxAgeMs?: number } = {}): DshLanePolicyFinding[] {
    const now = Date.now();
    if (scannedOnce && now - cachedAt < (opts.maxAgeMs ?? SCAN_TTL_MS)) return cachedFindings;
    const out: DshLanePolicyFinding[] = [];
    try {
        const profilesRoot = path.join(resolveDshHome(env), "profiles");
        for (const ent of readdirSync(profilesRoot, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            for (const policy of DSH_LANE_POLICIES) {
                const pkgFile = path.join(profilesRoot, ent.name, "node_modules", policy.packageName, "package.json");
                const pkg = readJson(pkgFile);
                const name = typeof pkg?.name === "string" ? pkg.name : undefined;
                const version = typeof pkg?.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
                if (name !== policy.packageName) continue;
                out.push({ packageName: policy.packageName, label: policy.label, version, profile: ent.name, message: policy.describe(version) });
            }
        }
    } catch {
        // No dsh home / no profiles dir / unreadable tree: nothing to report.
    }
    cachedFindings = out;
    cachedAt = now;
    scannedOnce = true;
    return out;
}

/** Human one-liners, deduplicated per (package, version) with the profile
 *  list appended — the shape every surface (panel footer, startup log,
 *  web UI, host console) prints. */
export function dshLanePolicyLines(env: NodeJS.ProcessEnv = process.env, opts: { maxAgeMs?: number } = {}): string[] {
    const groups = new Map<string, { message: string; profiles: string[] }>();
    for (const f of scanDshLanePolicies(env, opts)) {
        const key = `${f.packageName}\u0000${f.version}`;
        const g = groups.get(key) ?? { message: f.message, profiles: [] };
        if (!g.profiles.includes(f.profile)) g.profiles.push(f.profile);
        groups.set(key, g);
    }
    return [...groups.values()].map((g) => `${g.message} (dsh profile${g.profiles.length > 1 ? "s" : ""}: ${g.profiles.join(", ")})`);
}
