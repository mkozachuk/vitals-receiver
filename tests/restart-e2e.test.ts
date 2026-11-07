import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../src/startup.js";
import { mintToken } from "../src/token.js";
import { git } from "./helpers.js";

/**
 * RC4 / RC5 / RC6 on a real process. The daemon's own entry point
 * (`src/server.ts`) runs from a git WORKTREE of a temp repository holding a
 * copy of this checkout's src/, with a temp state dir (DB + a minted token),
 * both listeners on loopback ephemeral ports, and a stand-in for launchd's
 * KeepAlive=true: relaunch on any exit. Nothing here reads the owner's state
 * dir or the live checkout, and nothing talks to the live daemon's ports.
 *
 * Bounded (SD-480-2): the whole test fails within 30 s, and every child is
 * SIGKILLed in `finally` whatever happened.
 */

const OK_BODY = '{"restarting":true,"exit_code":75}';
const SHA = /^[0-9a-f]{40}$/;

/** `p`, or a rejection after `ms` -- and the timer is always cleared. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} not within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** True when the port can be bound again, i.e. nothing is listening on it. */
async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function request(port: number, method: string, urlPath: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent: false, timeout: 2000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function healthz(port: number, withinMs: number): Promise<{ sha: unknown; ok: unknown }> {
  const end = Date.now() + withinMs;
  for (;;) {
    try {
      const res = await request(port, "GET", "/healthz");
      if (res.status === 200) return JSON.parse(res.body) as { sha: unknown; ok: unknown };
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`no /healthz on ${port} within ${withinMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Run {
  child: ChildProcess;
  out: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

/**
 * launchd's KeepAlive = true, in miniature: every exit is relaunched, after
 * `between` (where the test checks the ports were released).
 */
class Supervisor {
  runs: Run[] = [];
  private stopped = false;
  constructor(
    private readonly launch: () => Run,
    private readonly between: (exit: { code: number | null }) => Promise<void>,
  ) {}
  start(): Run {
    const run = this.launch();
    this.runs.push(run);
    void run.exited.then(async (exit) => {
      if (this.stopped) return;
      await this.between(exit);
      if (!this.stopped) this.start();
    });
    return run;
  }
  stop(): void {
    this.stopped = true;
  }
  killAll(): void {
    this.stopped = true;
    for (const r of this.runs) if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill("SIGKILL");
  }
}

describe("restart, end to end on a real process (RC4, RC5, RC6)", () => {
  it("replies, exits 75 through the normal stop, frees its ports, relaunches on the new commit", { timeout: 30_000 }, async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vitals-nb481-e2e-")));
    const repo = path.join(tmp, "repo");
    const wt = path.join(tmp, "wt");
    const state = path.join(tmp, "state");
    let sup: Supervisor | null = null;
    try {
      // A repository holding this checkout's code, and a worktree of it.
      fs.mkdirSync(repo);
      fs.cpSync(path.join(REPO_ROOT, "src"), path.join(repo, "src"), { recursive: true });
      for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(repo, f));
      fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
      git(repo, "init", "-q", "-b", "main");
      git(repo, "add", "src", "package.json", "tsconfig.json", ".gitignore");
      git(repo, "commit", "-q", "-m", "base");
      git(repo, "worktree", "add", "-q", "-b", "e2e", wt);
      assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), "runs from a worktree");
      // Dependencies, read only: the same tree this suite already imports.
      fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, "node_modules")), path.join(wt, "node_modules"), "dir");
      const firstSha = git(wt, "rev-parse", "HEAD");

      mintToken(path.join(state, "token"));
      const ingestPort = await freePort();
      const readPort = await freePort();
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith("VITALS_") || k.startsWith("GIT_") || k.startsWith("NODE_TEST") || k === "NODE_OPTIONS") continue;
        env[k] = v;
      }
      Object.assign(env, {
        VITALS_STATE_DIR: state,
        VITALS_INGEST_HOST: "127.0.0.1",
        VITALS_INGEST_PORT: String(ingestPort),
        VITALS_READ_HOST: "127.0.0.1",
        VITALS_READ_PORT: String(readPort),
      });
      const tsx = import.meta.resolve("tsx");

      const launch = (): Run => {
        const child = spawn(process.execPath, ["--import", tsx, path.join(wt, "src", "server.ts")], {
          cwd: wt,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const out: string[] = [];
        child.stdout?.setEncoding("utf8").on("data", (c: string) => out.push(c));
        child.stderr?.setEncoding("utf8").on("data", (c: string) => out.push(c));
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })),
        );
        return { child, out, exited };
      };
      const freeAfterExit: boolean[] = [];
      sup = new Supervisor(launch, async () => {
        freeAfterExit.push((await portIsFree(readPort)) && (await portIsFree(ingestPort)));
      });

      // 1. Up, on the worktree's commit.
      const first = sup.start();
      const h1 = await healthz(readPort, 15_000);
      assert.equal(h1.sha, firstSha);
      assert.match(String(h1.sha), SHA);
      assert.match(first.out.join(""), new RegExp(`vitals: started \\S+ commit ${firstSha.slice(0, 12)}\\n`));

      // 2. A new commit lands in the checkout; the running process still
      //    reports the commit it started on.
      fs.writeFileSync(path.join(wt, "DEPLOYED"), "next\n");
      git(wt, "add", "DEPLOYED");
      git(wt, "commit", "-q", "-m", "next");
      const secondSha = git(wt, "rev-parse", "HEAD");
      assert.notEqual(secondSha, firstSha);
      assert.equal((await healthz(readPort, 2000)).sha, firstSha, "held, not re-read");

      // 3. The restart: the exact 200, read in full on the client.
      const reply = await request(readPort, "POST", "/api/restart", "{}");
      const repliedAt = Date.now();
      assert.equal(reply.status, 200);
      assert.equal(reply.body, OK_BODY);

      // 4. Exit 75 within 10 s of the reply, through the normal stop.
      const exit = await within(first.exited, 10_000, "exit after the reply");
      assert.equal(exit.code, 75, first.out.join(""));
      assert.ok(exit.at - repliedAt < 10_000);
      const log1 = first.out.join("");
      assert.match(log1, /vitals: restart requested, closing\n/);
      assert.doesNotMatch(log1, /failed|Error|unhandled/i);

      // 5. Relaunched: a new pid answering /healthz within 15 s of the reply,
      //    and it runs -- and reports -- the commit now on disk.
      const h2 = await healthz(readPort, 15_000 - (Date.now() - repliedAt));
      assert.ok(Date.now() - repliedAt < 15_000);
      assert.deepEqual(freeAfterExit, [true], "both ports were released before the relaunch");
      const second = sup.runs[1];
      assert.ok(second, "the supervisor relaunched");
      assert.notEqual(second.child.pid, first.child.pid);
      assert.equal(h2.sha, secondSha);
      assert.equal(h2.ok, true);
      assert.match(second.out.join(""), new RegExp(`commit ${secondSha.slice(0, 12)}\\n`));

      // 6. SIGTERM is unchanged: same stop path, exit 0.
      sup.stop();
      second.child.kill("SIGTERM");
      const exit2 = await within(second.exited, 10_000, "exit after SIGTERM");
      assert.equal(exit2.code, 0);
      assert.match(second.out.join(""), /vitals: SIGTERM, closing\n/);
      assert.equal(await portIsFree(readPort), true);
      assert.equal(await portIsFree(ingestPort), true);
    } finally {
      sup?.killAll();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
