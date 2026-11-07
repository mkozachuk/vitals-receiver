import { dbFileBytes } from "./dashboard.js";
import type { Db } from "./db.js";
import { normaliseUuid, toUtcIso, type Envelope, type Sample } from "./envelope.js";

export type Outcome = "export" | "probe" | "unauthorised" | "quarantined" | "oversize" | "unroutable";

export interface DeliveryRecord {
  receivedAt: string;
  remoteAddr: string | null;
  method: string;
  path: string;
  status: number;
  bytes: number;
  sampleCount?: number;
  storedCount?: number;
  duplicateCount?: number;
  rejectedCount?: number;
  outcome: Outcome;
  exportId?: string | null;
  batchSequence?: number | null;
  durationMs?: number | null;
  note?: string | null;
}

export interface QuarantineRecord {
  receivedAt: string;
  remoteAddr: string | null;
  reason: string;
  detail: string | null;
  headers: Record<string, unknown>;
  body: string;
  deliveryId?: number | null;
}

export interface StoreBatchResult {
  stored: number;
  duplicates: number;
  /** Set when a later batch of a run claims a different generatedAt or
   *  occasion than the batch that created it. Noted on the delivery, never a
   *  reason to reject. */
  drift: string | null;
}

export interface HealthSummary {
  ok: boolean;
  /** When this process started (ISO, UTC) -- the same instant as the
   *  `vitals: started` log line. Tells a receiver gap from a phone gap. */
  startedAt: string;
  uptimeSeconds: number;
  dbWritable: boolean;
  lastDeliveryAt: string | null;
  lastExportAt: string | null;
  lastCompleteRunAt: string | null;
  /** All-time. Only ever grows: a run truncated in March is still truncated. */
  truncatedRuns: number;
  /** Last 7 days. This is the number the Synapse tile's `warn` rule needs --
   * an all-time count never returns to green, and a permanently amber number
   * is a number nobody reads. */
  truncatedRuns7d: number;
  samples24h: number;
  samplesTotal: number;
  unauthorised24h: number;
  quarantined24h: number;
  quarantinedTotal: number;
  samplesDropped: number;
  samplesDuplicate: number;
  samplesRejected: number;
  runsTotal: number;
  dbBytes: number;
}

const SAMPLE_INSERT = `
INSERT INTO samples (
  uuid, content_id, type, sample_group, kind, source, start_at, end_at,
  value, unit, category_value, category_name,
  activity_type, activity_name, duration_seconds, distance_meters, active_energy_kcal,
  raw, export_id, received_at
) VALUES (
  @uuid, @content_id, @type, @sample_group, @kind, @source, @start_at, @end_at,
  @value, @unit, @category_value, @category_name,
  @activity_type, @activity_name, @duration_seconds, @distance_meters, @active_energy_kcal,
  @raw, @export_id, @received_at
)
ON CONFLICT(uuid) DO NOTHING
ON CONFLICT(content_id) WHERE type = 'HKQuantityTypeIdentifierHeartRate' DO NOTHING
`;

interface SampleRow {
  uuid: string;
  content_id: string;
  type: string;
  sample_group: string;
  kind: string;
  source: string;
  start_at: string;
  end_at: string;
  value: number | null;
  unit: string | null;
  category_value: number | null;
  category_name: string | null;
  activity_type: number | null;
  activity_name: string | null;
  duration_seconds: number | null;
  distance_meters: number | null;
  active_energy_kcal: number | null;
  raw: string;
  export_id: string;
  received_at: string;
}

function toRow(sample: Sample, exportId: string, receivedAt: string): SampleRow {
  const row: SampleRow = {
    uuid: normaliseUuid(sample.uuid),
    content_id: sample.id,
    type: sample.type,
    sample_group: sample.group,
    kind: sample.kind,
    source: sample.source,
    start_at: toUtcIso(sample.start),
    end_at: toUtcIso(sample.end),
    value: null,
    unit: null,
    category_value: null,
    category_name: null,
    activity_type: null,
    activity_name: null,
    duration_seconds: null,
    distance_meters: null,
    active_energy_kcal: null,
    // The whole sample object, verbatim: keys will be added inside v1 and a
    // column list is a promise we cannot keep on our own.
    raw: JSON.stringify(sample),
    export_id: exportId,
    received_at: receivedAt,
  };

  switch (sample.kind) {
    case "quantity":
      row.value = sample.value;
      row.unit = sample.unit;
      break;
    case "category":
      row.category_value = sample.value;
      row.category_name = sample.name ?? null;
      break;
    case "workout":
      row.activity_type = sample.activityType;
      row.activity_name = sample.activityName ?? null;
      row.duration_seconds = sample.durationSeconds;
      row.distance_meters = sample.distanceMeters ?? null;
      row.active_energy_kcal = sample.activeEnergyKilocalories ?? null;
      break;
  }
  return row;
}

/** Credential header, whatever it is called, never reaches the store. */
function scrubHeaders(headers: Record<string, unknown>, tokenHeader: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === tokenHeader || key === "authorization" || key === "cookie" || key === "proxy-authorization") {
      out[key] = "[redacted]";
    } else {
      out[key] = v;
    }
  }
  return out;
}

export interface StoreOptions {
  dbPath: string;
  tokenHeader: string;
  truncatedAfterMinutes: number;
  startedAt?: number;
}

export function createStore(db: Db, options: StoreOptions) {
  const startedAt = options.startedAt ?? Date.now();

  const stmts = {
    insertSample: db.prepare(SAMPLE_INSERT),
    insertBatch: db.prepare(`
      INSERT INTO batches (
        export_id, sequence, received_at, sample_count, stored_count, valid_count,
        duplicate_count, rejected_count, bytes, is_final
      ) VALUES (
        @export_id, @sequence, @received_at, @sample_count, @stored_count, @valid_count,
        @duplicate_count, @rejected_count, @bytes, @is_final
      )
      ON CONFLICT(export_id, sequence) DO UPDATE SET
        received_at = batches.received_at,
        sample_count = batches.sample_count,
        stored_count = batches.stored_count,
        valid_count = batches.valid_count,
        duplicate_count = batches.duplicate_count,
        rejected_count = batches.rejected_count,
        bytes = batches.bytes,
        is_final = MAX(batches.is_final, excluded.is_final)
    `),
    getRun: db.prepare(`SELECT generated_at, occasion_start, occasion_end FROM runs WHERE export_id = @export_id`),
    insertRun: db.prepare(`
      INSERT INTO runs (
        export_id, generated_at, window_start, window_end,
        basis, occasion_start, occasion_end, first_seen, last_seen
      )
      VALUES (
        @export_id, @generated_at, @window_start, @window_end,
        @basis, @occasion_start, @occasion_end, @now, @now
      )
      -- The window is the run's extent: MIN/MAX over its batches. On basis
      -- 'anchor' each batch carries its own bracket, so keeping batch 1's
      -- would describe one batch and call it the run. MIN/MAX is order-free
      -- and idempotent, so a replayed batch cannot move it. Lexical order is
      -- time order because every instant here went through toUtcIso().
      ON CONFLICT(export_id) DO UPDATE SET
        last_seen    = @now,
        window_start = MIN(runs.window_start, excluded.window_start),
        window_end   = MAX(runs.window_end, excluded.window_end)
    `),
    refreshRun: db.prepare(`
      UPDATE runs SET
        batches_seen = (SELECT COUNT(*)              FROM batches WHERE export_id = @export_id),
        max_sequence = (SELECT COALESCE(MAX(sequence), 0)  FROM batches WHERE export_id = @export_id),
        sample_count = (SELECT COALESCE(SUM(sample_count), 0) FROM batches WHERE export_id = @export_id),
        stored_count = (SELECT COALESCE(SUM(stored_count), 0) FROM batches WHERE export_id = @export_id),
        final_seen   = (SELECT CASE WHEN EXISTS (SELECT 1 FROM batches WHERE export_id = @export_id AND is_final = 1) THEN 1 ELSE 0 END)
      WHERE export_id = @export_id
    `),
    insertDelivery: db.prepare(`
      INSERT INTO deliveries (
        received_at, remote_addr, method, path, status, bytes, sample_count,
        stored_count, duplicate_count, rejected_count, outcome, export_id,
        batch_sequence, duration_ms, note
      ) VALUES (
        @received_at, @remote_addr, @method, @path, @status, @bytes, @sample_count,
        @stored_count, @duplicate_count, @rejected_count, @outcome, @export_id,
        @batch_sequence, @duration_ms, @note
      )
    `),
    insertQuarantine: db.prepare(`
      INSERT INTO quarantine (received_at, remote_addr, reason, detail, headers, body, bytes, delivery_id)
      VALUES (@received_at, @remote_addr, @reason, @detail, @headers, @body, @bytes, @delivery_id)
    `),
    probeWrite: db.prepare(`
      INSERT INTO meta (key, value) VALUES ('healthz_probe_at', @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    scalar: (sql: string) => db.prepare(sql),
  };

  const q = {
    lastDelivery: db.prepare(`SELECT MAX(received_at) AS v FROM deliveries WHERE outcome IN ('export','probe','quarantined')`),
    lastExport: db.prepare(`SELECT MAX(received_at) AS v FROM deliveries WHERE outcome = 'export'`),
    lastCompleteRun: db.prepare(`SELECT MAX(last_seen) AS v FROM runs WHERE final_seen = 1 AND batches_seen = max_sequence`),
    truncatedRuns: db.prepare(`SELECT COUNT(*) AS v FROM runs WHERE NOT (final_seen = 1 AND batches_seen = max_sequence) AND last_seen < @cutoff`),
    truncatedRunsSince: db.prepare(`SELECT COUNT(*) AS v FROM runs WHERE NOT (final_seen = 1 AND batches_seen = max_sequence) AND last_seen < @cutoff AND last_seen >= @since`),
    samplesSince: db.prepare(`SELECT COUNT(*) AS v FROM samples WHERE received_at >= @since`),
    samplesTotal: db.prepare(`SELECT COUNT(*) AS v FROM samples`),
    runsTotal: db.prepare(`SELECT COUNT(*) AS v FROM runs`),
    outcomeSince: db.prepare(`SELECT COUNT(*) AS v FROM deliveries WHERE outcome = @outcome AND received_at >= @since`),
    quarantineTotal: db.prepare(`SELECT COUNT(*) AS v FROM quarantine`),
    samplesDropped: db.prepare(`SELECT COALESCE(SUM(rejected_count), 0) AS v FROM batches`),
    samplesDuplicate: db.prepare(`SELECT COALESCE(SUM(duplicate_count), 0) AS v FROM deliveries WHERE outcome = 'export'`),
    samplesRejected: db.prepare(`SELECT COALESCE(SUM(rejected_count), 0) AS v FROM deliveries WHERE outcome = 'export'`),
  };

  const scalarNumber = (row: unknown): number => Number((row as { v: number | null }).v ?? 0);
  const scalarText = (row: unknown): string | null => ((row as { v: string | null }).v ?? null);

  const storeBatch = db.transaction(
    (envelope: Envelope, samples: Sample[], receivedAt: string, bytes: number, rejectedCount = 0): StoreBatchResult => {
      // payload.md says what is identical across every batch of one run:
      // generatedAt, and the occasion. NOT the window -- on basis 'anchor' the
      // window is each batch's own bracket and differs by design, so comparing
      // it noted drift on every anchor batch after the first. A batch that
      // disagrees on the run's identity means something is wrong upstream --
      // but the samples in it are still real, so we note the drift on the
      // delivery and keep the first values. Quarantining here would throw
      // away data to punish a metadata mismatch.
      const existing = stmts.getRun.get({ export_id: envelope.exportId }) as
        | { generated_at: string; occasion_start: string | null; occasion_end: string | null }
        | undefined;
      const drifted: string[] = [];
      if (existing !== undefined) {
        const claimed: [string, string, string][] = [
          ["generatedAt", existing.generated_at, toUtcIso(envelope.generatedAt)],
        ];
        // Only when both sides carry it: a run first seen from an older
        // healthd has no occasion to disagree with, and an older body has
        // none to offer.
        if (existing.occasion_start !== null && envelope.occasionStart !== undefined) {
          claimed.push(["occasionStart", existing.occasion_start, toUtcIso(envelope.occasionStart)]);
        }
        if (existing.occasion_end !== null && envelope.occasionEnd !== undefined) {
          claimed.push(["occasionEnd", existing.occasion_end, toUtcIso(envelope.occasionEnd)]);
        }
        for (const [name, first, now] of claimed) {
          if (first !== now) drifted.push(`${name} ${first} -> ${now}`);
        }
      }

      let stored = 0;
      let duplicates = 0;
      for (const sample of samples) {
        const info = stmts.insertSample.run(toRow(sample, envelope.exportId, receivedAt));
        if (info.changes === 1) stored += 1;
        else duplicates += 1;
      }
      stmts.insertBatch.run({
        export_id: envelope.exportId,
        sequence: envelope.batchSequence,
        received_at: receivedAt,
        sample_count: envelope.samples.length,
        stored_count: stored,
        valid_count: samples.length,
        duplicate_count: duplicates,
        rejected_count: rejectedCount,
        bytes,
        is_final: envelope.isFinalBatch ? 1 : 0,
      });
      stmts.insertRun.run({
        export_id: envelope.exportId,
        generated_at: toUtcIso(envelope.generatedAt),
        window_start: toUtcIso(envelope.windowStart),
        window_end: toUtcIso(envelope.windowEnd),
        // Absent on a body from an older healthd; stored as NULL rather than
        // guessed. First batch wins, as with generatedAt -- the occasion IS
        // identical on every batch of one run by contract. The window is the
        // exception: see the ON CONFLICT clause.
        basis: envelope.basis ?? null,
        occasion_start: envelope.occasionStart === undefined ? null : toUtcIso(envelope.occasionStart),
        occasion_end: envelope.occasionEnd === undefined ? null : toUtcIso(envelope.occasionEnd),
        now: receivedAt,
      });
      stmts.refreshRun.run({ export_id: envelope.exportId });
      return {
        stored,
        duplicates,
        drift: drifted.length === 0 ? null : `run metadata drift: ${drifted.join("; ")}`,
      };
    },
  );

  return {
    db,

    recordDelivery(record: DeliveryRecord): number {
      const info = stmts.insertDelivery.run({
        received_at: record.receivedAt,
        remote_addr: record.remoteAddr,
        method: record.method,
        path: record.path,
        status: record.status,
        bytes: record.bytes,
        sample_count: record.sampleCount ?? 0,
        stored_count: record.storedCount ?? 0,
        duplicate_count: record.duplicateCount ?? 0,
        rejected_count: record.rejectedCount ?? 0,
        outcome: record.outcome,
        export_id: record.exportId ?? null,
        batch_sequence: record.batchSequence ?? null,
        duration_ms: record.durationMs ?? null,
        note: record.note ?? null,
      });
      return Number(info.lastInsertRowid);
    },

    recordQuarantine(record: QuarantineRecord): number {
      const info = stmts.insertQuarantine.run({
        received_at: record.receivedAt,
        remote_addr: record.remoteAddr,
        reason: record.reason,
        detail: record.detail,
        headers: JSON.stringify(scrubHeaders(record.headers, options.tokenHeader)),
        body: record.body,
        bytes: Buffer.byteLength(record.body, "utf8"),
        delivery_id: record.deliveryId ?? null,
      });
      return Number(info.lastInsertRowid);
    },

    storeBatch(envelope: Envelope, samples: Sample[], receivedAt: string, bytes: number, rejectedCount = 0): StoreBatchResult {
      return storeBatch(envelope, samples, receivedAt, bytes, rejectedCount);
    },

    health(now: Date = new Date()): HealthSummary {
      let dbWritable = true;
      try {
        stmts.probeWrite.run({ value: now.toISOString() });
      } catch {
        dbWritable = false;
      }
      const since24h = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const since7d = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
      const cutoff = new Date(now.getTime() - options.truncatedAfterMinutes * 60_000).toISOString();

      return {
        ok: dbWritable,
        startedAt: new Date(startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        dbWritable,
        lastDeliveryAt: scalarText(q.lastDelivery.get()),
        lastExportAt: scalarText(q.lastExport.get()),
        lastCompleteRunAt: scalarText(q.lastCompleteRun.get()),
        truncatedRuns: scalarNumber(q.truncatedRuns.get({ cutoff })),
        truncatedRuns7d: scalarNumber(q.truncatedRunsSince.get({ cutoff, since: since7d })),
        samples24h: scalarNumber(q.samplesSince.get({ since: since24h })),
        samplesTotal: scalarNumber(q.samplesTotal.get()),
        unauthorised24h: scalarNumber(q.outcomeSince.get({ outcome: "unauthorised", since: since24h })),
        quarantined24h: scalarNumber(q.outcomeSince.get({ outcome: "quarantined", since: since24h })),
        quarantinedTotal: scalarNumber(q.quarantineTotal.get()),
        samplesDropped: scalarNumber(q.samplesDropped.get()),
        samplesDuplicate: scalarNumber(q.samplesDuplicate.get()),
        samplesRejected: scalarNumber(q.samplesRejected.get()),
        runsTotal: scalarNumber(q.runsTotal.get()),
        dbBytes: dbFileBytes(options.dbPath),
      };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
