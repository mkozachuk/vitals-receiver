import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildReadServer } from "../src/read.js";
import { REPO_ROOT, resolveSha, runningSha, shortCommit, startupLine } from "../src/startup.js";
import { createStore } from "../src/store.js";
import { git, tempRepo } from "./helpers.js";

/**
 * RC6 / VR6. The full running commit, resolved once at start and held;
 * `/healthz` gains exactly one key for it. Every repository here is a temp
 * one -- nothing reads the commit of anything but this checkout and those.
 */

const SHA = /^[0-9a-f]{40}$/;

describe("sha resolution", () => {
  it("reads the full commit of this checkout", () => {
    assert.match(resolveSha(REPO_ROOT) ?? "", SHA);
  });

  it("is the HEAD of a repository, all 40 hex", () => {
    const dir = tempRepo("vitals-nb481-sha-");
    try {
      assert.equal(resolveSha(dir), git(dir, "rev-parse", "HEAD"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works from a git worktree, where .git is a file, and names the worktree's HEAD", () => {
    const main = tempRepo("vitals-nb481-wt-");
    const wt = `${main}-wt`;
    try {
      git(main, "worktree", "add", "-q", "-b", "side", wt);
      fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
      git(wt, "add", "b.txt");
      git(wt, "commit", "-q", "-m", "two");
      assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), ".git is a file in a worktree");
      const head = git(wt, "rev-parse", "HEAD");
      assert.notEqual(head, git(main, "rev-parse", "HEAD"));
      assert.equal(resolveSha(wt), head);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it("is null, with exactly one WARNING, for a directory that is not a checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitals-nb481-none-"));
    try {
      const lines: string[] = [];
      assert.equal(runningSha((l) => lines.push(l), dir), null);
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /^vitals: WARNING .*sha is null/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null, with exactly one WARNING, when git is absent -- and does not throw", () => {
    const lines: string[] = [];
    assert.equal(runningSha((l) => lines.push(l), REPO_ROOT, { git: "/nonexistent/git-nb481" }), null);
    assert.equal(lines.length, 1);
  });

  it("logs nothing when it resolves", () => {
    const lines: string[] = [];
    assert.match(runningSha((l) => lines.push(l)) ?? "", SHA);
    assert.deepEqual(lines, []);
  });

  it("feeds the startup line its 12-hex prefix, under the existing commit token", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(shortCommit(sha), "0123456789ab");
    assert.equal(shortCommit(null), "unknown");
    const at = Date.parse("2026-10-25T20:00:00.000Z");
    assert.equal(startupLine(at, shortCommit(sha)), "vitals: started 2026-10-25T20:00:00.000Z commit 0123456789ab");
  });
});

describe("/healthz sha", () => {
  function serve(sha?: string | null) {
    const config = loadConfig({ VITALS_DB: ":memory:" });
    const db = openDb(config.dbPath);
    const store = createStore(db, {
      dbPath: config.dbPath,
      tokenHeader: config.tokenHeader,
      truncatedAfterMinutes: config.truncatedAfterMinutes,
    });
    const read = buildReadServer({ store, config, ...(sha !== undefined ? { sha } : {}) });
    return { store, read, close: async () => { await read.close(); db.close(); } };
  }

  it("adds exactly one key to the store's health, and changes no other key or status", async () => {
    const s = serve("0123456789abcdef0123456789abcdef01234567");
    try {
      const res = await s.read.inject({ method: "GET", url: "/healthz" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      const before = Object.keys(s.store.health());
      assert.deepEqual(Object.keys(body), [...before, "sha"], "additive, at the end, nothing else");
      assert.equal(body.sha, "0123456789abcdef0123456789abcdef01234567");
    } finally {
      await s.close();
    }
  });

  it("is null when unresolved, and when the server was given none", async () => {
    for (const sha of [null, undefined]) {
      const s = serve(sha);
      try {
        const body = JSON.parse((await s.read.inject({ method: "GET", url: "/healthz" })).body) as Record<string, unknown>;
        assert.ok("sha" in body);
        assert.equal(body.sha, null);
      } finally {
        await s.close();
      }
    }
  });

  it("is held: a new commit after start does not change what the server reports", async () => {
    const dir = tempRepo("vitals-nb481-held-");
    try {
      const first = resolveSha(dir);
      const s = serve(first);
      try {
        fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
        git(dir, "add", "b.txt");
        git(dir, "commit", "-q", "-m", "two");
        assert.notEqual(git(dir, "rev-parse", "HEAD"), first);
        const body = JSON.parse((await s.read.inject({ method: "GET", url: "/healthz" })).body) as { sha: unknown };
        assert.equal(body.sha, first);
      } finally {
        await s.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
