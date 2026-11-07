import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { openDb } from "../src/db.js";
import { formatGap, parseArgs, parseDate } from "../scripts/deliveries.js";

/**
 * The report is driven as a process, the way it is run: the
 * timezone is pinned through TZ on the child (Europe/Warsaw, CEST in the
 * fixture window), and the store is a temp file built here -- never the
 * owner's store.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "deliveries.ts");
const TZ = "Europe/Warsaw";

let dir: string;
let dbPath: string;

// UTC instants; local (CEST, +02:00) noted on the right.
const FIXTURE = [
  "2026-09-20T10:00:00.000Z", // 09-20 12:00:00 -- before the --since window
  "2026-10-01T06:00:00.000Z", // 10-01 08:00:00
  "2026-10-01T08:15:30.500Z", // 10-01 10:15:30 -> gap 2:15 (2:15:30.5, floored)
  "2026-10-01T07:00:00.000Z", // 10-01 09:00:00 -- out of order on purpose
  "2026-10-01T22:30:00.000Z", // 10-02 00:30:00 -- UTC says 10-01, local says 10-02
  // 10-03: nothing
  "2026-10-04T10:00:00.000Z", // 10-04 12:00:00
  "2026-10-04T10:00:59.999Z", // 10-04 12:00:59 -> gap 0:00
];

interface Proc {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = { VITALS_DB: dbPath }): Proc {
  // The owner's own VITALS_* must not leak in: unset, not empty -- loadConfig
  // takes "" as a path.
  const base = { ...process.env };
  delete base.VITALS_DB;
  delete base.VITALS_STATE_DIR;
  const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    env: { ...base, ...env, TZ },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Data rows keyed by date: [deliveries, first, last, longest_gap]. */
function rows(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (/^\d{4}-\d{2}-\d{2}$/.test(cells[0] ?? "")) out.set(cells[0]!, cells.slice(1));
  }
  return out;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitals-deliveries-"));
  dbPath = path.join(dir, "vitals.db");
  const db = openDb(dbPath);
  const insert = db.prepare(
    "INSERT INTO deliveries (received_at, method, path, status, outcome, export_id) VALUES (?, 'POST', '/ingest', 200, 'export', 'x')",
  );
  for (const at of FIXTURE) insert.run(at);
  db.close();
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("deliveries: the report", () => {
  it("names the timezone, prints the header, and starts at the earliest delivery by default", () => {
    const r = run([]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], `timezone ${TZ}`);
    assert.deepEqual(lines[1]!.split(/\s+/), ["date", "deliveries", "first", "last", "longest_gap"]);
    assert.match(lines[2]!, /^2026-09-20\s+1\s+12:00:00\s+12:00:00\s+-$/);
  });

  it("orders deliveries in a day and floors the longest gap to minutes", () => {
    const r = rows(run(["--since", "2026-10-01"]).stdout);
    assert.deepEqual(r.get("2026-10-01"), ["3", "08:00:00", "10:15:30", "1:15"]);
    assert.deepEqual(r.get("2026-10-04"), ["2", "12:00:00", "12:00:59", "0:00"]);
  });

  it("puts a UTC timestamp that is already tomorrow locally on the local day, with a - gap for one delivery", () => {
    const r = rows(run(["--since", "2026-10-01"]).stdout);
    assert.deepEqual(r.get("2026-10-02"), ["1", "00:30:00", "00:30:00", "-"]);
  });

  it("prints zero days", () => {
    const r = rows(run(["--since", "2026-10-01"]).stdout);
    assert.deepEqual(r.get("2026-10-03"), ["0", "-", "-", "-"]);
  });

  it("--since drops earlier days and runs to today with no gaps in the calendar", () => {
    const out = run(["--since", "2026-10-01"]).stdout;
    const r = rows(out);
    assert.equal(r.has("2026-09-20"), false);
    const dates = [...r.keys()];
    assert.equal(dates[0], "2026-10-01");
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(`${dates[i - 1]}T12:00:00Z`).getTime();
      assert.equal(new Date(`${dates[i]}T12:00:00Z`).getTime() - prev, 86_400_000, `${dates[i - 1]} -> ${dates[i]}`);
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    assert.equal(dates[dates.length - 1], today);
  });

  it("ends with a total equal to the sum of the rows", () => {
    for (const args of [[], ["--since", "2026-10-01"], ["--since=2026-10-02"]]) {
      const out = run(args).stdout;
      const sum = [...rows(out).values()].reduce((s, cells) => s + Number(cells[0]), 0);
      const last = out.trimEnd().split("\n").pop();
      assert.equal(last, `total ${sum}`, args.join(" "));
    }
    assert.match(run([]).stdout, /\ntotal 7\n$/);
    assert.match(run(["--since", "2026-10-01"]).stdout, /\ntotal 6\n$/);
  });

  it("says `no deliveries` for an empty table", () => {
    const empty = path.join(dir, "empty.db");
    openDb(empty).close();
    const r = run([], { VITALS_DB: empty });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "no deliveries\n");
  });
});

describe("deliveries: bad input", () => {
  for (const args of [
    ["--since", "2026-13-01"],
    ["--since", "2026-02-30"],
    ["--since", "yesterday"],
    ["--since", "2026-10-1"],
    ["--since"],
    ["--since", "2026-10-01", "--since", "2026-10-02"],
    ["--until", "2026-10-01"],
    ["2026-10-01"],
  ]) {
    it(`exits 2 with one stderr line and empty stdout: ${args.join(" ")}`, () => {
      const r = run(args);
      assert.equal(r.status, 2);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^vitals deliveries: [^\n]+\n$/);
    });
  }

  it("parses dates strictly", () => {
    assert.equal(parseDate("2028-02-29"), "2028-02-29");
    assert.equal(parseDate("2026-02-29"), null);
    assert.deepEqual(parseArgs([]), { since: null });
    assert.deepEqual(parseArgs(["--since=2026-10-01"]), { since: "2026-10-01" });
  });

  it("formats gaps as h:mm with minutes floored", () => {
    assert.equal(formatGap(0), "0:00");
    assert.equal(formatGap(59_999), "0:00");
    assert.equal(formatGap(20 * 3_600_000 + 51 * 60_000 + 59_000), "20:51");
  });
});

describe("deliveries: read-only", () => {
  it("exits 1 on a missing store and creates nothing at that path", () => {
    const missing = path.join(dir, "nope", "vitals.db");
    const r = run([], { VITALS_DB: missing });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^vitals deliveries: no store at [^\n]+\n$/);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.existsSync(path.dirname(missing)), false);
  });

  it("follows VITALS_STATE_DIR when VITALS_DB is unset, and still creates nothing", () => {
    const state = path.join(dir, "state-missing");
    const r = run([], { VITALS_STATE_DIR: state });
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(state), false);
    const r2 = run([], { VITALS_STATE_DIR: dir });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /\ntotal 7\n$/);
  });

  it("leaves the store byte-identical; at most empty WAL sidecars appear", () => {
    const fresh = path.join(dir, "fresh");
    fs.mkdirSync(fresh);
    const store = path.join(fresh, "vitals.db");
    fs.copyFileSync(dbPath, store);
    const bytes = fs.readFileSync(store);
    assert.equal(run(["--since", "2026-10-01"], { VITALS_DB: store }).status, 0);
    assert.deepEqual(fs.readFileSync(store), bytes);
    // SQLite creates -wal/-shm for any connection to a WAL database, read-only
    // included. Nothing may be written into the log.
    const extra = fs.readdirSync(fresh).filter((f) => f !== "vitals.db").sort();
    for (const f of extra) assert.match(f, /^vitals\.db-(wal|shm)$/);
    if (extra.includes("vitals.db-wal")) assert.equal(fs.statSync(path.join(fresh, "vitals.db-wal")).size, 0);
    // Second run: nothing new at all.
    const listing = fs.readdirSync(fresh).sort();
    assert.equal(run([], { VITALS_DB: store }).status, 0);
    assert.deepEqual(fs.readdirSync(fresh).sort(), listing);
    assert.deepEqual(fs.readFileSync(store), bytes);
  });

  it("contains no write SQL and reads only received_at from deliveries", () => {
    const src = fs.readFileSync(script, "utf8");
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/);
    assert.doesNotMatch(src, /pragma|openDb|migrate/i);
    assert.match(src, /readonly: true, fileMustExist: true/);
    const sql = [...src.matchAll(/prepare\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(sql, ["SELECT received_at FROM deliveries ORDER BY received_at"]);
  });
});
