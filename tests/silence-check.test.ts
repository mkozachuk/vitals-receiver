import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { check, parseHours, targetName } from "../scripts/silence-check.js";

/**
 * healthd S-11c. The script's whole contract is its stdout: a scheduler
 * delivers it verbatim and stays quiet when it is empty. So every branch is
 * driven against a real HTTP server on an ephemeral port, and the empty and
 * non-empty cases are asserted exactly -- "printed nothing" is the feature.
 */

const LAST = "2026-10-03T21:18:05.505Z";
const LAST_MS = Date.parse(LAST);
const HOUR = 3_600_000;
const at = (offsetMs: number): Date => new Date(LAST_MS + offsetMs);

type Handler = (res: http.ServerResponse) => void;
let handler: Handler = (res) => res.end();
let server: http.Server;
let base: string;

const json = (status: number, body: unknown): Handler => (res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("silence check: fresh", () => {
  it("prints nothing when the last export is inside the threshold", async () => {
    handler = json(200, { ok: true, lastExportAt: LAST });
    assert.deepEqual(await check({ url: base, hours: 24, now: at(2 * HOUR) }), { stdout: null });
  });

  it("treats exactly the threshold as fresh", async () => {
    handler = json(200, { ok: true, lastExportAt: LAST });
    assert.equal((await check({ url: base, hours: 24, now: at(24 * HOUR) })).stdout, null);
  });

  it("treats a last export from the future (clock skew) as fresh", async () => {
    handler = json(200, { ok: true, lastExportAt: LAST });
    assert.equal((await check({ url: base, hours: 24, now: at(-HOUR) })).stdout, null);
  });
});

describe("silence check: stale", () => {
  it("says so one millisecond past the threshold", async () => {
    handler = json(200, { ok: true, lastExportAt: LAST });
    const { stdout } = await check({ url: base, hours: 24, now: at(24 * HOUR + 1) });
    assert.equal(stdout, `vitals: no healthd export for 24 h (last at ${LAST}, threshold 24 h)`);
  });

  it("names the hours since the last export and its timestamp, on one line", async () => {
    handler = json(200, { ok: true, lastExportAt: LAST });
    const { stdout } = await check({ url: base, hours: 24, now: at(30 * HOUR + 59 * 60_000) });
    assert.equal(stdout, `vitals: no healthd export for 30 h (last at ${LAST}, threshold 24 h)`);
    assert.doesNotMatch(stdout ?? "", /\n/);
  });

  it("honours a custom threshold", async () => {
    handler = json(200, { ok: true, lastExportAt: LAST });
    assert.equal((await check({ url: base, hours: 6, now: at(5 * HOUR) })).stdout, null);
    assert.match((await check({ url: base, hours: 6, now: at(7 * HOUR) })).stdout ?? "", /for 7 h .*threshold 6 h/);
  });
});

describe("silence check: never", () => {
  it("says no export has ever arrived when lastExportAt is null", async () => {
    handler = json(200, { ok: true, lastExportAt: null });
    const { stdout } = await check({ url: base, hours: 24, now: at(0) });
    assert.equal(stdout, "vitals: no healthd export has ever arrived");
  });
});

describe("silence check: receiver down", () => {
  it("reports an unreachable receiver with its error class", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { stdout } = await check({ url: `http://127.0.0.1:${port}`, hours: 24, now: at(0) });
    assert.equal(
      stdout,
      `vitals: the receiver at 127.0.0.1:${port} is down (ECONNREFUSED); cannot tell whether healthd is still exporting`,
    );
  });

  it("reports a non-200 as down, even when the body carries a fresh lastExportAt", async () => {
    handler = json(503, { ok: false, dbWritable: false, lastExportAt: LAST });
    const { stdout } = await check({ url: base, hours: 24, now: at(HOUR) });
    assert.match(stdout ?? "", /^vitals: the receiver at 127\.0\.0\.1:\d+ is down \(http-503\)/);
  });

  it("reports a body that is not JSON as down", async () => {
    handler = (res) => res.end("<html>not json</html>");
    assert.match((await check({ url: base, hours: 24, now: at(0) })).stdout ?? "", /is down \(bad-json\)/);
  });

  it("reports JSON without a usable lastExportAt as down", async () => {
    handler = json(200, { ok: true });
    assert.match((await check({ url: base, hours: 24, now: at(0) })).stdout ?? "", /is down \(bad-body\)/);
    handler = json(200, { ok: true, lastExportAt: "yesterday-ish" });
    assert.match((await check({ url: base, hours: 24, now: at(0) })).stdout ?? "", /is down \(bad-body\)/);
  });

  it("reports a receiver that never answers as a timeout", async () => {
    handler = () => undefined; // hold the request open
    const { stdout } = await check({ url: base, hours: 24, now: at(0), timeoutMs: 100 });
    assert.match(stdout ?? "", /is down \(timeout\)/);
  });

  it("never names a non-loopback host, not even through the DNS error", async () => {
    const { stdout } = await check({ url: "http://silence-check.invalid:4780", hours: 24, now: at(0), timeoutMs: 3_000 });
    assert.match(stdout ?? "", /^vitals: the receiver is down \([A-Za-z0-9_-]+\);/);
    assert.doesNotMatch(stdout ?? "", /silence-check|invalid|4780/);
  });

  it("only treats loopback hosts as nameable", () => {
    assert.equal(targetName("http://127.0.0.1:4780"), "the receiver at 127.0.0.1:4780");
    assert.equal(targetName("http://localhost:4780"), "the receiver at localhost:4780");
    assert.equal(targetName("http://[::1]:4780"), "the receiver at [::1]:4780");
    assert.equal(targetName("http://10.0.0.7:4780"), "the receiver");
    assert.equal(targetName("http://127.0.0.1.example.com:4780"), "the receiver");
    assert.equal(targetName("not a url"), "the receiver");
  });
});

describe("silence check: threshold from the environment", () => {
  it("defaults to 24 silently and accepts a positive number", () => {
    assert.deepEqual(parseHours(undefined), { hours: 24, warning: null });
    assert.deepEqual(parseHours("6"), { hours: 6, warning: null });
    assert.deepEqual(parseHours("1.5"), { hours: 1.5, warning: null });
  });

  it("falls back to 24 with a warning on anything else", () => {
    for (const raw of ["", "abc", "0", "-3", "Infinity", "NaN"]) {
      const { hours, warning } = parseHours(raw);
      assert.equal(hours, 24, raw);
      assert.match(warning ?? "", /not a positive number; using 24/, raw);
    }
  });
});

describe("silence check: the process", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, "..", "scripts", "silence-check.ts");
  // Async on purpose: the stub server lives in this process, and a
  // synchronous spawn would block the very event loop that has to answer it.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  it("is silent on stdout and exits 0 when fresh", async () => {
    handler = json(200, { ok: true, lastExportAt: new Date().toISOString() });
    const r = await run({ VITALS_URL: base, VITALS_SILENCE_HOURS: "24" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });

  it("puts an invalid threshold warning on stderr only, and still runs on 24", async () => {
    handler = json(200, { ok: true, lastExportAt: new Date(Date.now() - 23 * HOUR).toISOString() });
    const r = await run({ VITALS_URL: base, VITALS_SILENCE_HOURS: "soon" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /VITALS_SILENCE_HOURS="soon" is not a positive number; using 24/);
  });

  it("prints one line and still exits 0 when the receiver is down", async () => {
    handler = json(500, {});
    const r = await run({ VITALS_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^vitals: the receiver at 127\.0\.0\.1:\d+ is down \(http-500\);[^\n]*\n$/);
  });
});
