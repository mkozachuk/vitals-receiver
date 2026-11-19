import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { buildIngestServer, rateLimiterOf } from "../src/ingest.js";
import { buildReadServer } from "../src/read.js";
import { clientKey, createRateLimiter, type RateLimiter } from "../src/ratelimit.js";
import { createStore, type Store } from "../src/store.js";
import type { TokenSource } from "../src/token.js";
import { count, envelope, rows, TOKEN, WRONG_TOKEN } from "./helpers.js";

/**
 * NB-799: the ingest listener's rate limits. Everything runs through
 * `inject` on a clock the test holds; no test sleeps. Addresses are RFC 5737
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and RFC 3849 (2001:db8::/32)
 * documentation ranges only.
 */

const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const A = "192.0.2.10";
const B = "198.51.100.20";
const BODY = envelope();
const LIMITED = { ok: false, error: "rate limited" };

interface Rig {
  config: Config;
  db: Db;
  store: Store;
  ingest: FastifyInstance;
  limiter: RateLimiter;
  logLines: string[];
  clock: { t: number; advance(ms: number): void };
  tokenReads(): number;
  send(opts?: SendOptions): Promise<{ status: number; retryAfter: string | undefined; json: unknown }>;
}

interface SendOptions {
  from?: string;
  token?: string | null;
  method?: "POST" | "GET";
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}

const open: Rig[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) {
    await r.ingest.close();
    r.db.close();
  }
});

function rig(env: Record<string, string> = {}): Rig {
  const config = loadConfig({ VITALS_DB: ":memory:", ...env });
  const db = openDb(config.dbPath);
  const store = createStore(db, {
    dbPath: config.dbPath,
    tokenHeader: config.tokenHeader,
    truncatedAfterMinutes: config.truncatedAfterMinutes,
  });
  let reads = 0;
  const token: TokenSource = {
    current: () => {
      reads += 1;
      return TOKEN;
    },
  };
  const clock = {
    t: T0,
    advance(ms: number) {
      clock.t += ms;
    },
  };
  const logLines: string[] = [];
  const ingest = buildIngestServer({ config, store, token, log: (l) => logLines.push(l), now: () => new Date(clock.t) });
  const limiter = rateLimiterOf(ingest);
  assert.ok(limiter, "the ingest server exposes its limiter");
  const r: Rig = {
    config,
    db,
    store,
    ingest,
    limiter,
    logLines,
    clock,
    tokenReads: () => reads,
    async send(opts: SendOptions = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
      const tok = opts.token === undefined ? TOKEN : opts.token;
      if (tok !== null) headers[config.tokenHeader] = tok;
      const method = opts.method ?? "POST";
      const res = await ingest.inject({
        method,
        url: opts.url ?? "/ingest",
        headers,
        remoteAddress: opts.from ?? A,
        ...(method === "POST" ? { payload: opts.body ?? BODY } : {}),
      });
      let json: unknown = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = res.body;
      }
      const ra = res.headers["retry-after"];
      return { status: res.statusCode, retryAfter: ra === undefined ? undefined : String(ra), json };
    },
  };
  open.push(r);
  return r;
}

async function sendMany(r: Rig, n: number, opts: SendOptions = {}): Promise<Map<number, number>> {
  const statuses = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const { status } = await r.send(opts);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  return statuses;
}

function merge(a: Map<number, number>, b: Map<number, number>): Map<number, number> {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

const limitedRows = (r: Rig) =>
  rows<{ status: number; note: string; remote_addr: string; outcome: string }>(
    r.db,
    "SELECT status, note, remote_addr, outcome FROM deliveries WHERE outcome = 'rate-limited' ORDER BY id",
  );
const outcomeCount = (r: Rig, outcome: string) =>
  Number(
    (r.db.prepare("SELECT COUNT(*) AS v FROM deliveries WHERE outcome = ?").get(outcome) as { v: number }).v,
  );

describe("C1 per-IP limit", () => {
  it("answers 429 + Retry-After + the exact body once the window's budget is spent, on every method and path", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "3" });
    for (let i = 0; i < 3; i++) assert.equal((await r.send()).status, 200);

    for (const opts of [{}, { url: "/x" }, { method: "GET" as const, url: "/" }]) {
      const res = await r.send(opts);
      assert.equal(res.status, 429, JSON.stringify(opts));
      assert.deepEqual(res.json, LIMITED);
      assert.equal(res.retryAfter, "60");
    }
  });

  it("does not consult the credential and does not read the body when it refuses", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "1", VITALS_MAX_BODY_BYTES: "1000" });
    assert.equal((await r.send()).status, 200);
    const before = r.tokenReads();
    // A body over the cap would be a 413 if it were read at all.
    const res = await r.send({ body: "x".repeat(10_000) });
    assert.equal(res.status, 429);
    assert.equal(r.tokenReads(), before, "token.current() was not called for the refused request");
    assert.equal(outcomeCount(r, "oversize"), 0);
    assert.equal(outcomeCount(r, "unauthorised"), 0);
  });

  it("counts Retry-After down to the window's end, never below 1", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "1" });
    await r.send();
    r.clock.advance(20_500);
    assert.equal((await r.send()).retryAfter, "40");
    r.clock.advance(39_400);
    assert.equal((await r.send()).retryAfter, "1");
  });

  it("recovers when the window ends", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "2" });
    await sendMany(r, 2);
    assert.equal((await r.send()).status, 429);
    r.clock.advance(59_999);
    assert.equal((await r.send()).status, 429);
    r.clock.advance(1);
    assert.equal((await r.send()).status, 200);
  });

  it("keeps one bucket per client: another address is unaffected", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "1" });
    await r.send({ from: A });
    assert.equal((await r.send({ from: A })).status, 429);
    assert.equal((await r.send({ from: B })).status, 200);
  });

  it("keys IPv6 clients by /64 and IPv4-mapped IPv6 as the IPv4", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "2" });
    assert.equal((await r.send({ from: "2001:db8:1:2::a" })).status, 200);
    assert.equal((await r.send({ from: "2001:db8:1:2:ffff:ffff:ffff:1" })).status, 200);
    assert.equal((await r.send({ from: "2001:db8:1:2::b" })).status, 429, "same /64");
    assert.equal((await r.send({ from: "2001:db8:1:3::a" })).status, 200, "next /64");

    assert.equal((await r.send({ from: "::ffff:192.0.2.77" })).status, 200);
    assert.equal((await r.send({ from: "192.0.2.77" })).status, 200);
    assert.equal((await r.send({ from: "::ffff:192.0.2.77" })).status, 429, "mapped and plain share a bucket");

    assert.ok(r.limiter.keys().ip.includes("2001:db8:1:2::/64"));
    assert.ok(r.limiter.keys().ip.includes("192.0.2.77"));
  });

  it("clientKey normalises addresses", () => {
    assert.equal(clientKey("192.0.2.1"), "192.0.2.1");
    assert.equal(clientKey("::FFFF:192.0.2.1"), "192.0.2.1");
    assert.equal(clientKey("2001:DB8::1"), "2001:db8:0:0::/64");
    assert.equal(clientKey("2001:db8:aa:bb:cc:dd:ee:ff"), "2001:db8:aa:bb::/64");
    assert.equal(clientKey("fe80::1%en0"), "fe80:0:0:0::/64");
    assert.equal(clientKey("::1"), "0:0:0:0::/64");
  });
});

describe("C2 per-token limit", () => {
  it("shares one count across addresses for one credential", async () => {
    const r = rig({ VITALS_RATE_TOKEN_MAX: "4" });
    await sendMany(r, 2, { from: A });
    await sendMany(r, 2, { from: B });
    const fromB = await r.send({ from: B });
    assert.equal(fromB.status, 429);
    assert.deepEqual(fromB.json, LIMITED);
    assert.equal(fromB.retryAfter, "60");
    assert.equal((await r.send({ from: "203.0.113.5" })).status, 429, "a third address shares it too");
    // A request without the credential is not in that bucket.
    assert.equal((await r.send({ from: "203.0.113.6", token: WRONG_TOKEN })).status, 401);
  });

  it("names the bucket by hash prefix: the credential appears in no key, row or log line", async () => {
    const r = rig({ VITALS_RATE_TOKEN_MAX: "2", VITALS_RATE_IP_MAX: "3" });
    await sendMany(r, 5, { from: A });
    await sendMany(r, 5, { from: B, token: WRONG_TOKEN });
    r.clock.advance(61_000);
    await sendMany(r, 1, { from: A });

    const hash = crypto.createHash("sha256").update(TOKEN).digest("hex");
    const keys = r.limiter.keys();
    assert.ok(keys.token.length > 0);
    for (const k of keys.token) assert.equal(k, hash);
    const all = JSON.stringify({
      keys,
      log: r.logLines,
      deliveries: rows(r.db, "SELECT * FROM deliveries"),
      quarantine: rows(r.db, "SELECT * FROM quarantine"),
    });
    assert.equal(all.includes(TOKEN), false, "raw credential leaked");
    assert.equal(all.includes(WRONG_TOKEN), false, "raw wrong credential leaked");

    const tokenRow = limitedRows(r).find((row) => row.note.includes("token"));
    assert.ok(tokenRow);
    assert.equal(tokenRow.note, `rate-limited token ×1 first token=${hash.slice(0, 8)}`);
    assert.equal(tokenRow.status, 429);
  });
});

describe("C3 failed-auth budget", () => {
  it("after 10 401s in 600 s refuses everything from that client with 429, valid credential included, until the window ends", async () => {
    const r = rig();
    for (let i = 0; i < 10; i++) assert.equal((await r.send({ token: WRONG_TOKEN })).status, 401);
    const reads = r.tokenReads();

    const valid = await r.send();
    assert.equal(valid.status, 429);
    assert.deepEqual(valid.json, LIMITED);
    assert.equal(valid.retryAfter, "600");
    assert.equal((await r.send({ token: WRONG_TOKEN })).status, 429);
    assert.equal((await r.send({ token: null })).status, 429);
    assert.equal(r.tokenReads(), reads, "no credential check once the budget is spent");
    assert.equal(outcomeCount(r, "unauthorised"), 10, "no further 401 rows");

    assert.equal((await r.send({ from: B })).status, 200, "another client is unaffected");

    r.clock.advance(599_000);
    assert.equal((await r.send()).retryAfter, "1");
    r.clock.advance(1_000);
    assert.equal((await r.send()).status, 200);
  });

  it("counts only 401s: valid traffic does not spend it", async () => {
    const r = rig({ VITALS_RATE_AUTH_FAIL_MAX: "2" });
    await sendMany(r, 50);
    assert.equal((await r.send({ token: WRONG_TOKEN })).status, 401);
    assert.equal((await r.send()).status, 200);
    assert.equal((await r.send({ token: WRONG_TOKEN })).status, 401);
    assert.equal((await r.send()).status, 429);
  });
});

describe("C4 defaults and off switches", () => {
  it("parses defaults, 0, off, and fails fast on anything else", () => {
    const d = loadConfig({});
    assert.deepEqual(
      [d.rateWindowSeconds, d.rateIpMax, d.rateTokenMax, d.rateAuthFailMax, d.rateAuthFailWindowSeconds, d.rateMaxKeys, d.trustProxy],
      [60, 1200, 1200, 10, 600, 10_000, "off"],
    );
    for (const name of ["VITALS_RATE_IP_MAX", "VITALS_RATE_TOKEN_MAX", "VITALS_RATE_AUTH_FAIL_MAX"]) {
      for (const v of ["0", "off"]) {
        const c = loadConfig({ [name]: v });
        assert.equal(
          { VITALS_RATE_IP_MAX: c.rateIpMax, VITALS_RATE_TOKEN_MAX: c.rateTokenMax, VITALS_RATE_AUTH_FAIL_MAX: c.rateAuthFailMax }[name],
          0,
          `${name}=${v}`,
        );
      }
      for (const bad of ["-1", "abc", "OFF", "12x"]) assert.throws(() => loadConfig({ [name]: bad }), new RegExp(name));
    }
    for (const name of ["VITALS_RATE_WINDOW_SECONDS", "VITALS_RATE_AUTH_FAIL_WINDOW_SECONDS", "VITALS_RATE_MAX_KEYS"]) {
      for (const bad of ["0", "-5", "nope"]) assert.throws(() => loadConfig({ [name]: bad }), new RegExp(name));
    }
    assert.deepEqual(loadConfig({ VITALS_TRUST_PROXY: "loopback" }).trustProxy, "loopback");
    assert.deepEqual(loadConfig({ VITALS_TRUST_PROXY: "198.51.100.4, 2001:db8::1" }).trustProxy, ["198.51.100.4", "2001:db8::1"]);
    for (const bad of ["yes", "true", "198.51.100.300", "proxy.example"]) {
      assert.throws(() => loadConfig({ VITALS_TRUST_PROXY: bad }), /VITALS_TRUST_PROXY/);
    }
  });

  it("at defaults: 12 POSTs inside one second are all 200", async () => {
    const r = rig();
    for (let i = 0; i < 12; i++) {
      assert.equal((await r.send()).status, 200);
      r.clock.advance(80);
    }
  });

  it("at defaults: a 1000-batch backfill at 10 req/s (100 s) is all 200", async () => {
    const r = rig();
    const statuses = new Map<number, number>();
    for (let seq = 1; seq <= 1000; seq++) {
      const { status } = await r.send({ body: envelope({ batchSequence: seq, isFinalBatch: seq === 1000 }) });
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      r.clock.advance(100);
    }
    assert.deepEqual([...statuses], [[200, 1000]]);
    assert.equal(outcomeCount(r, "rate-limited"), 0);
  });

  it("at defaults: 84 deliveries over 600 s are all 200", async () => {
    const r = rig();
    const statuses = new Map<number, number>();
    for (let i = 0; i < 84; i++) {
      const { status } = await r.send();
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      r.clock.advance(Math.floor(600_000 / 84));
    }
    assert.deepEqual([...statuses], [[200, 84]]);
  });

  // Each counter switched off, under traffic that trips exactly that counter
  // at its default. The default run is the control: without it a "0 x 429"
  // would prove nothing.
  const offCases: { name: string; traffic: (r: Rig) => Promise<Map<number, number>> }[] = [
    { name: "VITALS_RATE_IP_MAX", traffic: (r) => sendMany(r, 2000, { method: "GET", url: "/", token: null }) },
    {
      name: "VITALS_RATE_TOKEN_MAX",
      traffic: async (r) => merge(await sendMany(r, 1000, { from: A }), await sendMany(r, 1000, { from: B })),
    },
    {
      name: "VITALS_RATE_AUTH_FAIL_MAX",
      traffic: async (r) =>
        merge(await sendMany(r, 1000, { from: A, token: WRONG_TOKEN }), await sendMany(r, 1000, { from: B, token: WRONG_TOKEN })),
    },
  ];
  for (const { name, traffic } of offCases) {
    it(`${name}: 0 and off each let 2000 requests in one window through with no 429 (default refuses some)`, async () => {
      const control = await traffic(rig());
      assert.ok((control.get(429) ?? 0) > 0, `control at default must refuse: ${JSON.stringify([...control])}`);
      for (const v of ["0", "off"]) {
        const statuses = await traffic(rig({ [name]: v }));
        assert.equal(statuses.get(429) ?? 0, 0, `${name}=${v}: ${JSON.stringify([...statuses])}`);
      }
    });
  }

  it("all three off: 2000 valid POSTs from one address in one window, no 429", async () => {
    for (const v of ["0", "off"]) {
      const r = rig({ VITALS_RATE_IP_MAX: v, VITALS_RATE_TOKEN_MAX: v, VITALS_RATE_AUTH_FAIL_MAX: v });
      const statuses = await sendMany(r, 2000);
      assert.deepEqual([...statuses], [[200, 2000]]);
      assert.deepEqual(r.limiter.sizes(), { ip: 0, token: 0, auth: 0 });
    }
  });
});

describe("C5 proxy-aware client address", () => {
  const FWD = "203.0.113.9";
  const keyOf = async (env: Record<string, string>, from: string, xff?: string): Promise<string> => {
    const r = rig(env);
    await r.send({ from, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    const [row] = rows<{ remote_addr: string }>(r.db, "SELECT remote_addr FROM deliveries");
    assert.ok(row);
    assert.deepEqual(r.limiter.keys().ip, [clientKey(row.remote_addr)]);
    return row.remote_addr;
  };

  it("off (default): X-Forwarded-For is ignored from any peer, loopback included", async () => {
    assert.equal(await keyOf({}, "127.0.0.1", FWD), "127.0.0.1");
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "off" }, B, FWD), B);
    assert.equal(await keyOf({}, "::1", FWD), "::1");
  });

  it("loopback: a loopback peer's X-Forwarded-For names the client", async () => {
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "loopback" }, "127.0.0.1", FWD), FWD);
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "loopback" }, "::1", FWD), FWD);
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "loopback" }, "::ffff:127.0.0.1", FWD), FWD);
  });

  it("loopback: a non-loopback peer's header is ignored", async () => {
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "loopback" }, "198.51.100.4", FWD), "198.51.100.4");
  });

  it("a listed address is trusted, an unlisted one is not", async () => {
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "198.51.100.4" }, "198.51.100.4", FWD), FWD);
    assert.equal(await keyOf({ VITALS_TRUST_PROXY: "198.51.100.4" }, "198.51.100.5", FWD), "198.51.100.5");
  });

  it("behind a trusted proxy, two forwarded clients get separate buckets", async () => {
    const r = rig({ VITALS_TRUST_PROXY: "loopback", VITALS_RATE_IP_MAX: "1" });
    const via = (xff: string) => r.send({ from: "127.0.0.1", headers: { "x-forwarded-for": xff } });
    assert.equal((await via("203.0.113.9")).status, 200);
    assert.equal((await via("203.0.113.10")).status, 200);
    assert.equal((await via("203.0.113.9")).status, 429);
    assert.equal((await via("203.0.113.10")).status, 429);
  });
});

describe("C6 refused requests cannot fill disk or log", () => {
  it("10 000 bad-credential POSTs from one address in one window: rows <= 11, log lines <= 12, no quarantine", async () => {
    const r = rig();
    const statuses = await sendMany(r, 10_000, { token: WRONG_TOKEN });
    assert.deepEqual([...statuses].sort(), [
      [401, 10],
      [429, 9990],
    ]);
    assert.equal(count(r.db, "deliveries"), 11);
    assert.equal(outcomeCount(r, "unauthorised"), 10);
    assert.deepEqual(limitedRows(r), [{ status: 429, note: `rate-limited auth ×1 first ip=${A}`, remote_addr: A, outcome: "rate-limited" }]);
    assert.equal(r.logLines.length, 11);
    assert.equal(count(r.db, "quarantine"), 0);

    // The window rolls: one summary line, then the next request is served.
    r.clock.advance(600_000);
    assert.equal((await r.send()).status, 200);
    assert.equal(r.logLines.length, 13, "x N summary + the export line");
    assert.match(r.logLines[11] ?? "", /429 rate-limited auth ip=192\.0\.2\.10 ×9990 /);
  });

  it("10 000-request GET flood from one address: 1200 404 rows + 1 rate-limited row", async () => {
    const r = rig();
    const statuses = await sendMany(r, 10_000, { method: "GET", url: "/", token: null });
    assert.deepEqual([...statuses].sort(), [
      [404, 1200],
      [429, 8800],
    ]);
    assert.equal(outcomeCount(r, "unroutable"), 1200);
    assert.equal(outcomeCount(r, "rate-limited"), 1);
    assert.equal(count(r.db, "deliveries"), 1201);
    assert.equal(r.logLines.length, 1, "404s log nothing; one first-refusal line");
    assert.equal(count(r.db, "quarantine"), 0);
  });

  it("a rate-limited row leaves /healthz and the store's health intact", async () => {
    const r = rig({ VITALS_RATE_IP_MAX: "1" });
    await r.send();
    await r.send();
    assert.equal(outcomeCount(r, "rate-limited"), 1);
    const read = buildReadServer({ store: r.store, config: r.config, now: () => new Date(r.clock.t) });
    try {
      const res = await read.inject({ method: "GET", url: "/healthz" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { unauthorised24h: number; quarantined24h: number };
      assert.equal(body.unauthorised24h, 0);
      assert.equal(body.quarantined24h, 0);
      for (const url of ["/", "/pipe", "/api/summary"]) {
        assert.equal((await read.inject({ method: "GET", url })).statusCode, 200, url);
      }
    } finally {
      await read.close();
    }
  });
});

describe("C7 bounded memory", () => {
  it("100 000 distinct IPv4 keys: every map stays at or under the cap at all times", () => {
    const cap = 10_000;
    const l = createRateLimiter({ windowMs: 60_000, ipMax: 1200, tokenMax: 1200, authFailMax: 10, authFailWindowMs: 600_000, maxKeys: cap });
    let peak = { ip: 0, token: 0, auth: 0 };
    for (let i = 0; i < 100_000; i++) {
      // 100 000 distinct IPv4 keys. RFC 5737 holds only 768 addresses, so
      // these walk 198.18.0.0/15 (RFC 2544 benchmarking: 131 072 addresses,
      // never routed, never a LAN). They never leave this process.
      const key = `198.${18 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`;
      l.checkIp(key, T0);
      l.checkToken(key, T0);
      l.noteAuthFailure(key, T0);
      const s = l.sizes();
      peak = { ip: Math.max(peak.ip, s.ip), token: Math.max(peak.token, s.token), auth: Math.max(peak.auth, s.auth) };
      if (s.ip > cap || s.token > cap || s.auth > cap) assert.fail(`over cap at key ${i}: ${JSON.stringify(s)}`);
    }
    assert.deepEqual(peak, { ip: cap, token: cap, auth: cap });
  });

  it("through the server: 500 distinct addresses against a cap of 20", async () => {
    const r = rig({ VITALS_RATE_MAX_KEYS: "20" });
    for (let i = 0; i < 500; i++) {
      await r.send({ from: `203.0.113.${i % 250}`, token: i % 2 === 0 ? WRONG_TOKEN : TOKEN, headers: { "x-n": String(i) } });
      if (i % 250 === 249) r.clock.advance(1);
      const s = r.limiter.sizes();
      assert.ok(s.ip <= 20 && s.token <= 20 && s.auth <= 20, JSON.stringify(s));
    }
  });

  it("sweeps expired windows: keys from a closed window do not linger", () => {
    const l = createRateLimiter({ windowMs: 1000, ipMax: 5, tokenMax: 5, authFailMax: 5, authFailWindowMs: 1000, maxKeys: 100 });
    for (let i = 0; i < 50; i++) l.checkIp(`192.0.2.${i}`, T0);
    assert.equal(l.sizes().ip, 50);
    l.checkIp("192.0.2.200", T0 + 1000);
    assert.equal(l.sizes().ip, 1);
  });
});
