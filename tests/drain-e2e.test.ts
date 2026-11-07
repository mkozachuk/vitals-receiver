import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { REPO_ROOT } from "../src/startup.js";
import { mintToken } from "../src/token.js";
import { count } from "./helpers.js";

/**
 * The drain cap on a real process: the daemon's own entry point (`src/server.ts`)
 * with a temp state dir and both listeners on loopback ephemeral ports.
 * Nothing here reads the owner's state dir or talks to the live daemon.
 *
 * Bounded (SD-480-2): each test fails within 30 s, and the child is
 * SIGKILLed in `finally` whatever happened.
 */

const BOUND = { timeout: 30_000 };
const BODY_BYTES = 500;
const BODY_HEAD = '{"partial":';

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

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string | number> = { ...headers };
    if (body !== undefined) h["content-length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, agent: false, timeout: 2000 }, (res) => {
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

interface Daemon {
  child: ChildProcess;
  out: string[];
  exited: Promise<{ code: number | null; at: number }>;
  ingestPort: number;
  readPort: number;
  token: string;
  dbPath: string;
}

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

/** Spawns the daemon; `track` gets the child before anything can throw. */
async function start(state: string, cap: string | undefined, track: (d: Daemon) => void): Promise<Daemon> {
  const tokenFile = path.join(state, "token");
  mintToken(tokenFile);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const ingestPort = await freePort();
  const readPort = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("VITALS_") || k.startsWith("NODE_TEST") || k === "NODE_OPTIONS") continue;
    env[k] = v;
  }
  Object.assign(env, {
    VITALS_STATE_DIR: state,
    VITALS_INGEST_HOST: "127.0.0.1",
    VITALS_INGEST_PORT: String(ingestPort),
    VITALS_READ_HOST: "127.0.0.1",
    VITALS_READ_PORT: String(readPort),
  });
  if (cap !== undefined) env.VITALS_DRAIN_CAP_SECONDS = cap;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(REPO_ROOT, "src", "server.ts")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: string[] = [];
  child.stdout?.setEncoding("utf8").on("data", (c: string) => out.push(c));
  child.stderr?.setEncoding("utf8").on("data", (c: string) => out.push(c));
  const exited = new Promise<{ code: number | null; at: number }>((resolve) =>
    child.once("exit", (code) => resolve({ code, at: Date.now() })),
  );
  const d: Daemon = { child, out, exited, ingestPort, readPort, token, dbPath: path.join(state, "vitals.db") };
  track(d);
  const end = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await request(readPort, "GET", "/healthz")).status > 0) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`no /healthz within 15 s: ${out.join("")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  // One whole delivery before the stop: it must survive it.
  const pre = await request(ingestPort, "POST", "/ingest", "not json", {
    "content-type": "application/json",
    "x-vitals-token": token,
  });
  assert.equal(pre.status, 200);
  return d;
}

/** Headers and the first bytes of a body that is never finished. */
async function holdUpload(d: Daemon): Promise<{ socket: net.Socket; received: Promise<string> }> {
  const socket = net.connect(d.ingestPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const received = new Promise<string>((resolve) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => (text += c));
    socket.on("close", () => resolve(text));
    socket.on("error", () => {});
  });
  socket.write(
    `POST /ingest HTTP/1.1\r\nHost: 127.0.0.1:${d.ingestPort}\r\nContent-Type: application/json\r\n` +
      `x-vitals-token: ${d.token}\r\nContent-Length: ${BODY_BYTES}\r\n\r\n${BODY_HEAD}`,
  );
  await new Promise((r) => setTimeout(r, 300));
  return { socket, received };
}

function rows(dbPath: string): { deliveries: number; quarantine: number; samples: number; integrity: unknown } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      deliveries: count(db, "deliveries"),
      quarantine: count(db, "quarantine"),
      samples: count(db, "samples"),
      integrity: (db.prepare("PRAGMA integrity_check").get() as { integrity_check: unknown }).integrity_check,
    };
  } finally {
    db.close();
  }
}

function walBytes(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

const WARNING = /WARNING drain cap/g;

async function withDaemon(cap: string | undefined, body: (d: Daemon) => Promise<void>): Promise<void> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vitals-nb504-")));
  let d: Daemon | null = null;
  try {
    const started = await start(path.join(tmp, "state"), cap, (spawned) => (d = spawned));
    await body(started);
  } finally {
    const child = (d as Daemon | null)?.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The cut upload left nothing; the earlier delivery is whole; the WAL is folded. */
async function assertCleanCappedStop(d: Daemon): Promise<void> {
  assert.equal(await portIsFree(d.ingestPort), true);
  assert.equal(await portIsFree(d.readPort), true);
  assert.deepEqual(rows(d.dbPath), { deliveries: 1, quarantine: 1, samples: 0, integrity: "ok" });
  assert.equal(walBytes(d.dbPath), 0);
  const log = d.out.join("");
  assert.equal(log.match(WARNING)?.length, 1, log);
  assert.match(log, /WARNING drain cap 0\.5s reached, closed 1 connection\(s\)\n/);
  assert.doesNotMatch(log, /Error|unhandled|\n\s+at /);
}

describe("the drain cap on a real process", () => {
  it("a held upload and SIGTERM: closed at the cap, exit 0, nothing half-written", BOUND, async () => {
    await withDaemon("0.5", async (d) => {
      const held = await holdUpload(d);
      const signalledAt = Date.now();
      d.child.kill("SIGTERM");
      const exit = await within(d.exited, 10_000, "exit after SIGTERM");
      assert.equal(exit.code, 0, d.out.join(""));
      assert.ok(exit.at - signalledAt <= 2000, `exit ${exit.at - signalledAt} ms after the signal`);
      assert.doesNotMatch(await within(held.received, 2000, "held socket closed"), /HTTP\/1\.1/, "no answer to a cut upload");
      await assertCleanCappedStop(d);
    });
  });

  it("a held upload and a forced restart: 200, exit 75 at the cap", BOUND, async () => {
    await withDaemon("0.5", async (d) => {
      const held = await holdUpload(d);
      const reply = await request(d.readPort, "POST", "/api/restart", '{"force":true}', {
        "content-type": "application/json",
      });
      const repliedAt = Date.now();
      assert.equal(reply.status, 200);
      assert.equal(reply.body, '{"restarting":true,"exit_code":75}');
      const exit = await within(d.exited, 10_000, "exit after the restart");
      assert.equal(exit.code, 75, d.out.join(""));
      assert.ok(exit.at - repliedAt <= 1500, `exit ${exit.at - repliedAt} ms after the reply`);
      await within(held.received, 2000, "held socket closed");
      await assertCleanCappedStop(d);
    });
  });

  it("an upload finished during the stop: committed, answered, and it does not hold the drain", BOUND, async () => {
    await withDaemon(undefined, async (d) => {
      const held = await holdUpload(d);
      d.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      const rest = '"' + "x".repeat(BODY_BYTES - BODY_HEAD.length - 3) + '"}';
      held.socket.write(rest);
      const answer = await within(held.received, 3000, "the reply, then the close");
      const answeredAt = Date.now();
      assert.match(answer, /^HTTP\/1\.1 200 /);
      const exit = await within(d.exited, 5000, "exit after the reply");
      assert.equal(exit.code, 0, d.out.join(""));
      assert.ok(exit.at - answeredAt <= 1500, `exit ${exit.at - answeredAt} ms after the reply`);
      assert.deepEqual(rows(d.dbPath), { deliveries: 2, quarantine: 2, samples: 0, integrity: "ok" });
      assert.doesNotMatch(d.out.join(""), WARNING);
    });
  });
});
