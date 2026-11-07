import os from "node:os";
import path from "node:path";

export interface Config {
  stateDir: string;
  dbPath: string;
  tokenFile: string;
  tokenHeader: string;
  ingestHost: string;
  ingestPort: number;
  readHost: string;
  readPort: number;
  maxBodyBytes: number;
  truncatedAfterMinutes: number;
  /** Ring goals for the fitness page. Apple's own defaults are per-person;
   *  these are the page's, overridable, and printed next to every ring. */
  goalMoveKcal: number;
  goalExerciseMinutes: number;
  goalStandHours: number;
  thirdRing: "stand" | "sleep" | "off";
  /** Source-id prefixes, highest priority first. Empty = highest total per day
   *  wins (see src/sources.ts). */
  sourcePriority: string[];
  /** prefix=Friendly Name, comma separated. */
  sourceNames: Record<string, string>;
  /** 0 disables the meta refresh. A wall-mounted page that never updates is a poster. */
  autoRefreshSeconds: number;
  /** The longest a stop waits for in-flight requests before it closes the
   *  connections still open. One number for the whole stop. */
  drainCapSeconds: number;
}

function num(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // Fail fast: a mistyped port is a silent non-delivery later, which is the
    // exact failure mode this project exists to make visible.
    throw new Error(`${name}: expected a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Like num(), but 0 is a legal value meaning "off". */
function numOrZero(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name}: expected a number >= 0, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function nameMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(raw)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function thirdRing(raw: string | undefined): "stand" | "sleep" | "off" {
  if (raw === undefined || raw === "") return "stand";
  if (raw === "stand" || raw === "sleep" || raw === "off") return raw;
  throw new Error(`VITALS_THIRD_RING: expected stand|sleep|off, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.VITALS_STATE_DIR ?? path.join(os.homedir(), "Library", "Application Support", "vitals");
  return {
    stateDir,
    dbPath: env.VITALS_DB ?? path.join(stateDir, "vitals.db"),
    tokenFile: env.VITALS_TOKEN_FILE ?? path.join(stateDir, "token"),
    tokenHeader: (env.VITALS_TOKEN_HEADER ?? "x-vitals-token").toLowerCase(),
    ingestHost: env.VITALS_INGEST_HOST ?? "0.0.0.0",
    ingestPort: num(env.VITALS_INGEST_PORT, 4781, "VITALS_INGEST_PORT"),
    readHost: env.VITALS_READ_HOST ?? "127.0.0.1",
    readPort: num(env.VITALS_READ_PORT, 4780, "VITALS_READ_PORT"),
    maxBodyBytes: num(env.VITALS_MAX_BODY_BYTES, 2_000_000, "VITALS_MAX_BODY_BYTES"),
    truncatedAfterMinutes: num(env.VITALS_TRUNCATED_AFTER_MINUTES, 60, "VITALS_TRUNCATED_AFTER_MINUTES"),
    goalMoveKcal: num(env.VITALS_GOAL_MOVE_KCAL, 600, "VITALS_GOAL_MOVE_KCAL"),
    goalExerciseMinutes: num(env.VITALS_GOAL_EXERCISE_MIN, 30, "VITALS_GOAL_EXERCISE_MIN"),
    goalStandHours: num(env.VITALS_GOAL_STAND_HOURS, 12, "VITALS_GOAL_STAND_HOURS"),
    thirdRing: thirdRing(env.VITALS_THIRD_RING),
    sourcePriority: list(env.VITALS_SOURCE_PRIORITY),
    sourceNames: nameMap(env.VITALS_SOURCE_NAMES),
    autoRefreshSeconds: numOrZero(env.VITALS_AUTO_REFRESH_SECONDS, 300, "VITALS_AUTO_REFRESH_SECONDS"),
    drainCapSeconds: num(env.VITALS_DRAIN_CAP_SECONDS, 10, "VITALS_DRAIN_CAP_SECONDS"),
  };
}
