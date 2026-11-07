import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per Apple Health sample, keyed on its HealthKit uuid. Repeated
-- content is ignored rather than rewriting provenance. HeartRate is also
-- unique on content_id because HealthKit has been observed re-minting uuid for
-- identical HeartRate content; other types may share content_id.
CREATE TABLE IF NOT EXISTS samples (
  uuid               TEXT PRIMARY KEY,
  content_id         TEXT NOT NULL,
  type               TEXT NOT NULL,
  sample_group       TEXT NOT NULL,
  kind               TEXT NOT NULL,
  source             TEXT NOT NULL,
  start_at           TEXT NOT NULL,
  end_at             TEXT NOT NULL,
  value              REAL,
  unit               TEXT,
  category_value     INTEGER,
  category_name      TEXT,
  activity_type      INTEGER,
  activity_name      TEXT,
  duration_seconds   REAL,
  distance_meters    REAL,
  active_energy_kcal REAL,
  raw                TEXT NOT NULL,
  export_id          TEXT NOT NULL,
  received_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_type_start  ON samples(type, start_at);
CREATE INDEX IF NOT EXISTS samples_content_id  ON samples(content_id);
CREATE INDEX IF NOT EXISTS samples_received_at ON samples(received_at);
CREATE UNIQUE INDEX IF NOT EXISTS samples_hr_content_id_unique
  ON samples(content_id)
  WHERE type = 'HKQuantityTypeIdentifierHeartRate';

-- One row per export run (exportId). Aggregates are recomputed from batches
-- on every ingest, so a re-delivered batch cannot inflate them.
CREATE TABLE IF NOT EXISTS runs (
  export_id    TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  -- The sender's occasion, stored verbatim and nullable: absent from any body
  -- built before healthd published it, and NOT to be confused with the window.
  -- On basis 'anchor' window_start/window_end are the batch's own bracket and
  -- differ between batches of one run, while the occasion is identical across
  -- them -- which is what a table keyed on export_id actually wants. So
  -- window_start/window_end hold the run's extent (MIN/MAX over its batches),
  -- and the drift check compares the occasion, never the window.
  -- They are recorded verbatim because the occasion
  -- is unrecoverable after the fact: a receiver that drops it can only ever be
  -- retrofitted for deliveries that have not happened yet.
  basis          TEXT,
  occasion_start TEXT,
  occasion_end   TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  batches_seen INTEGER NOT NULL DEFAULT 0,
  max_sequence INTEGER NOT NULL DEFAULT 0,
  final_seen   INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_last_seen ON runs(last_seen);

-- sample_count is what the batch CLAIMED to carry; stored_count is new rows.
-- valid_count, duplicate_count and rejected_count separate "already had it"
-- from "could not store it" -- the sender cannot tell us, it never reads our answer.
CREATE TABLE IF NOT EXISTS batches (
  export_id    TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  received_at  TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  stored_count INTEGER NOT NULL DEFAULT 0,
  valid_count  INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count  INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL,
  is_final     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (export_id, sequence)
);

-- The delivery log: every request that reached us, including the ones we
-- refused. The sender never reads our response body, so this table is the
-- only place our side of a conversation is recorded.
CREATE TABLE IF NOT EXISTS deliveries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at    TEXT NOT NULL,
  remote_addr    TEXT,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  status         INTEGER NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  sample_count   INTEGER NOT NULL DEFAULT 0,
  stored_count   INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  outcome        TEXT NOT NULL,
  export_id      TEXT,
  batch_sequence INTEGER,
  duration_ms    INTEGER,
  note           TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_received_at ON deliveries(received_at);
CREATE INDEX IF NOT EXISTS deliveries_outcome     ON deliveries(outcome, received_at);

-- Bytes we could not turn into samples, kept verbatim. Answering 400 to an
-- unrecognised shape would be a principled way to throw health data away.
CREATE TABLE IF NOT EXISTS quarantine (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  remote_addr TEXT,
  reason      TEXT NOT NULL,
  detail      TEXT,
  headers     TEXT NOT NULL,
  body        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  delivery_id INTEGER
);
CREATE INDEX IF NOT EXISTS quarantine_received_at ON quarantine(received_at);
`;

const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  (db) => db.exec(SCHEMA_V1),
  (db) => {
    db.exec(`
      DELETE FROM samples
       WHERE type = 'HKQuantityTypeIdentifierHeartRate'
         AND rowid NOT IN (
           SELECT MIN(rowid)
             FROM samples
            WHERE type = 'HKQuantityTypeIdentifierHeartRate'
            GROUP BY content_id
         );
      CREATE UNIQUE INDEX IF NOT EXISTS samples_hr_content_id_unique
        ON samples(content_id)
        WHERE type = 'HKQuantityTypeIdentifierHeartRate';
    `);

    const batchColumns = new Set((db.pragma("table_info(batches)") as { name: string }[]).map((c) => c.name));
    if (!batchColumns.has("valid_count")) db.exec("ALTER TABLE batches ADD COLUMN valid_count INTEGER NOT NULL DEFAULT 0");
    if (!batchColumns.has("duplicate_count")) {
      db.exec("ALTER TABLE batches ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!batchColumns.has("rejected_count")) {
      db.exec("ALTER TABLE batches ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0");
    }
    const deliveryColumns = new Set((db.pragma("table_info(deliveries)") as { name: string }[]).map((c) => c.name));
    if (!deliveryColumns.has("stored_count")) db.exec("ALTER TABLE deliveries ADD COLUMN stored_count INTEGER NOT NULL DEFAULT 0");
    if (!deliveryColumns.has("duplicate_count")) {
      db.exec("ALTER TABLE deliveries ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!deliveryColumns.has("rejected_count")) {
      db.exec("ALTER TABLE deliveries ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`
      UPDATE batches
         SET valid_count = stored_count,
             rejected_count = MAX(sample_count - stored_count, 0)
       WHERE valid_count = 0 AND duplicate_count = 0 AND rejected_count = 0;
    `);
  },
  (db) => {
    // healthd publishes `basis`, `occasionStart` and `occasionEnd`. Additive
    // and nullable: an existing store keeps every row it has, and rows written
    // before this migration simply carry NULL -- there is nothing to backfill
    // them from, and inventing a value would be worse than admitting the gap.
    const runColumns = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!runColumns.has("basis")) db.exec("ALTER TABLE runs ADD COLUMN basis TEXT");
    if (!runColumns.has("occasion_start")) db.exec("ALTER TABLE runs ADD COLUMN occasion_start TEXT");
    if (!runColumns.has("occasion_end")) db.exec("ALTER TABLE runs ADD COLUMN occasion_end TEXT");
  },
];

export function migrate(db: Db): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db.pragma("user_version", { simple: true }) as number;
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
