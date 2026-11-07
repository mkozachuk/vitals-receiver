import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";

/**
 * `npm run deliveries -- [--since YYYY-MM-DD]` -- how often did healthd reach us?
 *
 * One row per local calendar day (the process timezone, named in the header)
 * from the window start to today inclusive, zero days included:
 *
 *   date  deliveries  first  last  longest_gap
 *
 * first/last are local HH:MM:SS; longest_gap is the longest gap between two
 * consecutive deliveries inside that local day, as h:mm (minutes floored).
 * `-` where there is nothing to show. A final `total` line sums the column.
 *
 * Read-only by construction: the store is opened with
 * `{ readonly: true, fileMustExist: true }`, never through the app's own
 * opener (which creates directories, switches journal mode and upgrades the
 * schema). The only SQL reads `received_at` from `deliveries` -- no sample
 * table, no health value. A missing store is reported, never created.
 *
 * One SQLite fact, measured: the store runs in WAL mode, and a read-only
 * connection to a WAL database whose `-wal`/`-shm` sidecars are absent creates
 * them (empty). With the daemon running they already exist; the database file
 * itself is never written.
 *
 * Exit codes: 0 report printed; 1 store missing or unreadable; 2 bad arguments.
 * Every failure is one line on stderr and nothing on stdout.
 */

export class UsageError extends Error {}

export interface Args {
  since: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD, or null. `2026-02-30` is not one. */
export function parseDate(raw: string): string | null {
  const m = DATE_RE.exec(raw);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return raw;
}

export function parseArgs(argv: readonly string[]): Args {
  let since: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    let value: string | undefined;
    if (arg === "--since") {
      value = argv[++i];
    } else if (arg.startsWith("--since=")) {
      value = arg.slice("--since=".length);
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}; usage: deliveries [--since YYYY-MM-DD]`);
    }
    if (since !== null) throw new UsageError("--since given more than once");
    if (value === undefined) throw new UsageError("--since needs a date, YYYY-MM-DD");
    const parsed = parseDate(value);
    if (parsed === null) throw new UsageError(`--since: not a calendar date in YYYY-MM-DD: ${JSON.stringify(value)}`);
    since = parsed;
  }
  return { since };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local calendar date of an instant, in the process timezone. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** The next local calendar date. Built from fields, not +24h: DST days are 23 or 25 hours long. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d + 1, 12));
}

/** Milliseconds as h:mm, minutes floored. */
export function formatGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}`;
}

export interface DayRow {
  date: string;
  deliveries: number;
  first: string;
  last: string;
  longestGap: string;
}

/**
 * Rows from `start` to `today` inclusive. `instants` are delivery times in ms;
 * deliveries outside the window are ignored.
 */
export function buildRows(instants: readonly number[], start: string, today: string): DayRow[] {
  const byDay = new Map<string, number[]>();
  for (const ms of instants) {
    const day = localDate(new Date(ms));
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [ms]);
    else list.push(ms);
  }
  const rows: DayRow[] = [];
  for (let day = start; day <= today; day = nextDate(day)) {
    const times = (byDay.get(day) ?? []).slice().sort((a, b) => a - b);
    let longest = -1;
    for (let i = 1; i < times.length; i++) longest = Math.max(longest, (times[i] as number) - (times[i - 1] as number));
    rows.push({
      date: day,
      deliveries: times.length,
      first: times.length > 0 ? localTime(new Date(times[0] as number)) : "-",
      last: times.length > 0 ? localTime(new Date(times[times.length - 1] as number)) : "-",
      longestGap: times.length >= 2 ? formatGap(longest) : "-",
    });
  }
  return rows;
}

export function render(rows: readonly DayRow[], timezone: string): string {
  const table = [
    ["date", "deliveries", "first", "last", "longest_gap"],
    ...rows.map((r) => [r.date, String(r.deliveries), r.first, r.last, r.longestGap]),
  ];
  const widths = table[0]!.map((_, c) => Math.max(...table.map((row) => (row[c] as string).length)));
  const line = (row: string[]): string => row.map((cell, c) => cell.padEnd(widths[c] as number)).join("  ").trimEnd();
  const total = rows.reduce((sum, r) => sum + r.deliveries, 0);
  return [`timezone ${timezone}`, ...table.map(line), `total ${total}`].join("\n") + "\n";
}

/** Delivery instants from the store, read-only. Throws if the file is missing. */
export function readInstants(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT received_at FROM deliveries ORDER BY received_at").all() as { received_at: string }[];
    const out: number[] = [];
    for (const r of rows) {
      const ms = Date.parse(r.received_at);
      if (Number.isFinite(ms)) out.push(ms);
    }
    return out;
  } finally {
    db.close();
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(argv: readonly string[], env: NodeJS.ProcessEnv, now: Date): RunResult {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return { code: 2, stdout: "", stderr: `vitals deliveries: ${error.message}\n` };
    throw error;
  }

  let dbPath: string;
  let instants: number[];
  try {
    dbPath = loadConfig(env).dbPath;
  } catch (error) {
    return { code: 1, stdout: "", stderr: `vitals deliveries: ${(error as Error).message}\n` };
  }
  // Checked first so the message is ours; fileMustExist is the guarantee.
  if (!fs.existsSync(dbPath)) {
    return { code: 1, stdout: "", stderr: `vitals deliveries: no store at ${dbPath}\n` };
  }
  try {
    instants = readInstants(dbPath);
  } catch (error) {
    return { code: 1, stdout: "", stderr: `vitals deliveries: cannot read the store: ${(error as Error).message}\n` };
  }

  let start = args.since;
  if (start === null) {
    if (instants.length === 0) return { code: 0, stdout: "no deliveries\n", stderr: "" };
    start = localDate(new Date(Math.min(...instants)));
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = buildRows(instants, start, localDate(now));
  return { code: 0, stdout: render(rows, timezone), stderr: "" };
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const result = run(process.argv.slice(2), process.env, new Date());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
