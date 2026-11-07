import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { envelopeSchema, sampleSchema, type Sample } from "../src/envelope.js";
import { buildReadServer } from "../src/read.js";
import { createStore } from "../src/store.js";

/**
 * `npm run demo` -- the whole product in one command, with no iPhone.
 *
 * It seeds a synthetic store for one plausible person and serves the dashboard
 * against it. Three rules:
 *
 *   1. Nothing personal ever enters this repo. Every number here is generated
 *      from a fixed seed; no owner's store, dates or bundle ids appear.
 *   2. It never writes near the real store. The database is a fresh file in
 *      the system temp directory, deleted and rebuilt on every run.
 *   3. It is not a happy path. The demo deliberately ships two sources that
 *      record the same walk (so the double-count disclosure is visible), a
 *      metric group that is switched off (so the "not exported" line is
 *      visible), and a partial today (so the hatching is visible). Those
 *      states are the interesting engineering; a demo that hides them is an
 *      advert.
 *
 * Usage:
 *   npm run demo
 *   npm run demo -- --groups=sleep            # one group only
 *   npm run demo -- --groups=                 # nothing at all: the empty state
 *   npm run demo -- --groups=all --port=4790
 *   npm run demo -- --no-serve                # seed and exit (used by tests)
 */

const ALL_GROUPS = ["activity", "heart", "sleep", "workouts", "body", "vitals"] as const;
type Group = (typeof ALL_GROUPS)[number];

/** The `vitals` group is off by default, on purpose: see rule 3. */
const DEFAULT_GROUPS: Group[] = ["activity", "heart", "sleep", "workouts", "body"];

const WATCH = "com.example.watch";
const PHONE = "com.apple.health.00000000-0000-4000-8000-000000000001";

export interface Args {
  groups: Group[];
  days: number;
  seed: number;
  port: number;
  serve: boolean;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const rawGroups = get("groups");
  let groups: Group[];
  if (rawGroups === undefined) groups = DEFAULT_GROUPS;
  else if (rawGroups === "all") groups = [...ALL_GROUPS];
  else {
    groups = rawGroups
      .split(",")
      .map((g) => g.trim())
      .filter((g): g is Group => (ALL_GROUPS as readonly string[]).includes(g));
  }
  return {
    groups,
    days: Number(get("days") ?? 30),
    seed: Number(get("seed") ?? 20260919),
    port: Number(get("port") ?? 4790),
    serve: !argv.includes("--no-serve"),
  };
}

/** mulberry32: small, deterministic, and good enough to look like a person. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;
function uuid(): string {
  counter += 1;
  return `DEMO0000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function contentId(): string {
  return counter.toString(16).padStart(64, "0");
}

interface Draft {
  type: string;
  group: string;
  source: string;
  start: Date;
  end?: Date;
  kind: "quantity" | "category" | "workout";
  value?: number;
  unit?: string;
  name?: string;
  activityType?: number;
  activityName?: string;
  durationSeconds?: number;
  distanceMeters?: number;
  activeEnergyKilocalories?: number;
}

function toSample(d: Draft): Sample {
  const base = {
    uuid: uuid(),
    id: contentId(),
    type: d.type,
    group: d.group,
    source: d.source,
    start: d.start.toISOString(),
    end: (d.end ?? d.start).toISOString(),
  };
  const shaped =
    d.kind === "quantity"
      ? { ...base, kind: "quantity", value: d.value ?? 0, unit: d.unit ?? "count" }
      : d.kind === "category"
        ? { ...base, kind: "category", value: d.value ?? 0, ...(d.name === undefined ? {} : { name: d.name }) }
        : {
            ...base,
            kind: "workout",
            activityType: d.activityType ?? 52,
            ...(d.activityName === undefined ? {} : { activityName: d.activityName }),
            durationSeconds: d.durationSeconds ?? 0,
            ...(d.distanceMeters === undefined ? {} : { distanceMeters: d.distanceMeters }),
            ...(d.activeEnergyKilocalories === undefined ? {} : { activeEnergyKilocalories: d.activeEnergyKilocalories }),
          };
  // Parsed with the real schema, so the demo is also a check that what we
  // generate is something healthd could actually have sent.
  return sampleSchema.parse(shaped);
}

export function generate(args: Args, now: Date): Sample[] {
  const rand = rng(args.seed);
  const out: Sample[] = [];
  const has = (g: Group): boolean => args.groups.includes(g);
  const at = (dayOffset: number, hour: number, minute = 0): Date =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, hour, minute, 0);
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

  for (let d = args.days - 1; d >= 0; d -= 1) {
    const isToday = d === 0;
    // Today is not over: only the hours that have actually happened exist.
    const lastHour = isToday ? Math.max(now.getHours(), 1) : 24;
    const energetic = between(0.75, 1.25);

    if (has("activity")) {
      for (let hour = 6; hour < lastHour; hour += 1) {
        const awake = hour >= 7 && hour <= 22;
        if (!awake) continue;
        const busy = hour === 8 || hour === 12 || hour === 18 ? between(1.6, 2.6) : between(0.3, 1.2);
        const steps = Math.round(between(220, 620) * busy * energetic);
        // Both devices watch the same walk. The watch is on the wrist all day;
        // the phone stays on the desk for part of it, so it sees less -- which
        // is exactly the case that makes summing them wrong.
        out.push({
          type: "HKQuantityTypeIdentifierStepCount",
          group: "activity",
          source: WATCH,
          start: at(d, hour, 5),
          end: at(d, hour, 59),
          kind: "quantity",
          value: steps,
          unit: "count",
        } as unknown as Sample);
        out.push({
          type: "HKQuantityTypeIdentifierStepCount",
          group: "activity",
          source: PHONE,
          start: at(d, hour, 7),
          end: at(d, hour, 58),
          kind: "quantity",
          value: Math.round(steps * between(0.55, 0.8)),
          unit: "count",
        } as unknown as Sample);
        out.push({
          type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
          group: "activity",
          source: WATCH,
          start: at(d, hour, 5),
          end: at(d, hour, 59),
          kind: "quantity",
          value: Math.round(steps * 0.72),
          unit: "m",
        } as unknown as Sample);
        out.push({
          type: "HKQuantityTypeIdentifierActiveEnergyBurned",
          group: "activity",
          source: WATCH,
          start: at(d, hour, 5),
          end: at(d, hour, 59),
          kind: "quantity",
          value: Math.round(between(16, 62) * busy * energetic),
          unit: "kcal",
        } as unknown as Sample);
        out.push({
          type: "HKQuantityTypeIdentifierBasalEnergyBurned",
          group: "activity",
          source: PHONE,
          start: at(d, hour, 0),
          end: at(d, hour, 59),
          kind: "quantity",
          value: Math.round(between(58, 74)),
          unit: "kcal",
        } as unknown as Sample);
        if (rand() > 0.35) {
          out.push({
            type: "HKQuantityTypeIdentifierAppleStandTime",
            group: "activity",
            source: WATCH,
            start: at(d, hour, 20),
            end: at(d, hour, 25),
            kind: "quantity",
            value: Math.round(between(1, 5)),
            unit: "min",
          } as unknown as Sample);
        }
        if (rand() > 0.7) {
          out.push({
            type: "HKQuantityTypeIdentifierFlightsClimbed",
            group: "activity",
            source: PHONE,
            start: at(d, hour, 30),
            kind: "quantity",
            value: Math.round(between(1, 4)),
            unit: "count",
          } as unknown as Sample);
        }
      }
      for (const [hour, minutes] of [
        [8, between(8, 22)],
        [12, between(6, 18)],
        [18, between(10, 30)],
      ] as [number, number][]) {
        if (hour >= lastHour) continue;
        out.push({
          type: "HKQuantityTypeIdentifierAppleExerciseTime",
          group: "activity",
          source: WATCH,
          start: at(d, hour, 10),
          end: at(d, hour, 40),
          kind: "quantity",
          value: Math.round(minutes * energetic),
          unit: "min",
        } as unknown as Sample);
      }
    }

    if (has("heart")) {
      for (let hour = 0; hour < lastHour; hour += 1) {
        for (const minute of [10, 40]) {
          const asleep = hour < 6;
          const base = asleep ? between(48, 58) : between(62, 84);
          const spike = hour === 8 || hour === 18 ? between(20, 58) : 0;
          out.push({
            type: "HKQuantityTypeIdentifierHeartRate",
            group: "heart",
            source: WATCH,
            start: at(d, hour, minute),
            kind: "quantity",
            value: Math.round(base + spike),
            unit: "count/min",
          } as unknown as Sample);
        }
      }
      out.push({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        group: "heart",
        source: WATCH,
        start: at(d, 7, 0),
        kind: "quantity",
        value: Math.round(between(50, 58)),
        unit: "count/min",
      } as unknown as Sample);
      out.push({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        group: "heart",
        source: WATCH,
        start: at(d, 7, 2),
        kind: "quantity",
        value: Math.round(between(32, 78)),
        unit: "ms",
      } as unknown as Sample);
    }

    if (has("sleep")) {
      // Filed under the morning you wake up, as the read model expects.
      let cursor = at(d + 1, 23, between(0, 45) > 22 ? 40 : 10);
      const stages: [number, string, number][] = [
        [0, "inBed", between(8, 16)],
        [3, "asleepCore", between(70, 110)],
        [4, "asleepDeep", between(45, 80)],
        [3, "asleepCore", between(60, 100)],
        [5, "asleepREM", between(40, 75)],
        [2, "awake", between(4, 12)],
        [3, "asleepCore", between(50, 90)],
      ];
      for (const [value, name, minutes] of stages) {
        const end = new Date(cursor.getTime() + minutes * 60_000);
        out.push({
          type: "HKCategoryTypeIdentifierSleepAnalysis",
          group: "sleep",
          source: WATCH,
          start: cursor,
          end,
          kind: "category",
          value,
          name,
        } as unknown as Sample);
        cursor = end;
      }
    }

    if (has("workouts") && (d % 3 === 1 || d % 7 === 4) && !isToday) {
      const kinds: [number, string, number][] = [
        [52, "walking", 1.35],
        [37, "running", 2.6],
        [13, "cycling", 3.4],
      ];
      const pick = kinds[Math.floor(rand() * kinds.length)] as [number, string, number];
      const duration = Math.round(between(1800, 5400));
      out.push({
        type: "HKWorkoutTypeIdentifier",
        group: "workouts",
        source: WATCH,
        start: at(d, 18, 10),
        end: new Date(at(d, 18, 10).getTime() + duration * 1000),
        kind: "workout",
        activityType: pick[0],
        activityName: pick[1],
        durationSeconds: duration,
        distanceMeters: Math.round((duration / 60) * pick[2] * 60),
        activeEnergyKilocalories: Math.round((duration / 60) * between(6, 11)),
      } as unknown as Sample);
    }

    if (has("body") && d % 2 === 0) {
      out.push({
        type: "HKQuantityTypeIdentifierBodyMass",
        group: "body",
        source: PHONE,
        start: at(d, 7, 30),
        kind: "quantity",
        value: Math.round(between(73.4, 74.9) * 10) / 10,
        unit: "kg",
      } as unknown as Sample);
    }

    if (has("vitals")) {
      out.push({
        type: "HKQuantityTypeIdentifierOxygenSaturation",
        group: "vitals",
        source: WATCH,
        start: at(d, 7, 5),
        kind: "quantity",
        value: Math.round(between(0.95, 0.99) * 1000) / 1000,
        unit: "fraction",
      } as unknown as Sample);
      out.push({
        type: "HKQuantityTypeIdentifierRespiratoryRate",
        group: "vitals",
        source: WATCH,
        start: at(d, 7, 6),
        kind: "quantity",
        value: Math.round(between(12, 17)),
        unit: "count/min",
      } as unknown as Sample);
    }
  }

  return out.map((s) => toSample(s as unknown as Draft));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  const dir = path.join(os.tmpdir(), "vitals-demo");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "demo.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + suffix);
    } catch {
      /* first run */
    }
  }

  const config = loadConfig({
    ...process.env,
    VITALS_DB: dbPath,
    VITALS_READ_PORT: String(args.port),
    VITALS_READ_HOST: "127.0.0.1",
  });
  const db = openDb(dbPath);
  const store = createStore(db, {
    dbPath,
    tokenHeader: config.tokenHeader,
    truncatedAfterMinutes: config.truncatedAfterMinutes,
  });

  const samples = generate(args, now);
  const exportId = "DEM0FEED-0000-4000-8000-000000000001";
  const batchSize = 500;
  const batches = Math.max(Math.ceil(samples.length / batchSize), 1);
  for (let i = 0; i < batches; i += 1) {
    const slice = samples.slice(i * batchSize, (i + 1) * batchSize);
    const envelope = envelopeSchema.parse({
      schemaVersion: 1,
      connectivityTest: false,
      exportId,
      generatedAt: now.toISOString(),
      batchSequence: i + 1,
      isFinalBatch: i === batches - 1,
      windowStart: new Date(now.getTime() - args.days * 86400_000).toISOString(),
      windowEnd: now.toISOString(),
      samples: slice,
    });
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    const receivedAt = new Date(now.getTime() - (batches - i) * 1000).toISOString();
    store.storeBatch(envelope, slice, receivedAt, bytes);
    store.recordDelivery({
      receivedAt,
      remoteAddr: "192.0.2.10",
      method: "POST",
      path: "/ingest",
      status: 200,
      bytes,
      sampleCount: slice.length,
      storedCount: slice.length,
      outcome: "export",
      exportId,
      batchSequence: i + 1,
    });
  }

  const groups = args.groups.length === 0 ? "none" : args.groups.join(", ");
  process.stdout.write(
    `vitals demo: ${samples.length} synthetic samples over ${args.days} days, groups: ${groups}\n` +
      `vitals demo: store ${dbPath} (temporary, rebuilt on every run)\n`,
  );

  if (!args.serve) {
    db.close();
    return;
  }

  const app = buildReadServer({ store, config });
  await app.listen({ host: config.readHost, port: config.readPort });
  process.stdout.write(
    `vitals demo: http://${config.readHost}:${config.readPort}/       the fitness page\n` +
      `vitals demo: http://${config.readHost}:${config.readPort}/pipe   delivery and diagnostics\n` +
      `vitals demo: Ctrl-C to stop\n`,
  );

  // Stopping the demo is the expected way to end it, not a failure: close the
  // listener and the store, and exit 0 on Ctrl-C or a plain kill.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// Importable for tests -- running the seed is a side effect, so it happens
// only when this file is the thing that was invoked.
const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(`vitals demo failed: ${String(error)}\n`);
    process.exit(1);
  });
}
