import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexHome, refreshOverlayHome, isSqliteMain, SQLITE_ORIGIN_FILE } from "../src/launcher.js";

const crequire = createRequire(import.meta.url);

interface SqliteStmt {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
    exec(sql: string): void;
    prepare(sql: string): SqliteStmt;
    close(): void;
}
type SqliteCtor = new (dbPath: string, opts?: { readOnly?: boolean }) => SqliteDb;

// node:sqlite needs Node >= 22.5 (experimental); CI runs 22/24. Skip gracefully elsewhere.
let sqliteCtor: SqliteCtor | undefined;
try {
    sqliteCtor = (crequire("node:sqlite") as { DatabaseSync?: SqliteCtor }).DatabaseSync;
} catch {}

// Child-process fixture: builds a WAL-mode db whose seed rows are checkpointed
// into the MAIN file (distinguishing it from sibling fixtures) and whose tail
// rows sit in an uncheckpointed -wal. Without "clean" the process exits without
// closing the handle, leaving main+WAL exactly like a killed codex.
const FIXTURE_SRC = `
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const [dir, name, seed, tail, clean] = process.argv.slice(2);
const db = new DatabaseSync(path.join(dir, name));
db.exec("PRAGMA journal_mode=WAL;");
db.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");
for (const r of seed.split(",")) {
    if (!r) continue;
    const [id, v] = r.split(":");
    db.prepare("INSERT INTO t VALUES(?, ?)").run(Number(id), v);
}
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
for (const r of tail.split(",")) {
    if (!r) continue;
    const [id, v] = r.split(":");
    db.prepare("INSERT INTO t VALUES(?, ?)").run(Number(id), v);
}
if (clean === "clean") db.close();
else process.exit(0);
`;

function mkRoot(): string {
    return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "bili-sqlite-overlay-"));
}

function buildDb(root: string, dir: string, name: string, seed: string, tail: string, clean: boolean): void {
    const script = path.join(root, "fixture.mjs");
    if (!fs.existsSync(script)) fs.writeFileSync(script, FIXTURE_SRC);
    execFileSync(process.execPath, ["--no-warnings", script, dir, name, seed, tail, clean ? "clean" : "dirty"], { cwd: root });
}

function rowsOf(p: string): number[] {
    assert.ok(sqliteCtor, "node:sqlite unavailable");
    const db = new sqliteCtor(p);
    try {
        return db.prepare("SELECT id FROM t ORDER BY id").all().map((r) => Number(r.id));
    } finally {
        db.close();
    }
}

function quickCheckOk(p: string): boolean {
    assert.ok(sqliteCtor, "node:sqlite unavailable");
    const db = new sqliteCtor(p);
    try {
        return String(db.prepare("PRAGMA quick_check").get().quick_check) === "ok";
    } finally {
        db.close();
    }
}

function capturedErrors(fn: () => void): string[] {
    const orig = console.error;
    const out: string[] = [];
    console.error = (...args: unknown[]): void => {
        out.push(args.map(String).join(" "));
    };
    try {
        fn();
    } finally {
        console.error = orig;
    }
    return out;
}

function touch(p: string, t: number): void {
    fs.utimesSync(p, t, t);
}

test("isSqliteMain detects db extensions and live sidecars", () => {
    assert.equal(isSqliteMain("state_5.sqlite", new Set()), true);
    assert.equal(isSqliteMain("a.db", new Set()), true);
    assert.equal(isSqliteMain("b.sqlite3", new Set()), true);
    assert.equal(isSqliteMain("z", new Set(["z-wal"])), true);
    assert.equal(isSqliteMain("z", new Set(["z-shm"])), true);
    assert.equal(isSqliteMain("z", new Set(["z-journal"])), true);
    assert.equal(isSqliteMain("state_5.sqlite-wal", new Set()), false);
    assert.equal(isSqliteMain("state_5.sqlite-shm", new Set()), false);
    assert.equal(isSqliteMain("config.toml", new Set()), false);
    assert.equal(isSqliteMain("plainfile", new Set(["other-wal"])), false);
});

test("cold start copies *.sqlite privately and keeps other entries shared", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seedA,2:seedB", "", true);
    fs.writeFileSync(path.join(real, "auth.json"), "{}\n");
    fs.mkdirSync(path.join(real, "sessions"));
    const mainBytes = fs.readFileSync(path.join(real, "state_5.sqlite"));

    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    const st = fs.lstatSync(path.join(overlay, "state_5.sqlite"));
    assert.ok(st.isFile(), "overlay db must be a regular file");
    assert.equal(st.nlink, 1, "overlay db must be a private copy, not a shared link");
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), mainBytes);
    assert.deepEqual(rowsOf(path.join(overlay, "state_5.sqlite")), [1, 2]);
    assert.equal(fs.readFileSync(path.join(overlay, "auth.json"), "utf8"), "{}\n");
    for (const dir of [real, overlay]) {
        for (const n of fs.readdirSync(dir)) {
            assert.ok(!n.endsWith("-wal") && !n.endsWith("-shm"), `unexpected sidecar ${path.join(dir, n)}`);
        }
    }
});

test("cold start copies a crashed set (main+WAL) whole and recovery works", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "logs_2.sqlite", "10:a", "11:tail", false);
    const mainBytes = fs.readFileSync(path.join(real, "logs_2.sqlite"));
    const walBytes = fs.readFileSync(path.join(real, "logs_2.sqlite-wal"));

    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    assert.deepEqual(fs.readFileSync(path.join(overlay, "logs_2.sqlite")), mainBytes);
    assert.deepEqual(fs.readFileSync(path.join(overlay, "logs_2.sqlite-wal")), walBytes);
    assert.equal(fs.lstatSync(path.join(overlay, "logs_2.sqlite")).nlink, 1);
    assert.equal(fs.lstatSync(path.join(overlay, "logs_2.sqlite-wal")).nlink, 1);
    assert.deepEqual(rowsOf(path.join(overlay, "logs_2.sqlite")), [10, 11], "WAL tail must recover against the copied main");
    assert.ok(quickCheckOk(path.join(overlay, "logs_2.sqlite")));
    assert.deepEqual(fs.readFileSync(path.join(real, "logs_2.sqlite")), mainBytes, "real home stays untouched");
});

test("leftover .sqlite set merges back as one unit (no per-file splice)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const run = (winnerSide: "real" | "overlay"): void => {
        const root = mkRoot();
        const real = path.join(root, "real");
        const overlay = path.join(root, "overlay");
        fs.mkdirSync(real, { recursive: true });
        fs.mkdirSync(overlay, { recursive: true });
        buildDb(root, real, "state_5.sqlite", "100:rSeed", "101:rTail", false);
        buildDb(root, overlay, "state_5.sqlite", "200:oSeed", "201:oTail", false);
        const rm = path.join(real, "state_5.sqlite");
        const om = path.join(overlay, "state_5.sqlite");
        const rw = path.join(real, "state_5.sqlite-wal");
        const ow = path.join(overlay, "state_5.sqlite-wal");
        const rMain = fs.readFileSync(rm);
        const oMain = fs.readFileSync(om);
        const rWal = fs.readFileSync(rw);
        const oWal = fs.readFileSync(ow);
        // Adversarial mtimes: the loser side owns the NEWER wal, so any
        // per-file adjudication splices generations. The winner is forced by
        // the MAIN db's mtime only.
        const T = Date.now() / 1000;
        if (winnerSide === "real") {
            touch(rm, T);
            touch(om, T - 60);
            touch(rw, T - 30);
            touch(ow, T - 10);
        } else {
            touch(om, T);
            touch(rm, T - 60);
            touch(ow, T - 30);
            touch(rw, T - 10);
        }
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
        const winMain = winnerSide === "real" ? rMain : oMain;
        const winWal = winnerSide === "real" ? rWal : oWal;
        const loseMain = winnerSide === "real" ? oMain : rMain;
        const loseWal = winnerSide === "real" ? oWal : rWal;
        const winRows = winnerSide === "real" ? [100, 101] : [200, 201];
        assert.deepEqual(fs.readFileSync(rm), winMain, "active main must come from the winning side");
        assert.deepEqual(fs.readFileSync(rw), winWal, "active WAL must travel with its main");
        assert.deepEqual(rowsOf(rm), winRows);
        assert.ok(quickCheckOk(rm));
        assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite.bili-conflict")), loseMain, "losing main preserved");
        assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite-wal.bili-conflict")), loseWal, "losing WAL preserved");
        fs.rmSync(root, { recursive: true, force: true });
    };
    run("real");
    run("overlay");
});

test("overlay writes stay private until exit; divergent sides both survive", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    let db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db.close();
    db = new sqliteCtor(re);
    db.prepare("INSERT INTO t VALUES(3, 'viaReal')").run();
    db.close();

    assert.deepEqual(rowsOf(ov), [1, 2], "overlay generation sees only its own writes");
    assert.deepEqual(rowsOf(re), [1, 3], "real generation sees only its own writes");

    const T = Date.now() / 1000;
    touch(ov, T - 60);
    touch(re, T);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("diverge")), "divergence must be reported loudly");
    assert.deepEqual(rowsOf(re), [1, 3], "newer generation wins the merge-back");
    const conflict = path.join(real, "state_5.sqlite.bili-conflict");
    assert.deepEqual(rowsOf(conflict), [1, 2], "loser generation survives intact in the conflict file");
});

test("legacy symlinked main is replaced by a private copy; sidecars quarantined", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    const realMainBefore = fs.readFileSync(path.join(real, "state_5.sqlite"));
    fs.symlinkSync(path.join(real, "state_5.sqlite"), path.join(overlay, "state_5.sqlite"));
    fs.writeFileSync(path.join(overlay, "state_5.sqlite-wal"), "STALE-WAL-BYTES");

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("#1917")), "legacy migration must be announced");
    const st = fs.lstatSync(path.join(overlay, "state_5.sqlite"));
    assert.ok(st.isFile() && !st.isSymbolicLink(), "symlink must be gone, replaced by a regular file");
    assert.equal(st.nlink, 1);
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), realMainBefore);
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite-wal.bili-conflict")), Buffer.from("STALE-WAL-BYTES"));
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite")), realMainBefore, "real main untouched");
});

test("legacy hardlinked main keeps the real inode; sidecars quarantined", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    const realMain = path.join(real, "state_5.sqlite");
    const ino0 = fs.lstatSync(realMain).ino;
    const realMainBefore = fs.readFileSync(realMain);
    fs.linkSync(realMain, path.join(overlay, "state_5.sqlite"));
    fs.writeFileSync(path.join(overlay, "state_5.sqlite-wal"), "STALE-WAL-BYTES");

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("#1917")), "legacy migration must be announced");
    const st = fs.lstatSync(realMain);
    assert.equal(st.ino, ino0, "real home keeps the original inode");
    assert.equal(st.nlink, 1, "the shared link must be broken");
    assert.ok(!fs.existsSync(path.join(overlay, "state_5.sqlite.bili-conflict")));
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite-wal.bili-conflict")), Buffer.from("STALE-WAL-BYTES"));
    assert.deepEqual(fs.readFileSync(realMain), realMainBefore);
});

test("merge-back rolls back cleanly when the real slot is blocked", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(path.join(real, "state_5.sqlite"), { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, "state_5.sqlite"), "PRIVATE-MAIN");

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("could not merge")), "blocked merge must be reported");
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), Buffer.from("PRIVATE-MAIN"), "set stays for the next launch");
    assert.ok(fs.statSync(path.join(real, "state_5.sqlite")).isDirectory(), "blocked slot untouched");
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no partial conflict state: ${n}`);
    }
});

test("prepareCodexHome gives codex a private db copy while owning config/.env", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgText = '[model]\nname = "x"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), cfgText);
    fs.writeFileSync(path.join(codexHome, ".env"), "MY_VAR=keep\n");
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tok":1}\n');
    buildDb(root, codexHome, "state_5.sqlite", "1:a,2:b", "", true);
    const mainBefore = fs.readFileSync(path.join(codexHome, "state_5.sqlite"));

    const overlay = prepareCodexHome({
        codexHome,
        origin: "http://127.0.0.1:8899",
        caPath: "/nonexistent/ca.pem",
        conversationId: "conv-42",
        manageRouting: true,
    });
    assert.equal(overlay, `${codexHome}-bili`);
    assert.ok(fs.readFileSync(path.join(overlay!, "config.toml"), "utf8").includes("[mcp_servers.bili]"));
    assert.ok(fs.readFileSync(path.join(overlay!, "config.toml"), "utf8").includes("conv-42"));
    const envText = fs.readFileSync(path.join(overlay!, ".env"), "utf8");
    assert.ok(envText.includes("BILLION_CONTEXT_PROXY=http://127.0.0.1:8899"));
    assert.ok(envText.includes("MY_VAR=keep"));
    const st = fs.lstatSync(path.join(overlay!, "state_5.sqlite"));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.nlink, 1, "codex db must be a private copy, not a shared link");
    assert.deepEqual(fs.readFileSync(path.join(overlay!, "state_5.sqlite")), mainBefore);
    assert.deepEqual(rowsOf(path.join(overlay!, "state_5.sqlite")), [1, 2]);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), cfgText, "real config untouched");
    assert.deepEqual(fs.readFileSync(path.join(codexHome, "state_5.sqlite")), mainBefore, "real db untouched");
});

test("sequential relaunch merges back silently: no warning, no conflict files (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    fs.writeFileSync(path.join(real, "config.toml"), "[x]\n");

    // Launch 1: cold copy into the overlay.
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    assert.ok(fs.existsSync(path.join(overlay, SQLITE_ORIGIN_FILE)), "origin snapshot recorded at copy time");

    // Normal bili session: write through the OVERLAY db only, close cleanly.
    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    const db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db.close();

    // Launch 2: both sides hold a main — the NORMAL steady state, not a
    // divergence. Must merge silently.
    const T = Date.now() / 1000;
    touch(ov, T);
    touch(re, T - 60);
    const errs2 = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs2.some((e) => e.includes("diverge") || e.includes("distinct")), `no spurious divergence on sequential use: ${JSON.stringify(errs2)}`);
    assert.deepEqual(rowsOf(re), [1, 2], "winner keeps all rows");
    for (const dir of [real, overlay]) {
        for (const n of fs.readdirSync(dir)) {
            assert.ok(!n.includes("bili-conflict"), `no conflict accumulation in ${dir}: ${n}`);
        }
    }
    assert.ok(!fs.existsSync(path.join(real, SQLITE_ORIGIN_FILE)), "origin metadata never leaks into the real home");
    const st = fs.lstatSync(ov);
    assert.ok(st.isFile() && st.nlink === 1, "steady state: overlay holds a fresh private copy");
    assert.deepEqual(rowsOf(ov), [1, 2]);

    // Launch 3 with no writes at all: still silent, still no conflicts.
    const errs3 = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs3.some((e) => e.includes("diverge") || e.includes("distinct")), `no spurious divergence on idle relaunch: ${JSON.stringify(errs3)}`);
    assert.deepEqual(rowsOf(re), [1, 2]);
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict accumulation in real home: ${n}`);
    }
});

test("fresh home: an overlay-created db is copied back on relaunch (#1951)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    // Fresh home: config only, no db yet — unlike every other relaunch test, which
    // pre-seeds the db in the real home (the gap this regression slipped through).
    fs.writeFileSync(path.join(real, "config.toml"), "[x]\n");

    // Launch 1: cold start copies only config; codex has not created its db yet.
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    assert.ok(!fs.existsSync(path.join(overlay, "state_5.sqlite")), "fresh home starts without a db");

    // Simulated bili session: create a brand-new db in the ACTIVE overlay home with
    // one session sentinel, then close cleanly.
    const ov = path.join(overlay, "state_5.sqlite");
    const db = new sqliteCtor(ov);
    db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO threads VALUES(?)").run("first-session");
    db.close();

    // Launch 2: the new db must reach BOTH homes — merged into real AND copied back
    // into this launch's active CODEX_HOME (the regression left the overlay empty).
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("could not merge")), `merge must succeed: ${JSON.stringify(errs)}`);

    const re = path.join(real, "state_5.sqlite");
    assert.ok(fs.existsSync(re), "merged db lands in the real home");
    assert.ok(fs.existsSync(ov), "second launch retains the db in its active CODEX_HOME");
    assert.equal(fs.lstatSync(ov).nlink, 1, "active db is a private copy, not a shared link");
    const check = new sqliteCtor(ov);
    try {
        const rows = check.prepare("SELECT id FROM threads ORDER BY id").all().map((r) => String(r.id));
        assert.deepEqual(rows, ["first-session"], "the previous run's session sentinel survives in the active db");
    } finally {
        check.close();
    }
});

test("true divergence with the REAL side as loser still warns and preserves (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    let db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db.close();
    db = new sqliteCtor(re);
    db.prepare("INSERT INTO t VALUES(3, 'viaReal')").run();
    db.close();

    // Overlay generation is newer → wins; the REAL side lost and differs from
    // what bili copied → genuine divergence: loud warning + preserved loser.
    const T = Date.now() / 1000;
    touch(ov, T);
    touch(re, T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("diverge")), "true divergence must be reported loudly");
    assert.deepEqual(rowsOf(re), [1, 2], "newer generation wins the merge-back");
    const conflict = path.join(real, "state_5.sqlite.bili-conflict");
    assert.deepEqual(rowsOf(conflict), [1, 3], "diverged real generation survives intact in the conflict file");
});

test("concurrent plain run with an idle bili: no warning, plain side wins (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));

    // Plain run advances the REAL home; the bili session did nothing.
    const re = path.join(real, "state_5.sqlite");
    const db = new sqliteCtor(re);
    db.prepare("INSERT INTO t VALUES(3, 'viaReal')").run();
    db.close();

    const T = Date.now() / 1000;
    touch(re, T);
    touch(path.join(overlay, "state_5.sqlite"), T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct")), `unmodified bili copy is not a divergence: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(re), [1, 3], "plain-run rows kept");
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict for an unmodified loser: ${n}`);
    }
    assert.deepEqual(rowsOf(path.join(overlay, "state_5.sqlite")), [1, 3], "overlay re-copied from the merged set");
});

test("missing origin record falls back to warn-and-preserve (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    fs.rmSync(path.join(overlay, SQLITE_ORIGIN_FILE), { force: true });

    const ov = path.join(overlay, "state_5.sqlite");
    const re = path.join(real, "state_5.sqlite");
    const db2 = new sqliteCtor(ov);
    db2.prepare("INSERT INTO t VALUES(2, 'viaOverlay')").run();
    db2.close();

    const T = Date.now() / 1000;
    touch(ov, T);
    touch(re, T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("diverge")), "without provenance the conservative warning must fire");
    assert.deepEqual(rowsOf(re), [1, 2]);
    assert.deepEqual(rowsOf(path.join(real, "state_5.sqlite.bili-conflict")), [1], "loser preserved when provenance is unknown");
});

test("crashed set: stale loser WAL dropped silently once replayed into the winner (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    // Crashed launch: row 10 checkpointed into main, row 11 left in the WAL.
    buildDb(root, real, "state_5.sqlite", "10:a", "11:tail", false);
    assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    assert.ok(fs.existsSync(path.join(overlay, "state_5.sqlite-wal")), "crashed set copied whole");

    // The bili session opens the overlay db: recovery replays the copied WAL
    // into the overlay main, then a clean close removes the overlay sidecars.
    const ov = path.join(overlay, "state_5.sqlite");
    assert.deepEqual(rowsOf(ov), [10, 11], "recovery replays the copied WAL against its main");
    const db = new sqliteCtor(ov);
    db.prepare("INSERT INTO t VALUES(12, 'viaOverlay')").run();
    db.close();

    const T = Date.now() / 1000;
    touch(ov, T);
    touch(path.join(real, "state_5.sqlite"), T - 60);
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("diverge") || e.includes("distinct")), `replayed WAL is not a divergence: ${JSON.stringify(errs)}`);
    assert.deepEqual(rowsOf(path.join(real, "state_5.sqlite")), [10, 11, 12], "WAL tail recovered into the merged main");
    assert.ok(quickCheckOk(path.join(real, "state_5.sqlite")));
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict for the stale crashed set: ${n}`);
    }
});

test("isSqliteMain accepts uppercase extensions (#1919)", () => {
    assert.equal(isSqliteMain("STATE_5.DB", new Set()), true);
    assert.equal(isSqliteMain("Logs.SQLITE", new Set()), true);
    assert.equal(isSqliteMain("cache.Sqlite3", new Set()), true);
    assert.equal(isSqliteMain("X.WAL", new Set()), false);
    assert.equal(isSqliteMain("X.SHM", new Set()), false);
    assert.equal(isSqliteMain("x.JOURNAL", new Set()), false);
});

test("a directory named like a db is mirrored, not copied as a db set (#1919)", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(path.join(real, "logs.db", "inner"), { recursive: true });
    fs.writeFileSync(path.join(real, "logs.db", "inner", "note.txt"), "keep\n");
    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(!errs.some((e) => e.includes("could not link")), `directory must not land in linkFailures: ${JSON.stringify(errs)}`);
    const st = fs.lstatSync(path.join(overlay, "logs.db"));
    assert.ok(st.isDirectory() || st.isSymbolicLink(), "directory mirrored via the ordinary link path");
    assert.equal(fs.readFileSync(path.join(overlay, "logs.db", "inner", "note.txt"), "utf8"), "keep\n");
    for (const n of fs.readdirSync(real)) {
        assert.ok(!n.includes("bili-conflict"), `no conflict files from a db-named directory: ${n}`);
    }
});

test("relative legacy symlink to the real main is migrated too (#1919)", (t) => {
    if (!sqliteCtor) {
        t.skip("node:sqlite unavailable on this Node");
        return;
    }
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = path.join(root, "real");
    const overlay = path.join(root, "overlay");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(overlay, { recursive: true });
    buildDb(root, real, "state_5.sqlite", "1:seed", "", true);
    const realMainBefore = fs.readFileSync(path.join(real, "state_5.sqlite"));
    // RELATIVE target spelling — the exact-string readlink match used to miss it.
    fs.symlinkSync(path.join("..", "real", "state_5.sqlite"), path.join(overlay, "state_5.sqlite"));

    const errs = capturedErrors(() => {
        assert.ok(refreshOverlayHome(real, overlay, ["config.toml"]));
    });
    assert.ok(errs.some((e) => e.includes("#1917")), "legacy migration must be announced for relative links too");
    const st = fs.lstatSync(path.join(overlay, "state_5.sqlite"));
    assert.ok(st.isFile() && !st.isSymbolicLink(), "relative symlink replaced by a private copy");
    assert.equal(st.nlink, 1);
    assert.deepEqual(fs.readFileSync(path.join(overlay, "state_5.sqlite")), realMainBefore);
    assert.deepEqual(fs.readFileSync(path.join(real, "state_5.sqlite")), realMainBefore, "real main untouched");
});
