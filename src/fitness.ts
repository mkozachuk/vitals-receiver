import {
  ASLEEP_VALUES,
  buildDashboard,
  lastDays,
  localDay,
  RESTING_HR_TYPE,
  SLEEP_TYPE,
  STEP_TYPE,
  type PipeStrip,
  type TypeFreshness,
  type WorkoutRow,
} from "./dashboard.js";
import type { Db } from "./db.js";
import { resolveDays, sourceLabel, type DayPoint, type SourceDayRow, type SourceTotal } from "./sources.js";

export { resolveDays, sourceLabel };
export type { DayPoint, SourceDayRow, SourceTotal };

/**
 * The read model behind the fitness page at `/`.
 *
 * It answers a different question than `dashboard.ts` does -- "what did this
 * body do today" rather than "did anything arrive" -- but it does not get a
 * second opinion about pipe health: the strip and the per-type freshness are
 * taken from the dashboard model verbatim. There must be exactly one answer
 * to "is the pipe alive", and it is the one on /pipe.
 *
 * Three rules shape this file:
 *
 *  1. Every statement is a SELECT. The read listener never writes.
 *  2. Cumulative quantities are NEVER summed across sources. Two devices on
 *     one body record the same walk; summing them is the double-count bug
 *     this file exists to fix. See resolveDays().
 *  3. The model is built against healthd's CATALOG, not against whatever
 *     happens to be in one owner's store. A type that is absent is a state,
 *     not a gap to be hidden.
 */

export const FITNESS_DAYS = 14;
export const HEART_DAYS = 30;

export const ACTIVE_ENERGY_TYPE = "HKQuantityTypeIdentifierActiveEnergyBurned";
export const BASAL_ENERGY_TYPE = "HKQuantityTypeIdentifierBasalEnergyBurned";
export const DISTANCE_TYPE = "HKQuantityTypeIdentifierDistanceWalkingRunning";
export const FLIGHTS_TYPE = "HKQuantityTypeIdentifierFlightsClimbed";
export const EXERCISE_TYPE = "HKQuantityTypeIdentifierAppleExerciseTime";
export const STAND_TYPE = "HKQuantityTypeIdentifierAppleStandTime";
export const HEART_RATE_TYPE = "HKQuantityTypeIdentifierHeartRate";
export const WORKOUT_TYPE = "HKWorkoutTypeIdentifier";

/** HKCategoryValueSleepAnalysis, the ones that are a stage rather than a state. */
export const SLEEP_STAGES: Record<number, "core" | "deep" | "rem" | "unspecified"> = {
  1: "unspecified",
  3: "core",
  4: "deep",
  5: "rem",
};

export type Aggregation = "sum" | "mean";

export interface CatalogType {
  type: string;
  group: string;
  label: string;
  /** Unit as the page says it, after `scale` is applied. */
  unit: string;
  agg: Aggregation;
  /** Cumulative quantities must be source-resolved, never summed across sources. */
  cumulative: boolean;
  decimals: number;
  /** Stored value x scale = displayed value (metres -> km). */
  scale: number;
}

const q = (
  type: string,
  group: string,
  label: string,
  unit: string,
  opts: Partial<CatalogType> = {},
): CatalogType => ({
  type,
  group,
  label,
  unit,
  agg: opts.agg ?? "mean",
  cumulative: opts.cumulative ?? false,
  decimals: opts.decimals ?? 0,
  scale: opts.scale ?? 1,
});

/**
 * healthd's pinned catalog (docs/payload.md, vendored), every type it can ever send.
 * Built against this rather than against one store, because a distributed
 * example meets users who enabled groups this owner did not.
 */
export const CATALOG: CatalogType[] = [
  q(STEP_TYPE, "activity", "Steps", "steps", { agg: "sum", cumulative: true }),
  q(DISTANCE_TYPE, "activity", "Distance", "km", { agg: "sum", cumulative: true, decimals: 2, scale: 0.001 }),
  q(FLIGHTS_TYPE, "activity", "Flights climbed", "floors", { agg: "sum", cumulative: true }),
  q(ACTIVE_ENERGY_TYPE, "activity", "Active energy", "kcal", { agg: "sum", cumulative: true }),
  q(BASAL_ENERGY_TYPE, "activity", "Resting energy", "kcal", { agg: "sum", cumulative: true }),
  q(EXERCISE_TYPE, "activity", "Exercise minutes", "min", { agg: "sum", cumulative: true }),
  q(STAND_TYPE, "activity", "Stand time", "min", { agg: "sum", cumulative: true }),
  q(HEART_RATE_TYPE, "heart", "Heart rate", "bpm"),
  q(RESTING_HR_TYPE, "heart", "Resting heart rate", "bpm"),
  q("HKQuantityTypeIdentifierWalkingHeartRateAverage", "heart", "Walking heart rate", "bpm"),
  q("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "heart", "Heart rate variability", "ms"),
  q("HKQuantityTypeIdentifierBodyMass", "body", "Body mass", "kg", { decimals: 1 }),
  q("HKQuantityTypeIdentifierHeight", "body", "Height", "m", { decimals: 2 }),
  q("HKQuantityTypeIdentifierBodyMassIndex", "body", "Body mass index", "", { decimals: 1 }),
  q("HKQuantityTypeIdentifierBodyFatPercentage", "body", "Body fat", "%", { decimals: 1, scale: 100 }),
  q("HKQuantityTypeIdentifierLeanBodyMass", "body", "Lean body mass", "kg", { decimals: 1 }),
  q(SLEEP_TYPE, "sleep", "Sleep", "h", { decimals: 1 }),
  q("HKQuantityTypeIdentifierOxygenSaturation", "vitals", "Blood oxygen", "%", { decimals: 1, scale: 100 }),
  q("HKQuantityTypeIdentifierRespiratoryRate", "vitals", "Respiratory rate", "br/min", { decimals: 1 }),
  q("HKQuantityTypeIdentifierVO2Max", "vitals", "VO2 max", "ml/kg/min", { decimals: 1 }),
  q("HKQuantityTypeIdentifierBodyTemperature", "vitals", "Body temperature", "degC", { decimals: 1 }),
  q("HKQuantityTypeIdentifierBloodPressureSystolic", "vitals", "Blood pressure (systolic)", "mmHg"),
  q("HKQuantityTypeIdentifierBloodPressureDiastolic", "vitals", "Blood pressure (diastolic)", "mmHg"),
  q(WORKOUT_TYPE, "workouts", "Workouts", "", {}),
];

export const GROUP_LABELS: Record<string, string> = {
  activity: "Activity",
  heart: "Heart",
  body: "Body measurements",
  sleep: "Sleep",
  vitals: "Vitals",
  workouts: "Workouts",
};

const CATALOG_BY_TYPE = new Map(CATALOG.map((c) => [c.type, c]));

export type Quality = "data" | "no-qualifying-rows" | "absent";

export interface MetricCard {
  key: string;
  type: string;
  group: string;
  label: string;
  unit: string;
  decimals: number;
  kind: "bars" | "line" | "heart" | "sleep" | "workouts" | "energy";
  quality: Quality;
  /** Today's value, or null when today has no reading yet. */
  today: number | null;
  /** The headline when today is not the right number (sleep: last night). */
  headline: { label: string; value: number | null; unit: string };
  series: DayPoint[];
  average7d: number | null;
  averageLabel: string;
  daysWithoutData: number;
  goal: number | null;
  state: TypeFreshness["state"];
  lastSampleAt: string | null;
  /** Plain-words explanation printed under the card. */
  note: string | null;
  /** Today's winning source and the ones that also recorded. */
  source: string | null;
  sourceLabel: string | null;
  alternatives: SourceTotal[];
  heart?: {
    days: { day: string; min: number; mean: number; max: number; samples: number }[];
    today: { min: number; mean: number; max: number } | null;
    resting: number | null;
  };
  sleep?: {
    nights: { day: string; asleep: number; inBed: number; deep: number; core: number; rem: number; unspecified: number }[];
    stagesPresent: boolean;
  };
  energy?: { days: { day: string; active: number; basal: number }[] };
  workoutList?: WorkoutRow[];
}

export interface Ring {
  key: "move" | "exercise" | "stand" | "sleep";
  label: string;
  value: number | null;
  goal: number;
  unit: string;
  /** value / goal, uncapped: two laps is a true reading and the numeral says so. */
  progress: number;
  present: boolean;
  /** Set when the ring is drawn from a substitute type -- named, never silent. */
  fallback: string | null;
  note: string | null;
  title: string;
  source: string | null;
  sourceLabel: string | null;
  alternatives: SourceTotal[];
  decimals: number;
}

export interface WeekDay {
  day: string;
  initial: string;
  today: boolean;
  future: boolean;
  /** Before the first sample this store holds: dotted, not empty. */
  beforeData: boolean;
  rings: { key: Ring["key"]; progress: number; present: boolean }[];
}

export interface SyncPill {
  state: "ok" | "warn" | "bad" | "empty";
  label: string;
  detail: string;
}

export interface Fitness {
  generatedAt: string;
  today: string;
  dateLabel: string;
  title: string;
  empty: boolean;
  strip: PipeStrip;
  sync: SyncPill;
  /** Set when the pipe is behind: the rings are true, just not about today. */
  staleBanner: string | null;
  rings: Ring[];
  ringNotes: string[];
  week: WeekDay[];
  cards: MetricCard[];
  notExported: string[];
  sources: { source: string; label: string; samples: number }[];
  span: { from: string | null; to: string | null };
  samplesTotal: number;
  dbBytes: number;
  autoRefreshSeconds: number;
  goals: { moveKcal: number; exerciseMinutes: number; standHours: number };
  days: number;
  heartDays: number;
}

export interface FitnessOptions {
  dbPath: string;
  truncatedAfterMinutes: number;
  now?: Date;
  goals?: { moveKcal: number; exerciseMinutes: number; standHours: number };
  thirdRing?: "stand" | "sleep" | "off";
  sourcePriority?: string[];
  sourceNames?: Record<string, string>;
  autoRefreshSeconds?: number;
}

export const DEFAULT_GOALS = { moveKcal: 600, exerciseMinutes: 30, standHours: 12 };

/** Mean of the COMPLETE days in a window: today is never in an average. */
export function averageOfCompleteDays(points: DayPoint[], days: number): number | null {
  const complete = points.filter((p) => !p.partial && p.present).slice(-days);
  if (complete.length === 0) return null;
  return complete.reduce((acc, p) => acc + p.value, 0) / complete.length;
}

function startOfDayIso(now: Date, daysBack: number): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).toISOString();
}

const WEEK_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/** Monday-first. Apple follows the locale; this picks one and says so, since
 *  a page rendered on a stranger's machine must not move its own week. */
export function weekAxis(now: Date): string[] {
  const offset = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) =>
    localDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)),
  );
}

/**
 * A 401 matters when it is the LAST thing that happened on that credential.
 * Once an export has succeeded after it, the header was fixed and the count is
 * history -- history belongs on /pipe, not in a red pill that stays red for a
 * day after a successful setup. A status light nobody believes is worse than
 * no status light.
 */
function unauthorisedIsCurrent(strip: PipeStrip): boolean {
  if (strip.lastUnauthorisedAt === null) return false;
  if (strip.lastExportAt === null) return true;
  return strip.lastUnauthorisedAt > strip.lastExportAt;
}

export function buildFitness(db: Db, options: FitnessOptions): Fitness {
  const now = options.now ?? new Date();
  const goals = options.goals ?? DEFAULT_GOALS;
  const thirdRing = options.thirdRing ?? "stand";
  const priority = options.sourcePriority ?? [];
  const names = options.sourceNames ?? {};
  const today = localDay(now);

  const dash = buildDashboard(db, {
    dbPath: options.dbPath,
    truncatedAfterMinutes: options.truncatedAfterMinutes,
    now,
    deliveryLimit: 1,
    runLimit: 1,
    workoutLimit: 5,
  });
  const strip = dash.strip;
  const freshness = new Map(dash.types.map((t) => [t.type, t]));

  const axis = lastDays(now, FITNESS_DAYS);
  const heartAxis = lastDays(now, HEART_DAYS);
  // The week can reach further back than the card window in the first days of
  // a month-long week? It cannot -- 7 <= 14 -- but it can reach into the
  // FUTURE, and future days must not be read as days with no data.
  const week = weekAxis(now);
  const since = startOfDayIso(now, FITNESS_DAYS - 1);
  const heartSince = startOfDayIso(now, HEART_DAYS - 1);

  const sumBySource = db.prepare(
    `SELECT date(start_at, 'localtime') AS day, source, COALESCE(SUM(value), 0) AS total, COUNT(*) AS n
       FROM samples WHERE type = @type AND start_at >= @since
      GROUP BY day, source`,
  );
  const meanByDay = db.prepare(
    `SELECT date(start_at, 'localtime') AS day, MIN(value) AS mn, AVG(value) AS av, MAX(value) AS mx, COUNT(*) AS n
       FROM samples WHERE type = @type AND start_at >= @since
      GROUP BY day`,
  );
  // "Stand hours" is the count of distinct clock hours with any stand minute
  // in them -- Apple's own definition, and not the same thing as summing
  // stand minutes.
  const standHoursBySource = db.prepare(
    `SELECT day, source, COUNT(*) AS total, SUM(n) AS n FROM (
       SELECT date(start_at, 'localtime') AS day, source,
              strftime('%H', start_at, 'localtime') AS hour, COUNT(*) AS n
         FROM samples WHERE type = @type AND start_at >= @since AND value > 0
        GROUP BY day, source, hour
     ) GROUP BY day, source`,
  );
  const workoutMinutesBySource = db.prepare(
    `SELECT date(start_at, 'localtime') AS day, source,
            COALESCE(SUM(duration_seconds), 0) / 60.0 AS total, COUNT(*) AS n
       FROM samples WHERE kind = 'workout' AND start_at >= @since
      GROUP BY day, source`,
  );

  const cumulative = (type: string, axisDays: string[], sinceIso: string): DayPoint[] =>
    resolveDays(sumBySource.all({ type, since: sinceIso }) as SourceDayRow[], axisDays, today, priority, names);

  const typePresent = (type: string): boolean => freshness.has(type);

  // --- rings -----------------------------------------------------------
  const moveDays = cumulative(ACTIVE_ENERGY_TYPE, axis, since);
  const exerciseFromType = typePresent(EXERCISE_TYPE);
  const exerciseDays = exerciseFromType
    ? cumulative(EXERCISE_TYPE, axis, since)
    : resolveDays(workoutMinutesBySource.all({ since }) as SourceDayRow[], axis, today, priority, names);
  const standDays = resolveDays(
    standHoursBySource.all({ type: STAND_TYPE, since }) as SourceDayRow[],
    axis,
    today,
    priority,
    names,
  );

  const sleepRows = db
    .prepare(
      `SELECT date(end_at, 'localtime') AS day, category_value AS cv,
              COALESCE(SUM((julianday(end_at) - julianday(start_at)) * 24.0), 0) AS hours,
              COUNT(*) AS n
         FROM samples WHERE type = @type AND end_at >= @since
        GROUP BY day, cv`,
    )
    .all({ type: SLEEP_TYPE, since }) as { day: string; cv: number | null; hours: number; n: number }[];

  const nights = axis.map((day) => {
    const mine = sleepRows.filter((r) => r.day === day);
    const stage = (value: number): number => mine.filter((r) => r.cv === value).reduce((a, r) => a + r.hours, 0);
    const asleep = mine.filter((r) => ASLEEP_VALUES.includes(r.cv ?? -1)).reduce((a, r) => a + r.hours, 0);
    return {
      day,
      asleep,
      inBed: stage(0),
      unspecified: stage(1),
      core: stage(3),
      deep: stage(4),
      rem: stage(5),
    };
  });
  const sleepStagesPresent = sleepRows.some((r) => ASLEEP_VALUES.includes(r.cv ?? -1));

  const pointFor = (points: DayPoint[], day: string): DayPoint | undefined => points.find((p) => p.day === day);
  const todayPoint = (points: DayPoint[]): DayPoint | undefined => pointFor(points, today);

  const ringNotes: string[] = [];

  function makeRing(
    key: Ring["key"],
    label: string,
    unit: string,
    goal: number,
    present: boolean,
    point: DayPoint | undefined,
    decimals: number,
    fallback: string | null,
    absentNote: string,
  ): Ring {
    if (!present) {
      ringNotes.push(absentNote);
      return {
        key,
        label,
        value: null,
        goal,
        unit,
        progress: 0,
        present: false,
        fallback: null,
        note: absentNote,
        title: `${label}: not exported. Goal ${goal} ${unit}.`,
        source: null,
        sourceLabel: null,
        alternatives: [],
        decimals,
      };
    }
    const value = point?.value ?? 0;
    const progress = goal > 0 ? value / goal : 0;
    if (fallback !== null) ringNotes.push(fallback);
    return {
      key,
      label,
      value,
      goal,
      unit,
      progress,
      present: true,
      fallback,
      note: fallback,
      title: `${label}: ${value.toFixed(decimals)} of ${goal} ${unit} (${Math.round(progress * 100)}%)`,
      source: point?.source ?? null,
      sourceLabel: point?.sourceLabel ?? null,
      alternatives: point?.alternatives ?? [],
      decimals,
    };
  }

  const rings: Ring[] = [
    makeRing(
      "move",
      "Move",
      "kcal",
      goals.moveKcal,
      typePresent(ACTIVE_ENERGY_TYPE),
      todayPoint(moveDays),
      0,
      null,
      "Active energy is not being exported. Turn on Activity in healthd to fill this ring.",
    ),
    makeRing(
      "exercise",
      exerciseFromType ? "Exercise" : "Workouts",
      "min",
      goals.exerciseMinutes,
      exerciseFromType || dash.workouts.length > 0,
      todayPoint(exerciseDays),
      0,
      exerciseFromType
        ? null
        : "Exercise minutes are not being exported — showing workout duration instead. Enable Activity → Exercise Minutes in healthd for Apple's own figure.",
      "Exercise minutes are not being exported and no workouts have arrived. Turn on Activity in healthd to fill this ring.",
    ),
  ];

  if (thirdRing === "stand") {
    rings.push(
      makeRing(
        "stand",
        "Stand",
        "h",
        goals.standHours,
        typePresent(STAND_TYPE),
        todayPoint(standDays),
        0,
        null,
        "Stand time is not being exported. Turn on Activity in healthd to fill this ring.",
      ),
    );
  } else if (thirdRing === "sleep") {
    const night = nights.find((n) => n.day === today);
    rings.push(
      makeRing(
        "sleep",
        "Sleep",
        "h",
        8,
        sleepStagesPresent,
        {
          day: today,
          value: night?.asleep ?? 0,
          samples: 0,
          present: true,
          partial: false,
          source: null,
          sourceLabel: null,
          alternatives: [],
        },
        1,
        null,
        "Sleep stages are not being exported. This source reports time in bed only.",
      ),
    );
  }

  // --- week strip ------------------------------------------------------
  const firstDay = dash.oldestSampleAt === null ? null : localDay(new Date(dash.oldestSampleAt));
  const weekRingSource: Record<string, DayPoint[]> = {
    move: moveDays,
    exercise: exerciseDays,
    stand: standDays,
  };
  const weekDays: WeekDay[] = week.map((day, index) => ({
    day,
    initial: WEEK_INITIALS[index] as string,
    today: day === today,
    future: day > today,
    beforeData: firstDay !== null && day < firstDay,
    rings: rings.map((ring) => {
      if (ring.key === "sleep") {
        const night = nights.find((n) => n.day === day);
        return { key: ring.key, progress: (night?.asleep ?? 0) / (ring.goal || 1), present: sleepStagesPresent };
      }
      const point = pointFor(weekRingSource[ring.key] ?? [], day);
      return {
        key: ring.key,
        progress: ring.present && point !== undefined ? point.value / (ring.goal || 1) : 0,
        present: ring.present && (point?.present ?? false),
      };
    }),
  }));

  // --- cards -----------------------------------------------------------
  const cards: MetricCard[] = [];

  const stateOf = (type: string): TypeFreshness["state"] => freshness.get(type)?.state ?? "unknown";
  const lastOf = (type: string): string | null => freshness.get(type)?.lastSampleAt ?? null;

  function barsCard(entry: CatalogType, key: string, points: DayPoint[], goal: number | null): MetricCard {
    const scaled = points.map((p) => ({
      ...p,
      value: p.value * entry.scale,
      alternatives: p.alternatives.map((a) => ({ ...a, value: a.value * entry.scale })),
    }));
    const tp = scaled.find((p) => p.day === today);
    return {
      key,
      type: entry.type,
      group: entry.group,
      label: entry.label,
      unit: entry.unit,
      decimals: entry.decimals,
      kind: "bars",
      quality: "data",
      today: tp?.present === true ? tp.value : null,
      headline: { label: "Today", value: tp?.present === true ? tp.value : null, unit: entry.unit },
      series: scaled,
      average7d: averageOfCompleteDays(scaled, 7),
      averageLabel: "7-day average",
      daysWithoutData: scaled.filter((p) => !p.present && !p.partial).length,
      goal,
      state: stateOf(entry.type),
      lastSampleAt: lastOf(entry.type),
      note: null,
      source: tp?.source ?? null,
      sourceLabel: tp?.sourceLabel ?? null,
      alternatives: tp?.alternatives ?? [],
    };
  }

  const stepsEntry = CATALOG_BY_TYPE.get(STEP_TYPE) as CatalogType;
  const stepDays = cumulative(STEP_TYPE, axis, since);
  if (typePresent(STEP_TYPE)) cards.push(barsCard(stepsEntry, "steps", stepDays, null));

  if (typePresent(DISTANCE_TYPE)) {
    cards.push(barsCard(CATALOG_BY_TYPE.get(DISTANCE_TYPE) as CatalogType, "distance", cumulative(DISTANCE_TYPE, axis, since), null));
  }
  if (typePresent(FLIGHTS_TYPE)) {
    cards.push(barsCard(CATALOG_BY_TYPE.get(FLIGHTS_TYPE) as CatalogType, "flights", cumulative(FLIGHTS_TYPE, axis, since), null));
  }

  // Heart: the range is the reading, not a single number. Resting HR takes the
  // headline when it exists, because that is the number that means something.
  if (typePresent(HEART_RATE_TYPE)) {
    const rows = meanByDay.all({ type: HEART_RATE_TYPE, since: heartSince }) as {
      day: string;
      mn: number;
      av: number;
      mx: number;
      n: number;
    }[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const days = heartAxis
      .map((day) => {
        const r = byDay.get(day);
        return r === undefined
          ? null
          : { day, min: Number(r.mn), mean: Number(r.av), max: Number(r.mx), samples: Number(r.n) };
      })
      .filter((d): d is { day: string; min: number; mean: number; max: number; samples: number } => d !== null);
    const todayHr = days.find((d) => d.day === today) ?? null;
    const restingRows = typePresent(RESTING_HR_TYPE)
      ? (meanByDay.all({ type: RESTING_HR_TYPE, since: heartSince }) as { day: string; av: number }[])
      : [];
    const resting = restingRows.length === 0 ? null : Number((restingRows.at(-1) as { av: number }).av);
    const series = heartAxis.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        value: r === undefined ? 0 : Number(r.av),
        samples: r === undefined ? 0 : Number(r.n),
        present: r !== undefined,
        partial: day === today,
        source: null,
        sourceLabel: null,
        alternatives: [],
      };
    });
    cards.push({
      key: "heart",
      type: HEART_RATE_TYPE,
      group: "heart",
      label: "Heart rate",
      unit: "bpm",
      decimals: 0,
      kind: "heart",
      quality: "data",
      today: todayHr === null ? null : todayHr.mean,
      headline:
        resting === null
          ? { label: "Today", value: todayHr === null ? null : todayHr.mean, unit: "bpm" }
          : { label: "Resting", value: resting, unit: "bpm" },
      series,
      average7d: averageOfCompleteDays(series, 7),
      averageLabel: "7-day average",
      daysWithoutData: series.filter((p) => !p.present && !p.partial).length,
      goal: null,
      state: stateOf(HEART_RATE_TYPE),
      lastSampleAt: lastOf(HEART_RATE_TYPE),
      note: null,
      source: null,
      sourceLabel: null,
      alternatives: [],
      heart: {
        days,
        today: todayHr === null ? null : { min: todayHr.min, mean: todayHr.mean, max: todayHr.max },
        resting,
      },
    });
  }

  // Sleep, and the third state: rows present, none of them sleep.
  if (typePresent(SLEEP_TYPE)) {
    const quality: Quality = sleepStagesPresent ? "data" : "no-qualifying-rows";
    const series = nights.map((n) => ({
      day: n.day,
      value: sleepStagesPresent ? n.asleep : n.inBed,
      samples: 0,
      present: (sleepStagesPresent ? n.asleep : n.inBed) > 0,
      partial: false,
      source: null,
      sourceLabel: null,
      alternatives: [],
    }));
    const lastNight = [...series].reverse().find((s) => s.present) ?? null;
    cards.push({
      key: "sleep",
      type: SLEEP_TYPE,
      group: "sleep",
      label: sleepStagesPresent ? "Sleep" : "Time in bed",
      unit: "h",
      decimals: 1,
      kind: "sleep",
      quality,
      today: null,
      headline: {
        label: "Last night",
        value: lastNight === null ? null : lastNight.value,
        unit: "h",
      },
      series,
      average7d: averageOfCompleteDays(series, 7),
      averageLabel: "7-night average",
      daysWithoutData: series.filter((p) => !p.present).length,
      goal: null,
      state: stateOf(SLEEP_TYPE),
      lastSampleAt: lastOf(SLEEP_TYPE),
      note: sleepStagesPresent
        ? "Filed under the day you woke up. inBed and awake are excluded."
        : "This source reports time in bed only, not sleep stages — so there is no sleep duration to show.",
      source: null,
      sourceLabel: null,
      alternatives: [],
      sleep: { nights, stagesPresent: sleepStagesPresent },
    });
  }

  if (dash.workouts.length > 0) {
    const workoutDays = resolveDays(workoutMinutesBySource.all({ since }) as SourceDayRow[], axis, today, priority, names);
    cards.push({
      key: "workouts",
      type: WORKOUT_TYPE,
      group: "workouts",
      label: "Workouts",
      unit: "min",
      decimals: 0,
      kind: "workouts",
      quality: "data",
      today: todayPoint(workoutDays)?.value ?? null,
      headline: { label: "Last 14 days", value: workoutDays.reduce((a, p) => a + p.value, 0), unit: "min" },
      series: workoutDays,
      average7d: null,
      averageLabel: "",
      daysWithoutData: 0,
      goal: null,
      state: stateOf(WORKOUT_TYPE),
      lastSampleAt: lastOf(WORKOUT_TYPE),
      note: null,
      source: null,
      sourceLabel: null,
      alternatives: [],
      workoutList: dash.workouts,
    });
  }

  // Energy legitimately combines two sources -- active from one device, basal
  // from another -- so it says so rather than pretending one produced both.
  if (typePresent(ACTIVE_ENERGY_TYPE) || typePresent(BASAL_ENERGY_TYPE)) {
    const basalDays = cumulative(BASAL_ENERGY_TYPE, axis, since);
    const byDay = new Map(moveDays.map((p) => [p.day, p]));
    const basalByDay = new Map(basalDays.map((p) => [p.day, p]));
    const days = axis.map((day) => ({
      day,
      active: byDay.get(day)?.value ?? 0,
      basal: basalByDay.get(day)?.value ?? 0,
    }));
    const series = axis.map((day) => {
      const active = byDay.get(day);
      const basal = basalByDay.get(day);
      return {
        day,
        value: (active?.value ?? 0) + (basal?.value ?? 0),
        samples: (active?.samples ?? 0) + (basal?.samples ?? 0),
        present: (active?.present ?? false) || (basal?.present ?? false),
        partial: day === today,
        source: null,
        sourceLabel: null,
        alternatives: [],
      };
    });
    const tp = series.find((p) => p.day === today);
    cards.push({
      key: "energy",
      type: ACTIVE_ENERGY_TYPE,
      group: "activity",
      label: "Energy",
      unit: "kcal",
      decimals: 0,
      kind: "energy",
      quality: "data",
      today: tp?.present === true ? tp.value : null,
      headline: { label: "Active + resting today", value: tp?.present === true ? tp.value : null, unit: "kcal" },
      series,
      average7d: averageOfCompleteDays(series, 7),
      averageLabel: "7-day average",
      daysWithoutData: series.filter((p) => !p.present && !p.partial).length,
      goal: null,
      state: stateOf(ACTIVE_ENERGY_TYPE),
      lastSampleAt: lastOf(ACTIVE_ENERGY_TYPE),
      note: null,
      source: todayPoint(moveDays)?.source ?? null,
      sourceLabel: todayPoint(moveDays)?.sourceLabel ?? null,
      alternatives: todayPoint(moveDays)?.alternatives ?? [],
      energy: { days },
    });
  }

  // Anything else the catalog turns up: body, vitals, and whatever v1 adds
  // later. A generic numeric card beats not rendering a type at all.
  const handled = new Set([
    STEP_TYPE,
    DISTANCE_TYPE,
    FLIGHTS_TYPE,
    HEART_RATE_TYPE,
    RESTING_HR_TYPE,
    SLEEP_TYPE,
    WORKOUT_TYPE,
    ACTIVE_ENERGY_TYPE,
    BASAL_ENERGY_TYPE,
    EXERCISE_TYPE,
    STAND_TYPE,
  ]);
  for (const t of dash.types) {
    if (handled.has(t.type)) continue;
    const entry =
      CATALOG_BY_TYPE.get(t.type) ??
      q(t.type, t.group, t.type.replace(/^HK\w*?TypeIdentifier/, ""), "", { decimals: 1 });
    const rows = meanByDay.all({ type: t.type, since }) as { day: string; av: number; n: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = axis.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        value: r === undefined ? 0 : Number(r.av) * entry.scale,
        samples: r === undefined ? 0 : Number(r.n),
        present: r !== undefined,
        partial: day === today,
        source: null,
        sourceLabel: null,
        alternatives: [],
      };
    });
    const latest = [...series].reverse().find((s) => s.present) ?? null;
    cards.push({
      key: entry.type,
      type: entry.type,
      group: entry.group,
      label: entry.label,
      unit: entry.unit,
      decimals: entry.decimals,
      // Body mass, HRV, blood oxygen: a value that never approaches zero, so a
      // zero-based bar chart is fourteen identical slabs.
      kind: "line",
      quality: "data",
      today: series.find((s) => s.day === today)?.value ?? null,
      headline: { label: "Latest", value: latest === null ? null : latest.value, unit: entry.unit },
      series,
      average7d: averageOfCompleteDays(series, 7),
      averageLabel: "7-day average",
      daysWithoutData: series.filter((p) => !p.present && !p.partial).length,
      goal: null,
      state: t.state,
      lastSampleAt: t.lastSampleAt,
      note: null,
      source: null,
      sourceLabel: null,
      alternatives: [],
    });
  }

  // --- what is not here ------------------------------------------------
  const presentTypes = new Set(dash.types.map((t) => t.type));
  const absent = CATALOG.filter((c) => !presentTypes.has(c.type));
  const notExported: string[] = [];
  const seenGroups = new Set<string>();
  for (const entry of absent) {
    const groupTypes = CATALOG.filter((c) => c.group === entry.group);
    const wholeGroupAbsent = groupTypes.every((c) => !presentTypes.has(c.type));
    if (wholeGroupAbsent) {
      if (!seenGroups.has(entry.group)) {
        seenGroups.add(entry.group);
        notExported.push(GROUP_LABELS[entry.group] ?? entry.group);
      }
    } else {
      notExported.push(entry.label);
    }
  }

  const sourceRows = db
    .prepare(`SELECT source, COUNT(*) AS n FROM samples GROUP BY source ORDER BY n DESC`)
    .all() as { source: string; n: number }[];
  const sources = sourceRows.map((r) => ({
    source: r.source,
    label: sourceLabel(r.source, names),
    samples: Number(r.n),
  }));

  // --- the pill: one opinion about the pipe, borrowed, never re-derived --
  const lastDeliveryAgeHours =
    strip.lastDeliveryAt === null ? null : (now.getTime() - Date.parse(strip.lastDeliveryAt)) / 3600_000;
  let sync: SyncPill;
  if (strip.state === "empty") {
    sync = { state: "empty", label: "No data yet", detail: strip.stateReason };
  } else if (strip.unauthorised24h > 0 && unauthorisedIsCurrent(strip)) {
    sync = {
      state: "bad",
      label: `${strip.unauthorised24h} rejected sign-in${strip.unauthorised24h === 1 ? "" : "s"}`,
      detail: "a request reached the ingest listener with the wrong credential in the last 24h",
    };
  } else if (strip.state === "warn") {
    sync = {
      state: "warn",
      label:
        lastDeliveryAgeHours !== null && lastDeliveryAgeHours >= 24
          ? `Last sync ${Math.floor(lastDeliveryAgeHours / 24)}d ago`
          : "Check the pipe",
      detail: strip.stateReason,
    };
  } else {
    sync = {
      state: "ok",
      label: "Synced",
      detail:
        strip.unauthorised24h > 0
          ? `${strip.stateReason} \u00b7 ${strip.unauthorised24h} sign-in(s) were rejected earlier today, before the last successful export`
          : strip.stateReason,
    };
  }

  // The banner fires only when the numbers really are not about today. A
  // truncated run is worth an amber pill and is not, by itself, a reason to
  // tell the reader that today's rings are yesterday's.
  const newestDay = dash.newestSampleAt === null ? null : localDay(new Date(dash.newestSampleAt));
  const staleBanner =
    (sync.state === "warn" || sync.state === "bad") && newestDay !== null && newestDay < today
      ? `${sync.label} \u2014 these numbers are from ${newestDay}, not today.`
      : null;

  return {
    generatedAt: now.toISOString(),
    today,
    dateLabel: `${now.toLocaleDateString("en-GB", { weekday: "long" })}, ${now.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
    })}`,
    title: "Today",
    empty: strip.state === "empty" && strip.samplesTotal === 0,
    strip,
    sync,
    staleBanner,
    rings,
    ringNotes,
    week: weekDays,
    cards,
    notExported,
    sources,
    span: { from: dash.oldestSampleAt, to: dash.newestSampleAt },
    samplesTotal: strip.samplesTotal,
    dbBytes: strip.dbBytes,
    autoRefreshSeconds: options.autoRefreshSeconds ?? 0,
    goals,
    days: FITNESS_DAYS,
    heartDays: HEART_DAYS,
  };
}
