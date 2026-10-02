import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rmrf } from "./tmp-rm.ts";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-tmp-rm-"));
}

test("rmrf: removes a plain tree; missing target is a no-op (force)", () => {
    const dir = tmpRoot();
    fs.mkdirSync(path.join(dir, "anthropic"));
    fs.writeFileSync(path.join(dir, "anthropic", "session.json"), "{}");
    rmrf(dir);
    assert.equal(fs.existsSync(dir), false);
    rmrf(path.join(dir, "already-gone")); // must not throw ENOENT
});

test("rmrf: outlives a writer that keeps recreating the tree (#1646/#1910 ENOTEMPTY race)", () => {
    const dir = tmpRoot();
    fs.mkdirSync(path.join(dir, "anthropic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "anthropic", "seed.json"), "{}");
    // Stand-in for the real racer: a debounced persist flush that lands after
    // teardown began, recreating <tmp>/<provider>/ between rmSync's readdir
    // and rmdir. 10ms cadence for ~250ms — well past the old flat 10×50ms
    // inner budget once runner load stretches the interval.
    let ticks = 0;
    const writer = setInterval(() => {
        ticks += 1;
        fs.mkdirSync(path.join(dir, "anthropic"), { recursive: true });
        fs.writeFileSync(path.join(dir, "anthropic", `late-${ticks}.json`), "{}");
    }, 10);
    setTimeout(() => clearInterval(writer), 250).unref();
    rmrf(dir); // writer is live here; backoff must outlive the burst
    assert.equal(fs.existsSync(dir), false);
});

test("rmrf: non-transient errors still throw", () => {
    assert.throws(() => rmrf(42 as unknown as string), TypeError);
});
