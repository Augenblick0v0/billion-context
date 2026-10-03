# Release Workflow Reference

> **Not auto-loaded.** On-demand mechanics pulled out of `AGENTS.md` §5 to keep the
> auto-loaded spec lean. The hard rules (never manual publish, version-only-on-release-branch,
> acp-kernel ships first, updater changes need a no-op release first) stay in
> [`AGENTS.md` §5](../AGENTS.md#5-release-workflow); this file holds the exact steps,
> the one-click workflow internals, and the no-op validation protocol.

Releases are **fully automated via CI** (`.github/workflows/release.yml`). The Agent
prepares a release PR; merging it triggers CI which builds, tests, publishes to npm,
creates a git tag, and creates a GitHub Release. For routine patch releases there is
also a one-click fast path below.

## Branch Naming

Release branches: `YYYY-MM-DD_release-v{VERSION}` (e.g., `2026-08-08_release-v0.1.17`)

## Process (exact steps)

The Agent does steps 1–6, the human does step 7 (merge).

1. **Sync master**:
   ```bash
   git checkout master && git pull --ff-only origin master
   ```
2. **Create the release branch** from master:
   ```bash
   git checkout -b $(date +%Y-%m-%d)_release-v{VERSION}
   ```
3. **Bump version** — edit ONLY the `"version"` field in `package.json`:
   ```diff
   -    "version": "0.1.16",
   +    "version": "0.1.17",
   ```
4. **Add the release-notes entry (#1870)** — in the SAME release PR, as its
   own commit (never bundled into the release commit): prepend an entry to
   the `releases` array in `release-notes/package.json`:
   ```json
   {
     "version": "0.1.17",
     "date": "2026-08-08",
     "tier": "recommended",
     "summary": "what changes FOR THE USER, one line, issue/PR refs"
   }
   ```
   - `tier`: `routine` (default) | `recommended` (restart-soon record —
     correctness/cache/self-heal fixes; NOT user-visible, marketing is NEVER
     recommended) | `critical` (a serious defect users must act on — the only
     tier that ever surfaces to users, #1977; use sparingly, when the fix
     matters more than the silence). Force-upgradeable defects go to
     `advisories/`, never here.
   - The summary is model-written, ≤400 chars, newest-first order, cap 20
     entries. NEVER hand-edit the companion package's own `"version"` field —
     CI bumps it on publish.
   - Full rules: `release-notes/README.md`. Enforcement: `release.yml` fails
     the publish if the version being released has no entry.
5. **Local pre-flight** — run the same checks CI runs:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
6. **Commit, push, open PR** — release-commit convention:
   - Message: `release v{VERSION}`
   - The commit changes ONLY `package.json` (+ `package-lock.json` if it drifts).
     Never bundle other changes into a release commit.
   - PR title: `release v{VERSION}`; body lists changes since last tag.
7. **Human merges the PR** (Agent MUST NOT merge).
8. **CI publishes automatically** — no manual `npm publish`:
   - On merge, `release.yml` detects the `*_release-v*` branch name +
     `release v{VERSION}` commit message.
   - It runs `npm ci` + `typecheck` + `test` + `build`, then
     `npm publish --tag latest` (using the `NPM_TOKEN` repo secret), creates git
     tag `v{VERSION}`, and creates a GitHub Release.
9. **Verify** the published version is live:
   ```bash
   npm view billion-context version
   ```

## One-click manual release (fast path)

For routine patch releases, skip the branch/PR dance: **Actions → "Release
(one-click)" → Run workflow** (`.github/workflows/release-manual.yml`). The `version`
input is optional — blank means auto next-patch over the npm latest; type a full
semver for minor/major/prerelease bumps.

**Prerequisite (#1870):** the version being released must ALREADY have a
release-notes entry merged to master (`release-notes/package.json`, same
shape as step 4 above) — the workflow checks this at dispatch time and aborts
with a pointer to `release-notes/README.md` if the entry is missing. So for
one-click releases the agent adds the entry in a tiny docs PR (or the owner
commits it) BEFORE dispatching. Prereleases (dev channel) are exempt.
The workflow then:

1. **Drift guard**: master's `package.json` version must equal the npm latest, else it
   aborts (never release off a drifted tree). It also rejects a target version that is
   already published. A separate dispatch-time step then verifies the
   release-notes entry exists for the target version (#1870) — see the
   prerequisite above.
2. Bumps ONLY `package.json` + `package-lock.json` and commits `release v{VERSION}` —
   the same one-version-one-commit discipline as `AGENTS.md` Version Bumps.
3. Runs the full pre-flight gate (`npm ci` + typecheck + test + build).
4. Pushes the release commit directly to `master` (GITHUB_TOKEN, fast-forward only).
   If branch protection blocks direct pushes, the release lands on a release branch
   instead and the run tries to open the release PR itself (best-effort — if the account
   forbids Actions-created PRs the run still finishes green with a one-click "open the
   release PR" link in the job summary). The fallback PR body carries a generated
   changelog (`git log` since the last release tag); the same notes appear in the job
   summary as a paste-ready block for opening the PR manually. Merging that PR
   publishes via the standard flow; red is reserved for real failures (guard trips,
   gate failures, or a failed branch push). GitHub suppresses push-event delivery for
   ref updates made with GITHUB_TOKEN, so the push trigger never fires on the fallback
   branch; instead the run explicitly dispatches `ci.yml` on that branch
   (`POST …/actions/workflows/ci.yml/dispatches`, ref = branch; requires the
   `workflow_dispatch` trigger that `ci.yml` declares for exactly this purpose). Those
   check runs land on the same head sha — once green, required checks pass and the
   auto-PR is mergeable without approving its `action_required` pull_request runs
   (bot-authored PRs are gated there) (#772, #1744). If the dispatch fails (transient
   API error), the fallback PR stays gated until someone approves those runs manually.
   (Push-triggered CI on release branches still works for branches pushed with a real
   account token — e.g. agent-driven standard-flow release branches.)
5. Publishes to npm (`latest`, or `dev` for prerelease), tags `v{VERSION}`, and creates
   the GitHub Release with notes generated from `git log` since the last tag.

A successful one-click run does NOT double-trigger `release.yml`: its check only
matches release-branch merges / date-prefixed commits, never a plain `release v{VERSION}`
commit. The standard branch/PR flow above remains the canonical path for anything
non-trivial (updater changes, cross-repo bumps, or whenever a human wants the review
gate).

## CI publish mechanism (what release.yml does)

- **Trigger**: push to `master` where the merge commit or branch name matches
  `*_release-v*`.
- **Prerelease handling**: if the version contains `-` (e.g. `0.1.17-beta.1`), publishes
  with `--tag dev` instead of `--tag latest`.
- **No publish step for the Agent**: the Agent never runs `npm publish`. The only manual
  fallback (if CI is down) is a human running `npm publish`.

## Cross-repo dependency: acp-kernel MUST ship first

`acp-kernel` is pinned in **devDependencies** (exact version, no `^`) and bundled inline
at build time, so `dist/index.js` is self-contained.

⚠️ **When bumping the acp-kernel dependency version:**
1. Release `acp-kernel` first (merge its release PR, wait for CI publish).
2. **Verify it is live on npm:** `npm view acp-kernel version` returns the new version.
3. THEN bump `acp-kernel` in this repo's `package.json` and release billion-context.

Rationale: billion-context CI runs `npm ci`, which installs the exact `acp-kernel`
version pinned in `package.json`. A release branch that bumps `acp-kernel` to a
not-yet-published version fails CI at install time.

## Auto-update testing

To test that a running older version auto-updates to a newer registry version:

```bash
# 1. Install older version from registry
npm install -g billion-context@0.1.16

# 2. Merge the newer release PR (HUMAN merges) — CI publishes 0.1.17 to npm.

# 3. Start the older version
bili start --port 19195
# Within ~10s (startup check) it detects 0.1.17 and installs it, logging:
#   ✔ billion-context auto-updated 0.1.16 → 0.1.17. Restart bili to finish.
```

## ⚠ Releasing changes to the auto-update mechanism itself

**The auto-update code (`src/update.ts`) is load-bearing for every future upgrade.** If
a release ships a broken auto-update, users who install it become **permanently stuck**
— they can never auto-update again (the broken thing is the updater itself), and many
will never notice to manually reinstall. This is strictly worse than a normal bug: a
normal bug affects one feature; a broken updater silently bricks the upgrade path for
everyone who hits it.

**Therefore: any change to `src/update.ts` (the download / extract / install /
version-check logic) MUST be validated with a no-op release BEFORE shipping the change.**
The sequence is:

1. **Ship a no-op release first** (pure version bump, zero code changes) — this proves
   the *existing* upgrade path is healthy end-to-end: the currently-installed version
   auto-updates to the no-op release using the *old* code.
   - Branch: `YYYY-MM-DD_release-v{VERSION}` (same naming convention).
   - Commit: `release v{VERSION}` (version bump only).
   - PR body MUST state it is a no-op and why (validation release).
2. **Only after the no-op release is confirmed on npm** (`npm view billion-context
   version` returns it) AND a real upgrade has been observed succeeding (the log shows
   `auto-updated OLD → NEW`), ship the actual change as a separate subsequent release.
3. If the no-op release's upgrade **fails**, STOP. Do not ship the updater change.
   Investigate the existing-path failure first — the existing code is the only known-good
   upgrade path, and shipping a change on top of an already-broken path compounds the
   problem.

**Why the indirection?** Because if the change-to-the-updater is itself buggy, anyone who
upgrades to it is bricked. The no-op release isolates the test: it exercises the upgrade
path using code we already trust, so a success confirms the *plumbing* (registry,
tarball, file copy, restart) works, independent of the new code. Only then do we trust
the new code to run on the next hop.

**Concrete example (v0.1.22):** the Windows auto-update fix (replacing
`execFile("tar"/"cp")` with the `tar` npm package + `fs.cp`) was staged in PR#44 but NOT
shipped directly. A no-op v0.1.22 (PR#46, version bump only) was released first to
confirm the running v0.1.21 could self-upgrade. Only after that succeeded was the
Windows fix shipped in a follow-up release.
