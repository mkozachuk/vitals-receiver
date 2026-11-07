import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { RESTART_EXIT } from "../src/restart.js";
import { createShutdown } from "../src/stop.js";

/**
 * The stop's drain is capped. DC1 (the config key) and the unit half
 * of DC8 (createShutdown with fake listeners). Every test is bounded.
 */

const BOUND = { timeout: 10_000 };
const WARNING = /WARNING.*drain cap/;

describe("VITALS_DRAIN_CAP_SECONDS (DC1)", () => {
  it("defaults to 10 and takes a fraction", BOUND, () => {
    assert.equal(loadConfig({}).drainCapSeconds, 10);
    assert.equal(loadConfig({ VITALS_DRAIN_CAP_SECONDS: "2.5" }).drainCapSeconds, 2.5);
  });

  it("refuses 0, a negative and a non-number, naming the key", BOUND, () => {
    for (const raw of ["0", "-1", "abc"]) {
      assert.throws(() => loadConfig({ VITALS_DRAIN_CAP_SECONDS: raw }), /VITALS_DRAIN_CAP_SECONDS/, raw);
    }
  });
});

function timeouts(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

function rig(opts: { cap: number; hang: boolean }) {
  const events: string[] = [];
  const exits: number[] = [];
  const lines: string[] = [];
  const server = (name: string, open: number) => ({
    close: () => {
      events.push(`close ${name}`);
      return opts.hang ? new Promise<void>(() => {}) : Promise.resolve();
    },
    closeAllConnections: () => {
      events.push(`force ${name}`);
      return open;
    },
  });
  const db = {
    pragma: (sql: string) => void events.push(`pragma ${sql}`),
    close: () => void events.push("db close"),
  } as unknown as Parameters<typeof createShutdown>[0]["db"];
  const stop = createShutdown({
    servers: [server("ingest", 2), server("read", 1)],
    db,
    log: (l) => lines.push(l),
    exit: (code) => void exits.push(code),
    drainCapSeconds: opts.cap,
  });
  return { events, exits, lines, stop };
}

describe("the drain cap (DC4, DC8)", () => {
  it("a drain that never ends: after the cap every listener is force-closed, then checkpoint, close, exit", BOUND, async () => {
    const r = rig({ cap: 0.05, hang: true });
    const t0 = Date.now();
    await r.stop("restart requested", RESTART_EXIT);
    assert.ok(Date.now() - t0 >= 40, "waited the cap");
    assert.deepEqual(r.events, [
      "close ingest",
      "close read",
      "force ingest",
      "force read",
      "pragma wal_checkpoint(TRUNCATE)",
      "db close",
    ]);
    assert.deepEqual(r.exits, [75], "the exit code is the caller's, capped or not");
    const warnings = r.lines.filter((l) => WARNING.test(l));
    assert.equal(warnings.length, 1, r.lines.join("\n"));
    assert.match(warnings[0] ?? "", /drain cap 0\.05s/);
    assert.match(warnings[0] ?? "", /closed 3 connection/);
  });

  it("a drain that never ends after a signal still exits 0", BOUND, async () => {
    const r = rig({ cap: 0.05, hang: true });
    await r.stop("SIGTERM", 0);
    assert.deepEqual(r.exits, [0]);
  });

  it("a drain inside the cap: no force close, no WARNING, the timer cleared", BOUND, async () => {
    const r = rig({ cap: 5, hang: false });
    const before = timeouts();
    const t0 = Date.now();
    await r.stop("SIGTERM", 0);
    assert.ok(Date.now() - t0 < 1000, "did not wait the cap out");
    assert.deepEqual(r.events, ["close ingest", "close read", "pragma wal_checkpoint(TRUNCATE)", "db close"]);
    assert.deepEqual(r.exits, [0]);
    assert.equal(r.lines.filter((l) => WARNING.test(l)).length, 0);
    assert.equal(timeouts(), before, "no cap timer left pending");
  });

  it("runs once: a second call during a capped stop is ignored", BOUND, async () => {
    const r = rig({ cap: 0.05, hang: true });
    await Promise.all([r.stop("SIGTERM", 0), r.stop("restart requested", RESTART_EXIT), r.stop("SIGINT", 0)]);
    assert.deepEqual(r.exits, [0]);
    assert.equal(r.events.filter((e) => e.startsWith("force ")).length, 2);
    assert.equal(r.events.filter((e) => e === "db close").length, 1);
    assert.equal(r.lines.filter((l) => WARNING.test(l)).length, 1);
  });
});
