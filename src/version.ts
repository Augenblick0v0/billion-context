import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

// The proxy's own identity, read from package.json at runtime — works in both
// dev (tsx: src/version.ts → ../package.json) and bundled (tsup: dist/*.js →
// ../package.json). Single source for the CLI banner, the /acp panel header,
// and the acp_status surface-meta host line.
function readPkgField(field: string, fallback: string): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(readFileSync(pkg, "utf8"))[field] as string) ?? fallback;
    } catch {
        return fallback;
    }
}

export const VERSION = readPkgField("version", "dev");
export const PACKAGE_NAME = readPkgField("name", "billion-context");

// Which git commit this running code was built from. Display-only (never used
// for update decisions — the updater compares package.json semver).
// Resolution order:
//   1. bundled (dist/*.js): dist/build-info.json, stamped by
//      scripts/write-build-info.mjs at build time and shipped in the tarball —
//      identifies the BUILD, which is exactly what "which code is running"
//      means for a published/global install;
//   2. dev (src/version.ts under tsx): ask git directly — identifies the
//      CHECKOUT, which is what a dev session wants;
//   3. "unknown" when neither exists.
let cachedCommit: string | undefined;
function resolveBuildCommit(): string {
    if (cachedCommit !== undefined) return cachedCommit;
    const here = fileURLToPath(import.meta.url);
    const fromSrc = path.basename(path.dirname(here)) === "src";
    if (!fromSrc) {
        try {
            const infoPath = path.join(path.dirname(here), "build-info.json");
            const commit = (JSON.parse(readFileSync(infoPath, "utf8")) as { commit?: unknown }).commit;
            if (typeof commit === "string" && commit) return (cachedCommit = commit);
        } catch {
            // fall through to git, then unknown
        }
    }
    try {
        const root = path.dirname(path.dirname(here));
        const run = (args: string[]): string =>
            execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
        const commit = run(["rev-parse", "--short", "HEAD"]);
        if (/^[0-9a-f]{7,12}$/.test(commit)) {
            try {
                const dirty = run(["status", "--porcelain"]);
                return (cachedCommit = dirty ? `${commit}-dirty` : commit);
            } catch {
                return (cachedCommit = commit);
            }
        }
    } catch {
        // no git / not a checkout
    }
    return (cachedCommit = "unknown");
}

export const BUILD_COMMIT = resolveBuildCommit();

/** "0.1.187 (8f9faf9e)" — the human-facing form for banners and panels. */
export function versionWithCommit(): string {
    return `${VERSION} (${BUILD_COMMIT})`;
}
