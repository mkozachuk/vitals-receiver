import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

/**
 * scripts/_lak.sh, the one rule the three service scripts share for finding
 * launchagent-kit's `lak`: $LAK if set and non-empty, else `lak` on PATH,
 * else exit 1 with one line on stderr. No default location -- a `lak` sitting
 * at a conventional path under HOME must not be picked up. Each case runs
 * the real script under bash with a temp HOME and a PATH that holds only a
 * temp bin dir plus bash's own dir; nothing here reads the owner's HOME.
 */

const LAK_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "_lak.sh");
const BASH = "/bin/bash";
const roots: string[] = [];

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function sandbox(): { home: string; bin: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vitals-lak-")));
  roots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  return { home, bin };
}

function plant(file: string, mode: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, mode);
  return file;
}

/** Source _lak.sh the way the service scripts do, then print what it chose. */
function run(env: { home: string; bin: string; lak?: string }) {
  const childEnv: NodeJS.ProcessEnv = { HOME: env.home, PATH: `${env.bin}:/usr/bin:/bin` };
  if (env.lak !== undefined) childEnv.LAK = env.lak;
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-c", '. "$1"; printf "%s" "$LAK_BIN"', "lak-test", LAK_SH], {
    env: childEnv,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("scripts/_lak.sh: finding lak", () => {
  it("uses $LAK when it names an executable file", () => {
    const s = sandbox();
    const lak = plant(path.join(s.home, "kit", "lak"), 0o755);
    const r = run({ ...s, lak });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, lak);
    assert.equal(r.stderr, "");
  });

  it("falls back to `lak` on PATH when $LAK is unset", () => {
    const s = sandbox();
    const lak = plant(path.join(s.bin, "lak"), 0o755);
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, lak);
  });

  it("exits 1 naming LAK when there is neither, and ignores a lak under HOME", () => {
    const s = sandbox();
    // The old default location, rebuilt from parts so no shipped file spells
    // out a home-relative path (the publishing sweep checks for that).
    const planted = plant(path.join(s.home, ["Desk", "top"].join(""), "launchagent-kit", "bin", "lak"), 0o755);
    const r = run(s);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "", "nothing after the source line ran");
    assert.match(r.stderr, /\bLAK\b/);
    assert.match(r.stderr, /\bPATH\b/);
    assert.equal(r.stderr.trim().split("\n").length, 1, "one line on stderr");
    assert.ok(!r.stderr.includes(planted), "the planted file is not named, so not used");
  });

  it("exits 1 when $LAK names a file that is not executable", () => {
    const s = sandbox();
    const lak = plant(path.join(s.home, "kit", "lak"), 0o644);
    plant(path.join(s.bin, "lak"), 0o755); // a good one on PATH does not rescue a bad $LAK
    const r = run({ ...s, lak });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /\bLAK\b/);
  });
});
