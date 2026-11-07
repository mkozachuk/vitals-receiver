import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { buildIngestServer } from "../src/ingest.js";
import { buildReadServer } from "../src/read.js";
import { createStore, type Store } from "../src/store.js";
import { staticTokenSource } from "../src/token.js";

/**
 * One harness per test: an in-memory database, the real ingest and read
 * servers, and a credential that is not read from disk. Nothing here touches
 * the owner's store -- a test that can write to ~/Library/Application Support
 * is a test that can destroy health data.
 */

export const TOKEN = "0123456789abcdef0123456789abcdef";
export const WRONG_TOKEN = "0123456789abcdef0123456789abcdee";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, "fixtures");

/** Fixture bytes, verbatim. No JSON round-trip: the bytes are the contract. */
export function fixtureBytes(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

export interface PostOptions {
  token?: string | null;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * A harness may pin the clock the READ SERVER reads. Fixtures in this suite
 * are dated (2026-09-19); judging them against `new Date()` is what made
 * seven tests go red on the calendar rather than on a commit.
 */
export interface HarnessOptions {
  /**
   * Pinned clock for BOTH servers -- the read side's "today" and the ingest
   * side's `received_at`. One clock, so a delivery never arrives from the
   * future. Omitted = the real clock, as in production.
   */
  now?: () => Date;
}

/**
 * A clock pinned to `base` that still moves: `base`, `base + 1ms`, `base + 2ms`, ...
 *
 * Frozen-solid is the wrong instrument. Production orders events by
 * `received_at` -- `unauthorisedIsCurrent` (src/fitness.ts) asks whether the
 * last rejected sign-in is NEWER than the last good export -- and a clock that
 * hands the same millisecond to every caller collapses that ordering, turning
 * a real assertion into a vacuous one. Pinned to the fixture calendar,
 * monotonic within the test: the date stops mattering, the order does not.
 */
export function pinnedClock(base: Date): () => Date {
  let tick = 0;
  return () => {
    const at = new Date(base.getTime() + tick);
    tick += 1;
    return at;
  };
}

export interface Harness {
  config: Config;
  db: Db;
  store: Store;
  ingest: FastifyInstance;
  read: FastifyInstance;
  logLines: string[];
  post(body: string, opts?: PostOptions): Promise<{ statusCode: number; json: unknown }>;
  close(): Promise<void>;
}

export function harness(env: Record<string, string> = {}, opts: HarnessOptions = {}): Harness {
  const config = loadConfig({ VITALS_DB: ":memory:", ...env });
  const db = openDb(config.dbPath);
  const store = createStore(db, {
    dbPath: config.dbPath,
    tokenHeader: config.tokenHeader,
    truncatedAfterMinutes: config.truncatedAfterMinutes,
  });
  const logLines: string[] = [];
  // Spread rather than `now: opts.now`: under `exactOptionalPropertyTypes` an
  // optional property means ABSENT, not `undefined`. Omitting it is also the
  // shape production uses -- src/server.ts passes no clock at all -- so an
  // unpinned harness exercises the identical code path the daemon does.
  const clock = opts.now ? { now: opts.now } : {};
  const ingest = buildIngestServer({
    config,
    store,
    token: staticTokenSource(TOKEN),
    log: (line) => logLines.push(line),
    ...clock,
  });
  const read = buildReadServer({ store, config, ...clock });

  return {
    config,
    db,
    store,
    ingest,
    read,
    logLines,
    async post(body, opts: PostOptions = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
      const token = opts.token === undefined ? TOKEN : opts.token;
      if (token !== null) headers[config.tokenHeader] = token;
      const res = await ingest.inject({ method: "POST", url: opts.url ?? "/ingest", payload: body, headers });
      let json: unknown = null;
      try {
        json = res.body.length > 0 ? JSON.parse(res.body) : null;
      } catch {
        json = res.body;
      }
      return { statusCode: res.statusCode, json };
    },
    async close() {
      await Promise.allSettled([ingest.close(), read.close()]);
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic payloads. Shaped like payload.md, never copied from it: the two
// golden fixtures are the only claim in this suite about what healthd really
// sends, and they are byte-compared against the document itself.
// ---------------------------------------------------------------------------

export interface SampleOverrides {
  uuid?: string;
  id?: string;
  type?: string;
  group?: string;
  source?: string;
  start?: string;
  end?: string;
  value?: number;
  unit?: string;
}

export function quantitySample(overrides: SampleOverrides = {}): Record<string, unknown> {
  const start = overrides.start ?? "2026-09-19T08:00:00.000+02:00";
  return {
    uuid: overrides.uuid ?? "AAAAAAAA-0000-4000-8000-000000000001",
    id: overrides.id ?? "a".repeat(64),
    type: overrides.type ?? "HKQuantityTypeIdentifierHeartRate",
    group: overrides.group ?? "heart",
    source: overrides.source ?? "com.apple.health.00000000-0000-0000-0000-000000000000",
    start,
    end: overrides.end ?? start,
    kind: "quantity",
    value: overrides.value ?? 61,
    unit: overrides.unit ?? "count/min",
  };
}

export interface EnvelopeOverrides {
  /**
   * The occasion keys. Omitted unless a test asks for them, so the DEFAULT
   * body below stays the nine-key envelope -- which is exactly what a healthd
   * older than these fields sends, and therefore keeps backward compatibility
   * under test on every other call in this suite.
   */
  basis?: string;
  occasionStart?: string;
  occasionEnd?: string;
  exportId?: string;
  generatedAt?: string;
  batchSequence?: number;
  isFinalBatch?: boolean;
  windowStart?: string;
  windowEnd?: string;
  connectivityTest?: boolean;
  schemaVersion?: number;
  samples?: unknown[];
}

/** The nine required keys, encoded the way healthd encodes: unindented, no
 *  spaces. The three occasion keys appear only when a test supplies them. */
export function envelope(overrides: EnvelopeOverrides = {}): string {
  const occasion: Record<string, unknown> = {};
  if (overrides.basis !== undefined) occasion.basis = overrides.basis;
  if (overrides.occasionStart !== undefined) occasion.occasionStart = overrides.occasionStart;
  if (overrides.occasionEnd !== undefined) occasion.occasionEnd = overrides.occasionEnd;
  return JSON.stringify({
    schemaVersion: overrides.schemaVersion ?? 1,
    connectivityTest: overrides.connectivityTest ?? false,
    exportId: overrides.exportId ?? "11111111-2222-4333-8444-555555555555",
    generatedAt: overrides.generatedAt ?? "2026-09-19T12:00:00.000+02:00",
    batchSequence: overrides.batchSequence ?? 1,
    isFinalBatch: overrides.isFinalBatch ?? false,
    windowStart: overrides.windowStart ?? "2026-09-18T12:00:00.000+02:00",
    windowEnd: overrides.windowEnd ?? "2026-09-19T12:00:00.000+02:00",
    ...occasion,
    samples: overrides.samples ?? [],
  });
}

export function rows<T = Record<string, unknown>>(db: Db, sql: string, params: Record<string, unknown> = {}): T[] {
  const stmt = db.prepare(sql);
  return (Object.keys(params).length > 0 ? stmt.all(params) : stmt.all()) as T[];
}

export function one<T = Record<string, unknown>>(db: Db, sql: string, params: Record<string, unknown> = {}): T {
  const all = rows<T>(db, sql, params);
  if (all.length !== 1) throw new Error(`expected exactly one row, got ${all.length}: ${sql}`);
  return all[0] as T;
}

export function count(db: Db, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS v FROM ${table}`).get() as { v: number }).v);
}

// ---------------------------------------------------------------------------
// Temp git repositories: hermetic, never the checkout under test.
// ---------------------------------------------------------------------------

/** git with the caller's GIT_* stripped and a fixed identity: hermetic. */
export function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return execFileSync(
    "git",
    ["-c", "user.name=vitals-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export function tempRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}
