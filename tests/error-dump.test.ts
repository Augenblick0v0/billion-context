import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureDump4xx, configureDump4xxMaxBytes, dumpRejectedBody } from "../src/error-dump.js";
import { setLogCapture } from "../src/logger.js";
import { rmrf } from "./tmp-rm.ts";

// #762: failure-triggered dump of the exact forwarded body on upstream 4xx.

const savedDir = process.env.ACP_DUMP_DIR;

function restoreDumpConfig(): void {
    configureDump4xx(false);
    configureDump4xxMaxBytes(undefined);
}

let dir: string;
before(() => {
    setLogCapture(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-error-dump-"));
    process.env.ACP_DUMP_DIR = dir;
});

after(() => {
    setLogCapture(null);
    restoreDumpConfig();
    if (savedDir === undefined) delete process.env.ACP_DUMP_DIR;
    else process.env.ACP_DUMP_DIR = savedDir;
    rmrf(dir);
});

function errFiles(): string[] {
    return fs.readdirSync(dir).filter((f) => f.startsWith("err-"));
}

test("off by default: no file written", () => {
    configureDump4xx(false);
    assert.equal(dumpRejectedBody(400, "s1", '{"model":"m","messages":[]}'), null);
    assert.deepEqual(errFiles(), []);
});

test("on: JSON body is pretty-printed and parseable", () => {
    configureDump4xx(true);
    try {
        const out = dumpRejectedBody(400, "s1", '{"model":"m","messages":[{"role":"user","content":"u"}]}');
        assert.ok(out && out.startsWith(dir));
        const files = errFiles();
        assert.equal(files.length, 1);
        assert.match(files[0]!, /^err-\d+-s1-400\.json$/);
        const parsed = JSON.parse(fs.readFileSync(out!, "utf8")) as { model: string; messages: unknown[] };
        assert.equal(parsed.model, "m");
        assert.equal(parsed.messages.length, 1);
    } finally {
        restoreDumpConfig();
    }
});

test("on: non-JSON body passes through raw", () => {
    configureDump4xx(true);
    try {
        const out = dumpRejectedBody(400, "s1", "<html>bad gateway</html>");
        assert.ok(out);
        assert.equal(fs.readFileSync(out!, "utf8"), "<html>bad gateway</html>");
    } finally {
        restoreDumpConfig();
    }
});

test("on: oversized body is capped with a truncation marker", () => {
    configureDump4xx(true);
    configureDump4xxMaxBytes(2048);
    try {
        const raw = `{"payload":"${"x".repeat(5000)}"`;
        const out = dumpRejectedBody(413, "s1", raw);
        assert.ok(out);
        const text = fs.readFileSync(out!, "utf8");
        assert.ok(text.length < raw.length + 100, `capped file should be smaller than raw (${text.length} vs ${raw.length})`);
        assert.match(text, /\[truncated: \d+ more character\(s\)\]/);
        assert.match(path.basename(out!), /^err-\d+-s1-413\.json$/);
    } finally {
        restoreDumpConfig();
    }
});

test("on: empty body is skipped", () => {
    configureDump4xx(true);
    try {
        const beforeCount = errFiles().length;
        assert.equal(dumpRejectedBody(400, "s1", ""), null);
        assert.equal(errFiles().length, beforeCount);
    } finally {
        restoreDumpConfig();
    }
});

test("on: Buffer bodies work and session ids are sanitized", () => {
    configureDump4xx(true);
    try {
        const out = dumpRejectedBody(400, "a/b c", Buffer.from('{"a":1}', "utf8"));
        assert.ok(out);
        assert.match(path.basename(out!), /^err-\d+-a_b_c-400\.json$/);
    } finally {
        restoreDumpConfig();
    }
});
