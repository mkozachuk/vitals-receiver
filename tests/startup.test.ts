import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildReadServer } from "../src/read.js";
import { REPO_ROOT, resolveCommit, startupLine } from "../src/startup.js";
import { createStore } from "../src/store.js";

/**
 * The receiver says when it started, once in the log and on
 * /healthz, from one instant -- so a day with no deliveries can be read as
 * "receiver was down" or "phone never sent". Every instant here is pinned.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LINE = /^vitals: started (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) commit ([0-9a-f]{7,40}|unknown)$/;
const STARTED = Date.parse("2026-10-12T01:02:03.456Z");

describe("the startup line", () => {
  it("has the exact shape, from the instant it is given", () => {
    assert.equal(startupLine(STARTED, "c394f73"), "vitals: started 2026-10-12T01:02:03.456Z commit c394f73");
    assert.match(startupLine(STARTED, "unknown"), LINE);
  });

  it("never prints a commit it cannot vouch for", () => {
    assert.equal(startupLine(STARTED, "/opt/vitals/repo"), "vitals: started 2026-10-12T01:02:03.456Z commit unknown");
    assert.equal(startupLine(STARTED, ""), "vitals: started 2026-10-12T01:02:03.456Z commit unknown");
  });

  it("names no path, hostname or address", () => {
    const line = startupLine(STARTED, resolveCommit());
    assert.match(line, LINE);
    assert.ok(!line.includes("/"), "no path separator");
    assert.ok(!line.includes(os.hostname()), "no hostname");
    assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(line), "no IPv4 address");
    assert.ok(!/:\d{4,5}\b/.test(line), "no port");
  });
});

describe("commit resolution", () => {
  it("reads the commit of this checkout", () => {
    assert.match(resolveCommit(REPO_ROOT), /^[0-9a-f]{7,40}$/);
  });

  it("says unknown for a directory that is not a repository", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitals-nb176-"));
    try {
      // Even when the temp dir sits inside some other repository: the
      // ceiling stops git at the directory it was asked about.
      assert.equal(resolveCommit(dir), "unknown");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says unknown when git is absent, and does not throw", () => {
    assert.equal(resolveCommit(REPO_ROOT, { git: "/nonexistent/git-nb176" }), "unknown");
  });
});

describe("/healthz startedAt", () => {
  it("is the store's startedAt, as ISO, and the same instant the line prints", async () => {
    const config = loadConfig({ VITALS_DB: ":memory:" });
    const db = openDb(config.dbPath);
    const store = createStore(db, {
      startedAt: STARTED,
      dbPath: config.dbPath,
      tokenHeader: config.tokenHeader,
      truncatedAfterMinutes: config.truncatedAfterMinutes,
    });
    const read = buildReadServer({ store, config });
    try {
      const res = await read.inject({ method: "GET", url: "/healthz" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { startedAt: unknown };
      assert.equal(body.startedAt, "2026-10-12T01:02:03.456Z");
      assert.match(String(body.startedAt), ISO);
      const fromLine = LINE.exec(startupLine(STARTED, "unknown"))?.[1];
      assert.equal(fromLine, body.startedAt, "one instant, two places");
    } finally {
      await read.close();
      db.close();
    }
  });
});
