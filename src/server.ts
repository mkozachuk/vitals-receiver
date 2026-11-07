import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { buildIngestServer } from "./ingest.js";
import { buildReadServer } from "./read.js";
import { countInFlight, restartSwitch } from "./restart.js";
import { runningSha, shortCommit, startupLine } from "./startup.js";
import { createShutdown, drainTarget } from "./stop.js";
import { createStore } from "./store.js";
import { fileTokenSource } from "./token.js";

const config = loadConfig();
const token = fileTokenSource(config.tokenFile);

if (token.current() === null) {
  // A LAN-facing listener with no credential is worse than no listener.
  process.stderr.write(
    `vitals: no credential at ${config.tokenFile}\n` +
      `  mint one with:  npm run token:mint\n` +
      `  then set header ${config.tokenHeader} to its value in healthd.\n`,
  );
  process.exit(1);
}

// One instant for both the startup line and /healthz `startedAt`.
const startedAt = Date.now();

const db = openDb(config.dbPath);
const store = createStore(db, {
  startedAt,
  dbPath: config.dbPath,
  tokenHeader: config.tokenHeader,
  truncatedAfterMinutes: config.truncatedAfterMinutes,
});

const log = (line: string): void => {
  process.stdout.write(line + "\n");
};

// Resolved once, before anything listens, and held for the life of the
// process: /healthz `sha` names the code that is running (RC6).
const sha = runningSha(log);

const ingest = buildIngestServer({ config, store, token, log });
// Counted for POST /api/restart: it refuses (409) while a delivery is in flight.
const ingestInFlight = countInFlight(ingest);
const read = buildReadServer({
  store,
  config,
  sha,
  restart: restartSwitch({ inFlight: ingestInFlight, shutdown: (reason, code) => shutdown(reason, code), log }),
});

// One stop path: the signals exit 0, POST /api/restart exits 75 (VR4),
// bounded by the drain cap.
const shutdown = createShutdown({
  servers: [drainTarget(ingest), drainTarget(read)],
  db,
  log,
  exit: (code) => process.exit(code),
  drainCapSeconds: config.drainCapSeconds,
});

async function main(): Promise<void> {
  await ingest.listen({ host: config.ingestHost, port: config.ingestPort });
  await read.listen({ host: config.readHost, port: config.readPort });
  log(`vitals: ingest  http://${config.ingestHost}:${config.ingestPort}/ingest  (write-only, LAN)`);
  log(`vitals: read    http://${config.readHost}:${config.readPort}/            (loopback dashboard, read-only)`);
  log(`vitals: store   ${config.dbPath}`);
  log(startupLine(startedAt, shortCommit(sha)));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal, 0);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`vitals: failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
