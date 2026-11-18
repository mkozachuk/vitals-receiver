import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "../../src/config.js";

/**
 * The Linux service scripts' one source for paths and the unit text.
 *
 *   node --import tsx scripts/linux/unit.ts paths <repo>
 *       KEY=value lines: STATE_DIR, DB, TOKEN_FILE, READ_HOST, READ_PORT,
 *       INGEST_PORT, UNIT_FILE. Exit 1 (one line on stderr) if <repo>/.env
 *       moves the read listener off loopback.
 *   node --import tsx scripts/linux/unit.ts render <template> <out> KEY=value...
 *
 * Paths come from src/config.ts with platform "linux", over the process env
 * with <repo>/.env laid on top -- the same precedence the unit gives the
 * daemon (EnvironmentFile wins over Environment=).
 */

export const LOOPBACK = "127.0.0.1";

export function effectiveEnv(repo: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = path.join(repo, ".env");
  const dot = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
  return { ...env, ...dot };
}

export interface LinuxPaths {
  STATE_DIR: string;
  DB: string;
  TOKEN_FILE: string;
  READ_HOST: string;
  READ_PORT: string;
  INGEST_PORT: string;
  UNIT_FILE: string;
}

export function linuxPaths(repo: string, env: NodeJS.ProcessEnv): LinuxPaths {
  const merged = effectiveEnv(repo, env);
  const config = loadConfig(merged, "linux");
  if (config.readHost !== LOOPBACK) {
    throw new Error(
      `VITALS_READ_HOST=${config.readHost} (from ${path.join(repo, ".env")} or the environment): ` +
        `the read listener has no authentication of its own and must stay on ${LOOPBACK}`,
    );
  }
  const xdgConfig = env.XDG_CONFIG_HOME !== undefined && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return {
    STATE_DIR: path.dirname(config.dbPath),
    DB: config.dbPath,
    TOKEN_FILE: config.tokenFile,
    READ_HOST: config.readHost,
    READ_PORT: String(config.readPort),
    INGEST_PORT: String(config.ingestPort),
    UNIT_FILE: path.join(xdgConfig, "systemd", "user", "vitals.service"),
  };
}

export const UNIT_VARS = ["NODE_BIN", "NODE_DIR", "REPO", "TSX", "DB", "TOKEN_FILE"] as const;
export type UnitVars = Record<(typeof UNIT_VARS)[number], string>;

/**
 * Substitutes __NAME__ placeholders. Every value must be an absolute path with
 * no whitespace, quote or backslash: systemd splits ExecStart on whitespace and
 * unquotes, and refusing is smaller than quoting correctly per directive. "%"
 * is doubled, since systemd reads it as a specifier. The result must not set
 * the read host to anything but loopback.
 */
export function renderUnit(template: string, vars: UnitVars): string {
  let out = template;
  for (const name of UNIT_VARS) {
    const value = vars[name];
    if (!path.isAbsolute(value)) throw new Error(`${name}: expected an absolute path, got ${JSON.stringify(value)}`);
    if (/[\s"'\\]/.test(value)) {
      throw new Error(`${name}: ${JSON.stringify(value)} contains whitespace, a quote or a backslash; move it to a plain path`);
    }
    out = out.split(`__${name}__`).join(value.replaceAll("%", "%%"));
  }
  const left = out.match(/__[A-Z_]+__/);
  if (left) throw new Error(`unrendered placeholder ${left[0]}`);
  const hosts = [...out.matchAll(/^Environment=VITALS_READ_HOST=(.*)$/gm)].map((m) => m[1]);
  if (hosts.length !== 1 || hosts[0] !== LOOPBACK) {
    throw new Error(`the unit must set VITALS_READ_HOST=${LOOPBACK} exactly once, found ${JSON.stringify(hosts)}`);
  }
  return out;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "paths" && rest.length === 1) {
    const p = linuxPaths(rest[0] as string, process.env);
    for (const [k, v] of Object.entries(p)) {
      if (/[\n\r]/.test(v)) throw new Error(`${k} contains a line break`);
      process.stdout.write(`${k}=${v}\n`);
    }
    return 0;
  }
  if (cmd === "render" && rest.length >= 2) {
    const [template, out, ...pairs] = rest as [string, string, ...string[]];
    const given: Record<string, string> = {};
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`expected KEY=value, got ${JSON.stringify(pair)}`);
      given[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    for (const name of UNIT_VARS) if (given[name] === undefined) throw new Error(`missing ${name}=`);
    fs.writeFileSync(out, renderUnit(fs.readFileSync(template, "utf8"), given as UnitVars));
    return 0;
  }
  process.stderr.write("usage: unit.ts paths <repo> | render <template> <out> KEY=value...\n");
  return 2;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`vitals: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
