import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildReadServer } from "../src/read.js";
import { countInFlight, isLoopbackHost, RESTART_EXIT, restartSwitch, type RestartSwitch } from "../src/restart.js";
import { createShutdown } from "../src/stop.js";
import { createStore } from "../src/store.js";
import { count, harness, TOKEN } from "./helpers.js";

/**
 * `POST /api/restart` on the read listener: the guard in the shared
 * contract's order (RC2), the 200 before anything is armed (RC3), the one
 * stop path (VR4), the in-flight ingest refusal (VR5). The configured read
 * port here is a number only -- nothing ever listens on it; the real-socket
 * tests listen on an ephemeral port and send the configured Host by hand.
 */

const PORT = 47999;
const HOST = `127.0.0.1:${PORT}`;
const OK_BODY = '{"restarting":true,"exit_code":75}';
// Every test here is bounded: a broken route fails, it never hangs (SD-480-2).
const BOUND = { timeout: 10_000 };

interface Fake extends RestartSwitch {
  calls: { force: boolean; inFlight: number }[];
  inFlightNow: number;
}

function fakeSwitch(onRequest?: () => void): Fake {
  const fake: Fake = {
    calls: [],
    inFlightNow: 0,
    inFlight: () => fake.inFlightNow,
    request(opts) {
      fake.calls.push(opts);
      onRequest?.();
    },
  };
  return fake;
}

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((s) => s.close()));
});

function readServer(opts: { restart?: RestartSwitch; env?: Record<string, string> } = {}): FastifyInstance {
  const config = loadConfig({ VITALS_DB: ":memory:", VITALS_READ_PORT: String(PORT), ...(opts.env ?? {}) });
  const db = openDb(config.dbPath);
  const store = createStore(db, {
    dbPath: config.dbPath,
    tokenHeader: config.tokenHeader,
    truncatedAfterMinutes: config.truncatedAfterMinutes,
  });
  const read = buildReadServer({ store, config, ...(opts.restart ? { restart: opts.restart } : {}) });
  open.push({ close: async () => { await read.close(); db.close(); } });
  return read;
}

const JSON_HEADERS = { host: HOST, "content-type": "application/json" };

async function post(app: FastifyInstance, payload: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/restart", payload, headers: { ...JSON_HEADERS, ...headers } });
  return { status: res.statusCode, body: res.body, headers: res.headers, json: safeJson(res.body) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertRefused(
  r: { status: number; json: unknown; headers: Record<string, unknown> },
  status: number,
  field: string,
  fake: Fake,
): void {
  assert.equal(r.status, status, JSON.stringify(r.json));
  const body = r.json as { error?: unknown; field?: unknown; detail?: unknown };
  assert.equal(body.error, "restart_refused");
  assert.equal(body.field, field);
  assert.equal(typeof body.detail, "string");
  assert.equal(fake.calls.length, 0, "a refusal must arm nothing");
  assertNoCors(r.headers);
}

function assertNoCors(headers: Record<string, unknown>): void {
  for (const name of Object.keys(headers)) {
    assert.ok(!name.toLowerCase().startsWith("access-control-"), `no ${name} on a restart answer`);
  }
}

describe("POST /api/restart: the 200", () => {
  it("answers exactly the contract's body, then arms the switch once", BOUND, async () => {
    const fake = fakeSwitch();
    const r = await post(readServer({ restart: fake }), "{}");
    assert.equal(r.status, 200);
    assert.equal(r.body, OK_BODY);
    assert.deepEqual(fake.calls, [{ force: false, inFlight: 0 }]);
    assertNoCors(r.headers);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
  });

  it("takes localhost:<port>, a media-type parameter and Sec-Fetch-Site: none", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    for (const headers of [
      { host: `localhost:${PORT}` },
      { host: `LOCALHOST:${PORT}` },
      { "content-type": "application/json; charset=utf-8" },
      { "sec-fetch-site": "none" },
    ]) {
      const r = await post(app, "{}", headers);
      assert.equal(r.status, 200, JSON.stringify(headers));
    }
    assert.equal(fake.calls.length, 4);
  });

  it("validates force and passes it on: false and absent are the same", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    assert.equal((await post(app, '{"force":false}')).status, 200);
    assert.equal((await post(app, '{"force":true}')).status, 200);
    assert.deepEqual(fake.calls, [
      { force: false, inFlight: 0 },
      { force: true, inFlight: 0 },
    ]);
  });

  it("without a switch, runs the guard and then answers 503", BOUND, async () => {
    const app = readServer();
    const refused = await post(app, "{}", { origin: "http://example.invalid" });
    assert.equal(refused.status, 403);
    const r = await post(app, "{}");
    assert.equal(r.status, 503);
    assert.equal((r.json as { error: string }).error, "restart_unavailable");
  });
});

describe("POST /api/restart: the guard (RC2)", () => {
  it("a) refuses a Host that is not the configured loopback port", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    for (const host of [`127.0.0.1:${PORT + 1}`, "127.0.0.1", `example.invalid:${PORT}`, `127.0.0.2:${PORT}`, `[::1]:${PORT}`, ""]) {
      assertRefused(await post(app, "{}", { host }), 403, "host", fake);
    }
  });

  it("a) refuses two Host headers, on a real socket, and keeps running", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const raw = await rawRequest(
      app,
      `POST /api/restart HTTP/1.1\r\nHost: ${HOST}\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    // Node hands both Host lines to the route (rawHeaders), so the guard's
    // own count answers -- the contract's 403, not a framework 400.
    assert.equal(Number(raw.split(" ")[1]), 403, raw);
    assert.match(raw, /"field":"host"/);
    assert.equal(fake.calls.length, 0);
    assert.doesNotMatch(raw, /access-control-/i);
    // Still serving.
    const again = await httpPost(app, "{}");
    assert.equal(again.status, 200);
  });

  it("b) refuses any Origin, and any Sec-Fetch-Site but none", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    for (const origin of [`http://${HOST}`, "null", "http://example.invalid"]) {
      assertRefused(await post(app, "{}", { origin }), 403, "origin", fake);
    }
    for (const site of ["same-origin", "same-site", "cross-site", ""]) {
      assertRefused(await post(app, "{}", { "sec-fetch-site": site }), 403, "sec-fetch-site", fake);
    }
  });

  it("c) refuses a media type that is not application/json", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx"]) {
      assertRefused(await post(app, "{}", { "content-type": type }), 415, "content_type", fake);
    }
    const res = await app.inject({ method: "POST", url: "/api/restart", payload: "{}", headers: { host: HOST } });
    assert.equal(res.statusCode, 415, "no Content-Type at all");
    assert.equal(fake.calls.length, 0);
  });

  it("d) refuses a body over 1024 bytes with 413", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    const big = JSON.stringify({ force: false, pad: "x".repeat(1100) });
    assertRefused(await post(app, big), 413, "body", fake);
  });

  it("d) refuses a body that is not a JSON object", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    for (const body of ["", "nope", "{", "[]", "null", "1", '"x"', "true"]) {
      assertRefused(await post(app, body), 400, "body", fake);
    }
  });

  it("d) refuses any member but force, naming it", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    assertRefused(await post(app, '{"now":true}'), 400, "now", fake);
    assertRefused(await post(app, '{"force":true,"delay":5}'), 400, "delay", fake);
  });

  it("d) refuses a force that is not a JSON boolean", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    for (const value of ['"yes"', "1", "0", "null", "[]", "{}", '"true"']) {
      assertRefused(await post(app, `{"force":${value}}`), 400, "force", fake);
    }
  });

  it("runs in the contract's order: host, origin, sec-fetch-site, content_type, size, body", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    const big = "x".repeat(2000);
    const worst = { host: "example.invalid", origin: "http://example.invalid", "sec-fetch-site": "cross-site", "content-type": "text/plain" };
    assertRefused(await post(app, big, worst), 403, "host", fake);
    assertRefused(await post(app, big, { ...worst, host: HOST }), 403, "origin", fake);
    const { origin: _o, ...noOrigin } = worst;
    assertRefused(await post(app, big, { ...noOrigin, host: HOST }), 403, "sec-fetch-site", fake);
    assertRefused(await post(app, big, { host: HOST, "content-type": "text/plain" }), 415, "content_type", fake);
    assertRefused(await post(app, big), 413, "body", fake);
    assertRefused(await post(app, '{"force":"no"}'), 400, "force", fake);
  });
});

describe("POST /api/restart: the listener around it", () => {
  it("is the only write the read listener lets through; every other one is today's 405", BOUND, async () => {
    const fake = fakeSwitch();
    const app = readServer({ restart: fake });
    const today = await app.inject({ method: "POST", url: "/healthz", payload: "{}", headers: JSON_HEADERS });
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/restart", payload: "{}", headers: JSON_HEADERS });
      assert.equal(res.statusCode, 405, method);
      assert.equal(res.headers.allow, "GET, HEAD");
      assert.equal(res.body, today.body, "byte for byte the listener's 405");
    }
    for (const url of ["/api/restart/", "/api/restart/x", "/API/RESTART", "/healthz"]) {
      const res = await app.inject({ method: "POST", url, payload: "{}", headers: JSON_HEADERS });
      assert.equal(res.statusCode, 405, url);
      assert.equal(res.body, today.body);
    }
    for (const method of ["GET", "HEAD"] as const) {
      const res = await app.inject({ method, url: "/api/restart", headers: { host: HOST } });
      assert.equal(res.statusCode, 405, method);
      assert.equal(res.headers.allow, "POST");
    }
    assert.equal(fake.calls.length, 0);
  });

  it("does not exist on a read listener bound beyond loopback (VR2): 404, nothing armed", BOUND, async () => {
    for (const host of ["0.0.0.0", "::", "example.invalid"]) {
      const fake = fakeSwitch();
      const app = readServer({ restart: fake, env: { VITALS_READ_HOST: host } });
      const r = await post(app, "{}");
      assert.equal(r.status, 404, host);
      assert.equal(fake.calls.length, 0);
      const get = await app.inject({ method: "GET", url: "/api/restart", headers: { host: HOST } });
      assert.equal(get.statusCode, 404);
    }
  });

  it("knows which bind hosts are loopback", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LocalHost"]) assert.ok(isLoopbackHost(host), host);
    for (const host of ["0.0.0.0", "::", "127.0.0.2", "example.invalid", ""]) assert.ok(!isLoopbackHost(host), host);
  });

  it("is not a restart on the ingest listener: there it is a delivery like any POST (VR1)", BOUND, async () => {
    const h = harness();
    try {
      const authed = await h.post("{}", { url: "/api/restart" });
      assert.equal(authed.statusCode, 200);
      assert.deepEqual(authed.json, { ok: true, stored: 0, quarantined: 1 });
      const unauthed = await h.post("{}", { url: "/api/restart", token: null });
      assert.equal(unauthed.statusCode, 401);
      assert.equal(count(h.db, "deliveries"), 2);
      const paths = h.db.prepare("SELECT path FROM deliveries").all() as { path: string }[];
      assert.deepEqual(paths.map((p) => p.path), ["/api/restart", "/api/restart"]);
      assert.ok(!JSON.stringify(authed.json).includes("restarting"));
    } finally {
      await h.close();
    }
  });
});

describe("POST /api/restart: the 200 is on the wire before anything is armed (RC3)", () => {
  it("delivers the full body even when arming tears every connection down at once", BOUND, async () => {
    let app: FastifyInstance | null = null;
    // The harshest stand-in for the real stop: every socket dies the moment
    // the switch is armed. A 200 written after arming would arrive as a reset.
    const fake = fakeSwitch(() => app?.server.closeAllConnections());
    app = readServer({ restart: fake });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const r = await httpPost(app, "{}");
    assert.equal(r.status, 200);
    assert.equal(r.body, OK_BODY);
    assert.equal(fake.calls.length, 1);
  });
});

describe("POST /api/restart: refused while ingest is in flight (VR5)", () => {
  it("409 with one held-open delivery, 200 with force, 200 once it is gone", BOUND, async () => {
    const h = harness();
    const inFlight = countInFlight(h.ingest);
    const logLines: string[] = [];
    const stops: [string, number][] = [];
    const real = restartSwitch({ inFlight, shutdown: (reason, code) => stops.push([reason, code]), log: (l) => logLines.push(l) });
    const app = readServer({ restart: real });
    await h.ingest.listen({ host: "127.0.0.1", port: 0 });
    const port = (h.ingest.server.address() as net.AddressInfo).port;
    const held = net.connect(port, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => held.once("connect", () => resolve()));
      // Headers and half a body: the delivery is in progress, not finished.
      held.write(
        `POST /ingest HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
          `${h.config.tokenHeader}: ${TOKEN}\r\nContent-Length: 100\r\n\r\n{"schemaVersion":`,
      );
      await until(() => inFlight() === 1);

      const refused = await post(app, "{}");
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.json, { error: "ingest in progress", inFlight: 1 });
      assert.equal((await post(app, '{"force":false}')).status, 409);
      assert.deepEqual(stops, [], "a 409 arms nothing");

      const forced = await post(app, '{"force":true}');
      assert.equal(forced.status, 200);
      assert.equal(forced.body, OK_BODY);
      assert.deepEqual(stops, [["restart requested", RESTART_EXIT]]);
      const warnings = logLines.filter((l) => l.includes("WARNING"));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /force/);

      held.destroy();
      await until(() => inFlight() === 0);
      const clear = await post(app, "{}");
      assert.equal(clear.status, 200);
      assert.equal(logLines.filter((l) => l.includes("WARNING")).length, 1, "no warning without an override");
      assert.equal(stops.length, 2);
    } finally {
      held.destroy();
      await h.close();
    }
  });

  it("counts a finished delivery out again", BOUND, async () => {
    const h = harness();
    const inFlight = countInFlight(h.ingest);
    try {
      await h.post("{}");
      await h.post("{}", { token: null });
      assert.equal(inFlight(), 0);
    } finally {
      await h.close();
    }
  });
});

describe("the one stop path (VR4)", () => {
  function rig() {
    const events: string[] = [];
    const exits: number[] = [];
    const server = (name: string) => ({
      close: async () => void events.push(`close ${name}`),
      closeAllConnections: () => (events.push(`force ${name}`), 0),
    });
    const db = {
      pragma: (sql: string) => void events.push(`pragma ${sql}`),
      close: () => void events.push("db close"),
    } as unknown as Parameters<typeof createShutdown>[0]["db"];
    const lines: string[] = [];
    const stop = createShutdown({
      servers: [server("ingest"), server("read")],
      db,
      log: (l) => lines.push(l),
      exit: (code) => void exits.push(code),
      drainCapSeconds: 10,
    });
    return { events, exits, lines, stop };
  }

  it("a signal: logs as today, closes both listeners, checkpoints, closes the DB, exits 0", BOUND, async () => {
    const r = rig();
    await r.stop("SIGTERM", 0);
    assert.deepEqual(r.lines, ["vitals: SIGTERM, closing"]);
    assert.deepEqual(r.events, ["close ingest", "close read", "pragma wal_checkpoint(TRUNCATE)", "db close"]);
    assert.deepEqual(r.exits, [0]);
  });

  it("the restart: the same steps, a line naming the restart, exit 75", BOUND, async () => {
    const r = rig();
    const sw = restartSwitch({ inFlight: () => 0, shutdown: r.stop, log: (l) => r.lines.push(l) });
    sw.request({ force: false, inFlight: 0 });
    await until(() => r.exits.length === 1);
    assert.deepEqual(r.lines, ["vitals: restart requested, closing"]);
    assert.deepEqual(r.events, ["close ingest", "close read", "pragma wal_checkpoint(TRUNCATE)", "db close"]);
    assert.deepEqual(r.exits, [RESTART_EXIT]);
    assert.equal(RESTART_EXIT, 75);
  });

  it("runs once: a signal during a restart is ignored", BOUND, async () => {
    const r = rig();
    await Promise.all([r.stop("restart requested", 75), r.stop("SIGTERM", 0), r.stop("SIGINT", 0)]);
    assert.deepEqual(r.exits, [75]);
    assert.equal(r.lines.length, 1);
  });
});

// ---------------------------------------------------------------------------

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function listenPort(app: FastifyInstance): number {
  return (app.server.address() as net.AddressInfo).port;
}

/** A real HTTP POST to the ephemeral port, carrying the configured Host. */
function httpPost(app: FastifyInstance, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: listenPort(app),
        method: "POST",
        path: "/api/restart",
        headers: { host: HOST, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Raw bytes in, raw bytes out: http.request would fold two Host headers into one. */
function rawRequest(app: FastifyInstance, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(listenPort(app), "127.0.0.1");
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (c: string) => (out += c));
    sock.on("end", () => resolve(out));
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
    sock.write(text);
  });
}
