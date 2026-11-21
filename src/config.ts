import net from "node:net";
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
  /** Ingest rate limits (src/ratelimit.ts). Each max: 0 = that counter off. */
  rateWindowSeconds: number;
  rateIpMax: number;
  rateTokenMax: number;
  rateAuthFailMax: number;
  rateAuthFailWindowSeconds: number;
  rateMaxKeys: number;
  /** Whose X-Forwarded-For the ingest listener believes: nobody, loopback
   *  peers, or the listed addresses. */
  trustProxy: "off" | "loopback" | string[];
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

/** numOrZero() that also takes the word `off` for 0. */
function limit(raw: string | undefined, fallback: number, name: string): number {
  return raw === "off" ? 0 : numOrZero(raw, fallback, name);
}

/** off | loopback | a comma list of IP literals. Anything else fails fast:
 *  a mistyped proxy address would silently key every client as the proxy. */
function trustProxy(raw: string | undefined): "off" | "loopback" | string[] {
  if (raw === undefined || raw === "" || raw === "off") return "off";
  if (raw === "loopback") return "loopback";
  const addresses = list(raw);
  const bad = addresses.filter((a) => net.isIP(a) === 0);
  if (addresses.length === 0 || bad.length > 0) {
    throw new Error(`VITALS_TRUST_PROXY: expected off|loopback|<ip>[,<ip>...], got ${JSON.stringify(raw)}`);
  }
  return addresses;
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

/** An XDG base directory: used only when set to an absolute path (the XDG
 *  Base Directory spec says relative values are invalid and ignored). */
function xdgBase(raw: string | undefined, fallback: string): string {
  return raw !== undefined && path.isAbsolute(raw) ? raw : fallback;
}

/**
 * Where the store and the credential live when nothing says otherwise.
 *
 * Linux follows XDG: the store under $XDG_STATE_HOME (~/.local/state/vitals),
 * the credential under $XDG_CONFIG_HOME (~/.config/vitals/token). An explicit
 * VITALS_STATE_DIR keeps the old shape (store and token side by side in it).
 * The Linux service scripts resolve their paths through this same function
 * (scripts/linux/unit.ts), so there is no second copy of the rule to drift.
 * Every other platform keeps the macOS layout, unchanged.
 */
function defaultPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { stateDir: string; tokenFile: string } {
  if (platform === "win32") {
    // Store and credential side by side under %LOCALAPPDATA%\vitals (<home>\AppData\Local
    // when LOCALAPPDATA is unset). scripts/windows/paths.ts reads them from here.
    const localAppData = env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== ""
      ? env.LOCALAPPDATA
      : path.win32.join(os.homedir(), "AppData", "Local");
    const stateDir = env.VITALS_STATE_DIR ?? path.win32.join(localAppData, "vitals");
    return { stateDir, tokenFile: path.win32.join(stateDir, "token") };
  }
  if (platform === "linux") {
    if (env.VITALS_STATE_DIR !== undefined) {
      return { stateDir: env.VITALS_STATE_DIR, tokenFile: path.join(env.VITALS_STATE_DIR, "token") };
    }
    const home = os.homedir();
    const stateHome = xdgBase(env.XDG_STATE_HOME, path.join(home, ".local", "state"));
    const configHome = xdgBase(env.XDG_CONFIG_HOME, path.join(home, ".config"));
    return { stateDir: path.join(stateHome, "vitals"), tokenFile: path.join(configHome, "vitals", "token") };
  }
  const stateDir = env.VITALS_STATE_DIR ?? path.join(os.homedir(), "Library", "Application Support", "vitals");
  return { stateDir, tokenFile: path.join(stateDir, "token") };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Config {
  const { stateDir, tokenFile } = defaultPaths(env, platform);
  return {
    stateDir,
    dbPath: env.VITALS_DB ?? path.join(stateDir, "vitals.db"),
    tokenFile: env.VITALS_TOKEN_FILE ?? tokenFile,
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
    // 1200 per 60 s = 20 req/s sustained: 26x the busiest 60 s the live store
    // has seen (45 deliveries) and above its busiest second (12) held for a
    // whole minute. A 1000-batch backfill is ~1000 MB of uploads and cannot
    // finish inside one window on a phone link. See src/ratelimit.ts.
    rateWindowSeconds: num(env.VITALS_RATE_WINDOW_SECONDS, 60, "VITALS_RATE_WINDOW_SECONDS"),
    rateIpMax: limit(env.VITALS_RATE_IP_MAX, 1200, "VITALS_RATE_IP_MAX"),
    rateTokenMax: limit(env.VITALS_RATE_TOKEN_MAX, 1200, "VITALS_RATE_TOKEN_MAX"),
    rateAuthFailMax: limit(env.VITALS_RATE_AUTH_FAIL_MAX, 10, "VITALS_RATE_AUTH_FAIL_MAX"),
    rateAuthFailWindowSeconds: num(env.VITALS_RATE_AUTH_FAIL_WINDOW_SECONDS, 600, "VITALS_RATE_AUTH_FAIL_WINDOW_SECONDS"),
    rateMaxKeys: num(env.VITALS_RATE_MAX_KEYS, 10_000, "VITALS_RATE_MAX_KEYS"),
    trustProxy: trustProxy(env.VITALS_TRUST_PROXY),
  };
}
