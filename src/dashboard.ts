import fs from "node:fs";
import type { Db } from "./db.js";
import { resolveDays, type SourceDayRow, type SourceTotal } from "./sources.js";

/**
 * The read model behind the dashboard page and /api/summary.
 *
 * Two constraints shape this file:
 *
 *  1. Every statement here is a SELECT. /healthz writes a probe row on
 *     purpose -- that is how it proves the database is writable -- but a
 *     dashboard that wrote would make refreshing the page an event in the
 *     data the page reports on. The read listener must stay read-only.
 *  2. The first question answered is "did anything arrive", not "what is my
 *     heart rate". Silent non-delivery is the documented failure mode of
 *     this whole category, so delivery health is computed first and the body
 *     data hangs off it.
 */

export const STEP_TYPE = "HKQuantityTypeIdentifierStepCount";
export const RESTING_HR_TYPE = "HKQuantityTypeIdentifierRestingHeartRate";
export const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

/**
 * HKCategoryValueSleepAnalysis: 1 asleepUnspecified, 3 core, 4 deep, 5 REM.
 * 0 (inBed) and 2 (awake) are deliberately excluded -- counting inBed as
 * sleep is how sleep trackers flatter their owners.
 */
export const ASLEEP_VALUES = [1, 3, 4, 5];

export const SPARK_DAYS = 14;
export const HR_DAYS = 30;
const GAP_SAMPLE_LIMIT = 60;
const MIN_SAMPLES_FOR_CADENCE = 5;

/**
 * Amber rule for a metric type: it is further behind the newest sample in the
 * store than its OWN observed rhythm tolerates. No hardcoded per-type
 * threshold -- a type that ticks every 5 minutes and a type that ticks once a
 * night are judged on their own cadence.
 *
 * The tolerance is the larger of STALE_FACTOR x the median gap and
 * P90_FACTOR x the 90th-percentile gap, because real HealthKit types are
 * bursty: sleep arrives as four stage samples 90 minutes apart and then
 * nothing for 22 hours. On the median alone, every bursty type is permanently
 * amber by breakfast -- measured on seeded data, sleep flagged "stopped?" six
 * hours after a normal night. The p90 gap is what the burst boundary looks
 * like, so it is what the type's real period is.
 *
 * The comparison is against the newest sample we hold, not against now(),
 * because healthd has no scheduler: nothing arrives between manual exports,
 * so measuring against now() would paint every type amber the morning after
 * an export. Against the newest sample, amber means "the others kept coming
 * and this one stopped" -- which is the failure actually worth seeing.
 *
 * The floor absorbs export boundaries: inside one export, different types
 * legitimately end minutes apart.
 */
export const STALE_FACTOR = 3;
export const P90_FACTOR = 1.5;
export const STALE_FLOOR_SECONDS = 900;

/** No delivery for longer than this and the pipe is considered warn. */
export const NO_DELIVERY_WARN_HOURS = 36;

export interface PipeStrip {
  lastDeliveryAt: string | null;
  lastExportAt: string | null;
  lastCompleteRunAt: string | null;
  truncatedRuns: number;
  truncatedRuns7d: number;
  unauthorised24h: number;
  /** When the most recent 401 was answered. A 401 older than the last
   *  successful export is a solved problem, not an alarm. */
  lastUnauthorisedAt: string | null;
  quarantined24h: number;
  quarantinedTotal: number;
  /** Counted by received_at -- arrival, not sample time. See the UI note. */
  samplesReceived24h: number;
  samplesReceived7d: number;
  samplesTotal: number;
  samplesDropped: number;
  samplesDuplicate: number;
  samplesRejected: number;
  runsTotal: number;
  dbBytes: number;
  dbPath: string;
  state: "ok" | "warn" | "empty";
  stateReason: string;
}

export interface TypeFreshness {
  type: string;
  kind: string;
  group: string;
  total: number;
  count7d: number;
  lastSampleAt: string | null;
  lastReceivedAt: string | null;
  medianGapSeconds: number | null;
  p90GapSeconds: number | null;
  lagSeconds: number | null;
  thresholdSeconds: number | null;
  state: "ok" | "amber" | "unknown";
  spark: number[];
}

export interface DayValue {
  day: string;
  value: number;
  samples: number;
  /** Set on series that are source-resolved (see src/sources.ts). The winning
   *  source id for that day, and the sources that also recorded it. Summing
   *  two devices that watched the same walk is a double count, not a total. */
  source?: string | null;
  alternatives?: SourceTotal[];
}

export interface WorkoutRow {
  startAt: string;
  endAt: string;
  name: string | null;
  activityType: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  energyKcal: number | null;
}

export interface DeliveryRow {
  receivedAt: string;
  remoteAddr: string | null;
  method: string;
  path: string;
  status: number;
  bytes: number;
  sampleCount: number;
  outcome: string;
  exportId: string | null;
  batchSequence: number | null;
  note: string | null;
}

export interface RunRow {
  exportId: string;
  generatedAt: string;
  /** The run's extent: MIN/MAX over its batches' windows. */
  windowStart: string;
  windowEnd: string;
  /** The sender's occasion; null on a run first seen from an older healthd. */
  occasionStart: string | null;
  occasionEnd: string | null;
  /** What the runs list shows as the run's span: the occasion when the run
   *  carries one -- that is what one export run IS -- else the window. */
  span: { start: string; end: string; source: "occasion" | "window" };
  firstSeen: string;
  lastSeen: string;
  batchesSeen: number;
  maxSequence: number;
  finalSeen: boolean;
  sampleCount: number;
  storedCount: number;
  truncated: boolean;
}

export interface Dashboard {
  generatedAt: string;
  sparkDays: number;
  hrDays: number;
  strip: PipeStrip;
  newestSampleAt: string | null;
  oldestSampleAt: string | null;
  types: TypeFreshness[];
  steps: DayValue[];
  restingHr: DayValue[];
  sleep: DayValue[];
  workouts: WorkoutRow[];
  deliveries: DeliveryRow[];
  runs: RunRow[];
}

export interface DashboardOptions {
  dbPath: string;
  truncatedAfterMinutes: number;
  now?: Date;
  deliveryLimit?: number;
  runLimit?: number;
  workoutLimit?: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar day of an instant, as SQLite's date(x,'localtime') writes it. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last `days` local calendar days, oldest first. Built from calendar
 *  components rather than 86400000ms steps so a DST change cannot duplicate
 *  or skip a bucket. */
export function lastDays(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
}

function startOfDayIso(now: Date, daysBack: number): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).toISOString();
}

/** Nearest-rank percentile, 0..1. p(0.5) is the median. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function dbFileBytes(dbPath: string): number {
  if (dbPath === ":memory:") return 0;
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(dbPath + suffix).size;
    } catch {
      /* absent is zero */
    }
  }
  return total;
}

const numOf = (row: unknown): number => Number((row as { v: number | null } | undefined)?.v ?? 0);
const textOf = (row: unknown): string | null => (row as { v: string | null } | undefined)?.v ?? null;

/** Bucket a grouped query into a fixed day axis so gaps render as zeroes
 *  rather than as a shorter line. */
function alignDays(days: string[], found: Map<string, { value: number; samples: number }>): DayValue[] {
  return days.map((day) => {
    const hit = found.get(day);
    return { day, value: hit?.value ?? 0, samples: hit?.samples ?? 0 };
  });
}

export function buildDashboard(db: Db, options: DashboardOptions): Dashboard {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const since24h = new Date(nowMs - 24 * 3600_000).toISOString();
  const since7d = new Date(nowMs - 7 * 24 * 3600_000).toISOString();
  const cutoff = new Date(nowMs - options.truncatedAfterMinutes * 60_000).toISOString();

  const scalar = (sql: string, params: Record<string, unknown> = {}): unknown =>
    Object.keys(params).length > 0 ? db.prepare(sql).get(params) : db.prepare(sql).get();

  // --- 1. Is the pipe alive? -------------------------------------------
  const lastDeliveryAt = textOf(
    scalar(`SELECT MAX(received_at) AS v FROM deliveries WHERE outcome IN ('export','probe','quarantined')`),
  );
  const strip: PipeStrip = {
    lastDeliveryAt,
    lastExportAt: textOf(scalar(`SELECT MAX(received_at) AS v FROM deliveries WHERE outcome = 'export'`)),
    lastCompleteRunAt: textOf(
      scalar(`SELECT MAX(last_seen) AS v FROM runs WHERE final_seen = 1 AND batches_seen = max_sequence`),
    ),
    truncatedRuns: numOf(
      scalar(
        `SELECT COUNT(*) AS v FROM runs WHERE NOT (final_seen = 1 AND batches_seen = max_sequence) AND last_seen < @cutoff`,
        { cutoff },
      ),
    ),
    truncatedRuns7d: numOf(
      scalar(
        `SELECT COUNT(*) AS v FROM runs WHERE NOT (final_seen = 1 AND batches_seen = max_sequence) AND last_seen < @cutoff AND last_seen >= @since`,
        { cutoff, since: since7d },
      ),
    ),
    unauthorised24h: numOf(
      scalar(`SELECT COUNT(*) AS v FROM deliveries WHERE outcome = 'unauthorised' AND received_at >= @since`, {
        since: since24h,
      }),
    ),
    lastUnauthorisedAt: textOf(
      scalar(`SELECT MAX(received_at) AS v FROM deliveries WHERE outcome = 'unauthorised'`),
    ),
    quarantined24h: numOf(
      scalar(`SELECT COUNT(*) AS v FROM deliveries WHERE outcome = 'quarantined' AND received_at >= @since`, {
        since: since24h,
      }),
    ),
    quarantinedTotal: numOf(scalar(`SELECT COUNT(*) AS v FROM quarantine`)),
    samplesReceived24h: numOf(scalar(`SELECT COUNT(*) AS v FROM samples WHERE received_at >= @since`, { since: since24h })),
    samplesReceived7d: numOf(scalar(`SELECT COUNT(*) AS v FROM samples WHERE received_at >= @since`, { since: since7d })),
    samplesTotal: numOf(scalar(`SELECT COUNT(*) AS v FROM samples`)),
    samplesDropped: numOf(scalar(`SELECT COALESCE(SUM(rejected_count), 0) AS v FROM batches`)),
    samplesDuplicate: numOf(scalar(`SELECT COALESCE(SUM(duplicate_count), 0) AS v FROM deliveries WHERE outcome = 'export'`)),
    samplesRejected: numOf(scalar(`SELECT COALESCE(SUM(rejected_count), 0) AS v FROM deliveries WHERE outcome = 'export'`)),
    runsTotal: numOf(scalar(`SELECT COUNT(*) AS v FROM runs`)),
    dbBytes: dbFileBytes(options.dbPath),
    dbPath: options.dbPath,
    state: "empty",
    stateReason: "nothing has ever arrived",
  };

  if (lastDeliveryAt !== null) {
    const ageHours = (nowMs - Date.parse(lastDeliveryAt)) / 3600_000;
    if (ageHours > NO_DELIVERY_WARN_HOURS) {
      strip.state = "warn";
      strip.stateReason = `no delivery for ${Math.floor(ageHours)}h (warn above ${NO_DELIVERY_WARN_HOURS}h)`;
    } else if (strip.truncatedRuns7d > 0) {
      strip.state = "warn";
      strip.stateReason = `${strip.truncatedRuns7d} truncated run(s) in the last 7 days`;
    } else {
      strip.state = "ok";
      strip.stateReason = "deliveries arriving, no truncated run in 7 days";
    }
  }

  // --- 2. Freshness per metric type ------------------------------------
  const newestSampleAt = textOf(scalar(`SELECT MAX(start_at) AS v FROM samples`));
  const oldestSampleAt = textOf(scalar(`SELECT MIN(start_at) AS v FROM samples`));
  const referenceMs = newestSampleAt === null ? null : Date.parse(newestSampleAt);

  const typeRows = db
    .prepare(
      `SELECT type,
              MIN(kind)         AS kind,
              MIN(sample_group) AS grp,
              COUNT(*)          AS total,
              SUM(CASE WHEN start_at >= @since7d THEN 1 ELSE 0 END) AS count7d,
              MAX(start_at)     AS last_sample,
              MAX(received_at)  AS last_received
       FROM samples
       GROUP BY type
       ORDER BY last_sample DESC`,
    )
    .all({ since7d }) as {
    type: string;
    kind: string;
    grp: string;
    total: number;
    count7d: number;
    last_sample: string | null;
    last_received: string | null;
  }[];

  const recentStarts = db.prepare(
    `SELECT start_at AS v FROM samples WHERE type = @type ORDER BY start_at DESC LIMIT @limit`,
  );
  const dailyCounts = db.prepare(
    `SELECT date(start_at, 'localtime') AS day, COUNT(*) AS n
     FROM samples WHERE type = @type AND start_at >= @since
     GROUP BY day`,
  );
  const sparkAxis = lastDays(now, SPARK_DAYS);
  const sparkSince = startOfDayIso(now, SPARK_DAYS - 1);

  const types: TypeFreshness[] = typeRows.map((row) => {
    const starts = (recentStarts.all({ type: row.type, limit: GAP_SAMPLE_LIMIT }) as { v: string }[]).map((r) =>
      Date.parse(r.v),
    );
    const gaps: number[] = [];
    for (let i = 0; i + 1 < starts.length; i += 1) {
      const gap = ((starts[i] as number) - (starts[i + 1] as number)) / 1000;
      if (gap >= 0) gaps.push(gap);
    }
    const enough = starts.length >= MIN_SAMPLES_FOR_CADENCE;
    const medianGapSeconds = enough ? median(gaps) : null;
    const p90GapSeconds = enough ? percentile(gaps, 0.9) : null;
    const lastMs = row.last_sample === null ? null : Date.parse(row.last_sample);
    const lagSeconds = referenceMs !== null && lastMs !== null ? Math.max(0, Math.round((referenceMs - lastMs) / 1000)) : null;
    const thresholdSeconds =
      medianGapSeconds === null
        ? null
        : Math.max(
            STALE_FLOOR_SECONDS,
            Math.round(STALE_FACTOR * medianGapSeconds),
            Math.round(P90_FACTOR * (p90GapSeconds ?? 0)),
          );

    let state: TypeFreshness["state"] = "unknown";
    if (thresholdSeconds !== null && lagSeconds !== null) {
      state = lagSeconds > thresholdSeconds ? "amber" : "ok";
    }

    const counted = new Map<string, { value: number; samples: number }>();
    for (const bucket of dailyCounts.all({ type: row.type, since: sparkSince }) as { day: string; n: number }[]) {
      counted.set(bucket.day, { value: Number(bucket.n), samples: Number(bucket.n) });
    }

    return {
      type: row.type,
      kind: row.kind,
      group: row.grp,
      total: Number(row.total),
      count7d: Number(row.count7d),
      lastSampleAt: row.last_sample,
      lastReceivedAt: row.last_received,
      medianGapSeconds,
      p90GapSeconds,
      lagSeconds,
      thresholdSeconds,
      state,
      spark: alignDays(sparkAxis, counted).map((d) => d.value),
    };
  });

  // --- 3. A few readings worth a glance --------------------------------
  // Steps are source-resolved, not summed. Two devices on one body record the
  // same walk: measured on this store, 2026-09-17 was watch 9 245 + phone
  // 6 580 and this page used to print 15 825. One device wins the day; the
  // other is kept in `alternatives` and shown, never silently dropped.
  const stepRows = db
    .prepare(
      `SELECT date(start_at, 'localtime') AS day, source, COALESCE(SUM(value), 0) AS total, COUNT(*) AS n
       FROM samples WHERE type = @type AND start_at >= @since
       GROUP BY day, source`,
    )
    .all({ type: STEP_TYPE, since: sparkSince }) as SourceDayRow[];
  const steps: DayValue[] = resolveDays(stepRows, sparkAxis, localDay(now)).map((p) => ({
    day: p.day,
    value: p.value,
    samples: p.samples,
    source: p.source,
    alternatives: p.alternatives,
  }));

  const hrAxis = lastDays(now, HR_DAYS);
  const hrRows = db
    .prepare(
      `SELECT date(start_at, 'localtime') AS day, AVG(value) AS avg_value, COUNT(*) AS n
       FROM samples WHERE type = @type AND start_at >= @since
       GROUP BY day`,
    )
    .all({ type: RESTING_HR_TYPE, since: startOfDayIso(now, HR_DAYS - 1) }) as {
    day: string;
    avg_value: number;
    n: number;
  }[];
  const restingHr = alignDays(
    hrAxis,
    new Map(hrRows.map((r) => [r.day, { value: Number(r.avg_value), samples: Number(r.n) }])),
  );

  // Sleep is filed under the local date it ENDED on: a night that starts at
  // 23:40 belongs to the morning you wake up, not to the previous evening.
  const sleepRows = db
    .prepare(
      `SELECT date(end_at, 'localtime') AS day,
              COALESCE(SUM((julianday(end_at) - julianday(start_at)) * 24.0), 0) AS hours,
              COUNT(*) AS n
       FROM samples
       WHERE type = @type AND category_value IN (${ASLEEP_VALUES.join(",")}) AND end_at >= @since
       GROUP BY day`,
    )
    .all({ type: SLEEP_TYPE, since: sparkSince }) as { day: string; hours: number; n: number }[];
  const sleep = alignDays(
    sparkAxis,
    new Map(sleepRows.map((r) => [r.day, { value: Number(r.hours), samples: Number(r.n) }])),
  );

  const workouts = (
    db
      .prepare(
        `SELECT start_at, end_at, activity_name, activity_type, duration_seconds, distance_meters, active_energy_kcal
         FROM samples WHERE kind = 'workout' ORDER BY start_at DESC LIMIT @limit`,
      )
      .all({ limit: options.workoutLimit ?? 10 }) as {
      start_at: string;
      end_at: string;
      activity_name: string | null;
      activity_type: number | null;
      duration_seconds: number | null;
      distance_meters: number | null;
      active_energy_kcal: number | null;
    }[]
  ).map((r) => ({
    startAt: r.start_at,
    endAt: r.end_at,
    name: r.activity_name,
    activityType: r.activity_type,
    durationSeconds: r.duration_seconds,
    distanceMeters: r.distance_meters,
    energyKcal: r.active_energy_kcal,
  }));

  // --- 4. The log itself -----------------------------------------------
  const deliveries = (
    db
      .prepare(
        `SELECT received_at, remote_addr, method, path, status, bytes, sample_count, outcome, export_id, batch_sequence, note
         FROM deliveries ORDER BY id DESC LIMIT @limit`,
      )
      .all({ limit: options.deliveryLimit ?? 12 }) as {
      received_at: string;
      remote_addr: string | null;
      method: string;
      path: string;
      status: number;
      bytes: number;
      sample_count: number;
      outcome: string;
      export_id: string | null;
      batch_sequence: number | null;
      note: string | null;
    }[]
  ).map((r) => ({
    receivedAt: r.received_at,
    remoteAddr: r.remote_addr,
    method: r.method,
    path: r.path,
    status: Number(r.status),
    bytes: Number(r.bytes),
    sampleCount: Number(r.sample_count),
    outcome: r.outcome,
    exportId: r.export_id,
    batchSequence: r.batch_sequence,
    note: r.note,
  }));

  const runs = (
    db
      .prepare(
        `SELECT export_id, generated_at, window_start, window_end, occasion_start, occasion_end,
                first_seen, last_seen, batches_seen, max_sequence, final_seen, sample_count, stored_count
         FROM runs ORDER BY last_seen DESC LIMIT @limit`,
      )
      .all({ limit: options.runLimit ?? 8 }) as {
      export_id: string;
      generated_at: string;
      window_start: string;
      window_end: string;
      occasion_start: string | null;
      occasion_end: string | null;
      first_seen: string;
      last_seen: string;
      batches_seen: number;
      max_sequence: number;
      final_seen: number;
      sample_count: number;
      stored_count: number;
    }[]
  ).map((r) => ({
    exportId: r.export_id,
    generatedAt: r.generated_at,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    occasionStart: r.occasion_start,
    occasionEnd: r.occasion_end,
    span:
      r.occasion_start !== null
        ? { start: r.occasion_start, end: r.occasion_end ?? r.window_end, source: "occasion" as const }
        : { start: r.window_start, end: r.window_end, source: "window" as const },
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    batchesSeen: Number(r.batches_seen),
    maxSequence: Number(r.max_sequence),
    finalSeen: r.final_seen === 1,
    sampleCount: Number(r.sample_count),
    storedCount: Number(r.stored_count),
    truncated: !(r.final_seen === 1 && r.batches_seen === r.max_sequence) && r.last_seen < cutoff,
  }));

  return {
    generatedAt: now.toISOString(),
    sparkDays: SPARK_DAYS,
    hrDays: HR_DAYS,
    strip,
    newestSampleAt,
    oldestSampleAt,
    types,
    steps,
    restingHr,
    sleep,
    workouts,
    deliveries,
    runs,
  };
}
