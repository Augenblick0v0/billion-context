import { rmSync } from "node:fs";

// #1646: bare recursive rmSync throws ENOTEMPTY on loaded CI runners when a
// spawned child recreates entries between readdir and rmdir. The delete may
// only re-run on the transient set Node's rimraf retries
// (ENOTEMPTY/EACCES/EPERM/EMFILE/EBUSY); anything else must surface.
//
// #1910 follow-up: a flat 10×50ms budget (~500ms) still lost the race on the
// ubuntu-22 release-gate leg — the failing suite's late debounced session
// flush (5ms debounce recreating <tmp>/<provider>/) kept the tree alive past
// every retry under full-suite load. Escalate with exponential backoff so
// teardown can always outlive a bounded writer burst; the full window is
// ~3.2s and is only paid when a race actually happens.
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600] as const;

/** Sync sleep that is legal on any thread in Node (blocks the event loop —
 * exactly what a teardown-path retry wants; no pending I/O ordering to keep). */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const defaultRm = (target: string | URL): void =>
    rmSync(target, { recursive: true, force: true });

// Test seam (#1915 review): an in-process writer cannot interleave with the
// synchronous delete (one event loop), so tmp-rm.test.ts drives the retry
// loop through here instead of staging a fake race. The real #1910 racer is
// cross-process (a spawned lane's debounced persist flush).
let rmImpl: typeof defaultRm = defaultRm;
export function _setRmImplForTest(impl?: typeof defaultRm): void {
    rmImpl = impl ?? defaultRm;
}

export function rmrf(target: string | URL): void {
    let attempt = 0;
    for (;;) {
        try {
            rmImpl(target);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const transient =
                code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" ||
                code === "EACCES" || code === "EMFILE";
            if (!transient || attempt >= RETRY_DELAYS_MS.length) throw err;
            sleepSync(RETRY_DELAYS_MS[attempt++]);
        }
    }
}
