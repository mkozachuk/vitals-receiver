import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../src/config.js";
import { effectiveEnv, LOOPBACK } from "../linux/unit.js";

/**
 * The Windows service scripts' one source for paths (NB-775).
 *
 *   node --import <tsx loader URL> scripts/windows/paths.ts <repo>
 *       KEY=value lines: STATE_DIR, DB, TOKEN_FILE, LOG_FILE, READ_HOST,
 *       READ_PORT, INGEST_PORT. Exit 1 (one line on stderr) if <repo>/.env
 *       moves the read listener off loopback.
 *
 * Paths come from src/config.ts with platform "win32", over the process env
 * with <repo>/.env laid on top, the same rule as scripts/linux/unit.ts.
 */

export interface WindowsPaths {
  STATE_DIR: string;
  DB: string;
  TOKEN_FILE: string;
  LOG_FILE: string;
  READ_HOST: string;
  READ_PORT: string;
  INGEST_PORT: string;
}

export function windowsPaths(repo: string, env: NodeJS.ProcessEnv): WindowsPaths {
  const config = loadConfig(effectiveEnv(repo, env), "win32");
  if (config.readHost !== LOOPBACK) {
    throw new Error(
      `VITALS_READ_HOST=${config.readHost} (from ${path.join(repo, ".env")} or the environment): ` +
        `the read listener has no authentication of its own and must stay on ${LOOPBACK}`,
    );
  }
  return {
    STATE_DIR: path.win32.dirname(config.dbPath),
    DB: config.dbPath,
    TOKEN_FILE: config.tokenFile,
    LOG_FILE: path.win32.join(config.stateDir, "logs", "vitals.log"),
    READ_HOST: config.readHost,
    READ_PORT: String(config.readPort),
    INGEST_PORT: String(config.ingestPort),
  };
}

function main(argv: string[]): number {
  if (argv.length !== 1) {
    process.stderr.write("usage: paths.ts <repo>\n");
    return 2;
  }
  for (const [k, v] of Object.entries(windowsPaths(argv[0] as string, process.env))) {
    if (/[\n\r]/.test(v)) throw new Error(`${k} contains a line break`);
    process.stdout.write(`${k}=${v}\n`);
  }
  return 0;
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
