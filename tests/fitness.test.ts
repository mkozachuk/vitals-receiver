import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SLEEP_TYPE, STEP_TYPE } from "../src/dashboard.js";
import {
  ACTIVE_ENERGY_TYPE,
  averageOfCompleteDays,
  BASAL_ENERGY_TYPE,
  buildFitness,
  EXERCISE_TYPE,
  HEART_RATE_TYPE,
  STAND_TYPE,
  resolveDays,
  sourceLabel,
  weekAxis,
  type Fitness,
} from "../src/fitness.js";
import { envelope, harness, pinnedClock, quantitySample, type Harness } from "./helpers.js";

/**
 * Slice 1. What is being defended here:
 *   1. A cumulative quantity is NEVER summed across two sources. This was a
 *      live bug: the shipped page printed 15 825 steps for a day whose two
 *      devices recorded 9 245 and 6 580 of the same walk.
 *   2. "No qualifying rows" is a third state, distinct from "no data" and
 *      from "zero" -- a store whose only sleep rows are inBed has a sleep
 *      type, sleep rows, and no sleep.
 *   3. Today is partial, always, and never lands in an average.
 *   4. The multi-source machinery is invisible when there is one source.
 */

let h: Harness;
beforeEach(() => {
  // Every fixture below is dated against NOW, so both servers are held there
  // too: `/api/fitness` reads its own clock, not `model()`'s.
  h = harness({}, { now: pinnedClock(NOW) });
});
afterEach(async () => {
  await h.close();
});

const NOW = new Date(2026, 8, 19, 12, 0, 0);
const WATCH = "com.example.watch";
const PHONE = "com.apple.health.00000000-0000-0000-0000-000000000000";

const model = (now: Date = NOW, opts: Record<string, unknown> = {}): Fitness =>
  buildFitness(h.db, { dbPath: ":memory:", truncatedAfterMinutes: 60, now, ...opts });

function localIso(y: number, m: number, d: number, hh = 12, mm = 0): string {
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}

let seq = 0;
function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return quantitySample({
    uuid: `AAAAAAAA-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    id: `${seq}`.padStart(64, "0"),
    ...overrides,
  });
}

const card = (m: Fitness, key: string) => m.cards.find((c) => c.key === key);
const ring = (m: Fitness, key: string) => m.rings.find((r) => r.key === key);

describe("two sources, one body", () => {
  it("takes the higher source for the day instead of summing them", async () => {
    // The measured case: a watch and a phone counting the same walk.
    await h.post(
      envelope({
        samples: [
          sample({ type: STEP_TYPE, source: WATCH, value: 9245, unit: "count", start: localIso(2026, 9, 17, 10) }),
          sample({ type: STEP_TYPE, source: PHONE, value: 6580, unit: "count", start: localIso(2026, 9, 17, 10, 30) }),
        ],
      }),
    );
    const steps = card(model(), "steps");
    const day = steps?.series.find((d) => d.day === "2026-09-17");
    assert.equal(day?.value, 9245, "the day is one device's total, never the sum");
    assert.notEqual(day?.value, 15825, "15 825 is the double count this slice exists to kill");
    assert.equal(day?.sourceLabel, "Watch");
    assert.equal(day?.alternatives.length, 1, "the losing source is kept, not discarded");
    assert.equal(day?.alternatives[0]?.value, 6580);
    assert.equal(day?.alternatives[0]?.label, "iPhone");
  });

  it("follows the device that was actually worn, day by day", () => {
    const rows = [
      { day: "2026-09-16", source: WATCH, total: 5961, n: 25 },
      { day: "2026-09-16", source: PHONE, total: 4486, n: 27 },
      // the day he left the watch on the charger
      { day: "2026-09-14", source: WATCH, total: 7815, n: 26 },
      { day: "2026-09-14", source: PHONE, total: 8471, n: 25 },
    ];
    const out = resolveDays(rows, ["2026-09-14", "2026-09-16"], "2026-09-19");
    assert.equal(out[0]?.source, PHONE, "the phone wins the day the watch was off the wrist");
    assert.equal(out[0]?.value, 8471);
    assert.equal(out[1]?.source, WATCH);
    assert.equal(out[1]?.value, 5961);
  });

  it("is deterministic when two sources tie", () => {
    const out = resolveDays(
      [
        { day: "2026-09-18", source: "com.zzz.b", total: 100, n: 1 },
        { day: "2026-09-18", source: "com.aaa.a", total: 100, n: 1 },
      ],
      ["2026-09-18"],
      "2026-09-19",
    );
    assert.equal(out[0]?.source, "com.aaa.a", "lowest source id breaks the tie, every time");
  });

  it("lets an explicit priority override the highest total", () => {
    const rows = [
      { day: "2026-09-18", source: WATCH, total: 9000, n: 5 },
      { day: "2026-09-18", source: PHONE, total: 100, n: 5 },
    ];
    const out = resolveDays(rows, ["2026-09-18"], "2026-09-19", ["com.apple.health"]);
    assert.equal(out[0]?.source, PHONE);
    assert.equal(out[0]?.value, 100);
    assert.equal(out[0]?.alternatives[0]?.value, 9000, "the bigger loser is still on the record");
  });

  it("says nothing about sources when there is only one", async () => {
    await h.post(
      envelope({
        samples: [sample({ type: STEP_TYPE, source: WATCH, value: 1200, unit: "count", start: localIso(2026, 9, 18, 9) })],
      }),
    );
    const m = model();
    const steps = card(m, "steps");
    assert.equal(steps?.series.every((d) => d.alternatives.length === 0), true);
    assert.equal(m.sources.length, 1, "the disclosure machinery must be invisible when it is not needed");
  });

  it("names a source in words and keeps the bundle id out of the label", () => {
    assert.equal(sourceLabel("com.apple.health.9E2C1A44-0000-4000-8000-0000000000FF"), "iPhone");
    assert.equal(sourceLabel("com.apple.Health"), "iPhone");
    assert.equal(sourceLabel("com.vendor.miwatch.pro"), "Mi Watch");
    assert.equal(sourceLabel("com.strava.stravaride"), "Stravaride");
    assert.equal(sourceLabel("com.acme.tracker", { "com.acme": "Acme Band" }), "Acme Band");
  });
});

describe("sleep that contains no sleep", () => {
  const category = (value: number, start: string, end: string): Record<string, unknown> => {
    seq += 1;
    return {
      uuid: `11111111-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      id: `${seq}`.padStart(64, "f"),
      type: SLEEP_TYPE,
      group: "sleep",
      source: WATCH,
      start,
      end,
      kind: "category",
      value,
      name: value === 0 ? "inBed" : "asleepCore",
    };
  };

  it("renders a third state when the rows are all inBed", async () => {
    await h.post(
      envelope({
        samples: [
          category(0, localIso(2026, 9, 18, 23, 0), localIso(2026, 9, 19, 6, 30)),
          category(0, localIso(2026, 9, 17, 23, 20), localIso(2026, 9, 18, 6, 0)),
        ],
      }),
    );
    const sleep = card(model(), "sleep");
    assert.equal(sleep?.quality, "no-qualifying-rows", "type present, rows present, nothing qualifying");
    assert.equal(sleep?.label, "Time in bed");
    assert.match(String(sleep?.note), /time in bed only/);
    const night = sleep?.series.find((d) => d.day === "2026-09-19");
    assert.ok((night?.value ?? 0) > 7 && (night?.value ?? 0) < 8, "inBed duration is reported as what it is");
    assert.equal(sleep?.sleep?.stagesPresent, false);
  });

  it("promotes nothing: a store with real stages reads as sleep", async () => {
    await h.post(
      envelope({
        samples: [
          category(3, localIso(2026, 9, 18, 23, 30), localIso(2026, 9, 19, 3, 30)),
          category(0, localIso(2026, 9, 18, 23, 0), localIso(2026, 9, 19, 6, 30)),
        ],
      }),
    );
    const sleep = card(model(), "sleep");
    assert.equal(sleep?.quality, "data");
    assert.equal(sleep?.label, "Sleep");
    const night = sleep?.series.find((d) => d.day === "2026-09-19");
    assert.equal(Math.round((night?.value ?? 0) * 10) / 10, 4, "4h core, and the 7.5h inBed is not added to it");
  });
});

describe("the rings", () => {
  it("ghosts a ring whose type is not exported, and says which", async () => {
    await h.post(
      envelope({ samples: [sample({ type: STEP_TYPE, value: 900, unit: "count", start: localIso(2026, 9, 19, 9) })] }),
    );
    const m = model();
    assert.equal(ring(m, "move")?.present, false);
    assert.equal(ring(m, "move")?.value, null);
    assert.equal(ring(m, "stand")?.present, false);
    assert.match(String(ring(m, "stand")?.note), /not being exported/);
    assert.match(String(ring(m, "stand")?.title), /not exported/);
    assert.equal(m.notExported.includes("Stand time"), true);
  });

  it("fills Move from the resolved source, not from the sum", async () => {
    await h.post(
      envelope({
        samples: [
          sample({ type: ACTIVE_ENERGY_TYPE, source: WATCH, value: 790, unit: "kcal", start: localIso(2026, 9, 19, 9) }),
          sample({ type: ACTIVE_ENERGY_TYPE, source: PHONE, value: 154, unit: "kcal", start: localIso(2026, 9, 19, 9, 5) }),
        ],
      }),
    );
    const move = ring(model(), "move");
    assert.equal(move?.value, 790, "944 would be the phone's pocket count added to the wrist's");
    assert.equal(move?.goal, 600);
    assert.ok((move?.progress ?? 0) > 1, "over goal is a true reading, not a capped one");
    assert.match(String(move?.title), /Move: 790 of 600 kcal \(132%\)/);
    assert.equal(move?.alternatives[0]?.value, 154);
  });

  it("labels the Exercise ring Workouts when it is drawn from workout duration", async () => {
    await h.post(
      envelope({
        samples: [
          {
            uuid: "EEEEEEEE-0000-4000-8000-000000000001",
            id: "e".repeat(64),
            type: "HKWorkoutTypeIdentifier",
            group: "workouts",
            source: WATCH,
            start: localIso(2026, 9, 19, 8, 0),
            end: localIso(2026, 9, 19, 9, 19),
            kind: "workout",
            activityType: 52,
            activityName: "walking",
            durationSeconds: 4740,
            distanceMeters: 5900,
            activeEnergyKilocalories: 337,
          },
        ],
      }),
    );
    const m = model();
    const exercise = ring(m, "exercise");
    assert.equal(exercise?.label, "Workouts", "a substituted ring is renamed, never silently substituted");
    assert.equal(Math.round(exercise?.value ?? 0), 79);
    assert.match(String(exercise?.fallback), /Exercise minutes are not being exported/);
  });

  it("keeps the Exercise name when the real type is there", async () => {
    await h.post(
      envelope({
        samples: [sample({ type: EXERCISE_TYPE, value: 42, unit: "min", start: localIso(2026, 9, 19, 9) })],
      }),
    );
    const exercise = ring(model(), "exercise");
    assert.equal(exercise?.label, "Exercise");
    assert.equal(exercise?.value, 42);
    assert.equal(exercise?.fallback, null);
  });

  it("counts stand hours as distinct hours with a stand minute, not as minutes", async () => {
    await h.post(
      envelope({
        samples: [
          sample({ type: STAND_TYPE, value: 1, unit: "min", start: localIso(2026, 9, 19, 9, 5) }),
          sample({ type: STAND_TYPE, value: 1, unit: "min", start: localIso(2026, 9, 19, 9, 40) }),
          sample({ type: STAND_TYPE, value: 2, unit: "min", start: localIso(2026, 9, 19, 10, 5) }),
          sample({ type: STAND_TYPE, value: 0, unit: "min", start: localIso(2026, 9, 19, 11, 5) }),
        ],
      }),
    );
    const stand = ring(model(), "stand");
    assert.equal(stand?.value, 2, "two hours contained a stand minute; the zero hour did not");
  });

  it("can be told to show sleep instead of stand, and no cleverer than that", async () => {
    const m = model(NOW, { thirdRing: "sleep" });
    assert.equal(m.rings.length, 3);
    assert.equal(m.rings[2]?.key, "sleep");
    const off = model(NOW, { thirdRing: "off" });
    assert.equal(off.rings.length, 2);
  });
});

describe("today is partial", () => {
  it("excludes today from every average and marks the day", async () => {
    const samples = [];
    for (const d of [16, 17, 18]) {
      samples.push(sample({ type: STEP_TYPE, source: WATCH, value: 6000, unit: "count", start: localIso(2026, 9, d, 10) }));
    }
    // today: a morning's worth, which must not drag the average down
    samples.push(sample({ type: STEP_TYPE, source: WATCH, value: 300, unit: "count", start: localIso(2026, 9, 19, 8) }));
    await h.post(envelope({ samples }));

    const steps = card(model(), "steps");
    assert.equal(steps?.average7d, 6000, "the average is over complete days only");
    assert.equal(steps?.series.find((d) => d.day === "2026-09-19")?.partial, true);
    assert.equal(steps?.today, 300);
    assert.equal(steps?.series.filter((d) => d.partial).length, 1, "exactly one day is partial: today");
  });

  // The rule above, once per series that builds its own points. Each of these
  // cards decides `partial` on its own line in src/fitness.ts, so each gets
  // its own test: a copy that drops the flag must turn exactly its card red.
  // Today's value is chosen so that counting it would move the mean.
  const assertTodayPartial = (c: ReturnType<typeof card>, completeMean: number) => {
    const partial = c?.series.filter((d) => d.partial) ?? [];
    assert.equal(partial.length, 1, "exactly one day is partial");
    assert.equal(partial[0]?.day, "2026-09-19", "and that day is today");
    assert.equal(c?.average7d, completeMean, "the average is over the complete days only");
  };

  it("marks today partial on the heart-rate series and keeps it out of the average", async () => {
    const samples = [];
    for (const d of [16, 17, 18]) {
      samples.push(sample({ type: HEART_RATE_TYPE, value: 60, unit: "count/min", start: localIso(2026, 9, d, 10) }));
    }
    // today: one hard minute, which would pull the mean to 75 if it counted
    samples.push(sample({ type: HEART_RATE_TYPE, value: 120, unit: "count/min", start: localIso(2026, 9, 19, 8) }));
    await h.post(envelope({ samples }));

    const heart = card(model(), "heart");
    assert.equal(heart?.today, 120);
    assertTodayPartial(heart, 60);
  });

  it("marks today partial on the energy series and keeps it out of the average", async () => {
    const samples = [];
    for (const d of [16, 17, 18]) {
      samples.push(sample({ type: ACTIVE_ENERGY_TYPE, group: "activity", source: WATCH, value: 500, unit: "kcal", start: localIso(2026, 9, d, 10) }));
      samples.push(sample({ type: BASAL_ENERGY_TYPE, group: "activity", source: WATCH, value: 1500, unit: "kcal", start: localIso(2026, 9, d, 10, 5) }));
    }
    // today: half a day of burn, 450 against complete days of 2000
    samples.push(sample({ type: ACTIVE_ENERGY_TYPE, group: "activity", source: WATCH, value: 50, unit: "kcal", start: localIso(2026, 9, 19, 8) }));
    samples.push(sample({ type: BASAL_ENERGY_TYPE, group: "activity", source: WATCH, value: 400, unit: "kcal", start: localIso(2026, 9, 19, 8, 5) }));
    await h.post(envelope({ samples }));

    const energy = card(model(), "energy");
    assert.equal(energy?.today, 450);
    assertTodayPartial(energy, 2000);
  });

  it("marks today partial on a catch-all series and keeps it out of the average", async () => {
    const BODY_MASS = "HKQuantityTypeIdentifierBodyMass";
    const samples = [];
    for (const d of [16, 17, 18]) {
      samples.push(sample({ type: BODY_MASS, group: "body", value: 80, unit: "kg", start: localIso(2026, 9, d, 7) }));
    }
    // today: a reading that would make the mean 82.5 if it counted
    samples.push(sample({ type: BODY_MASS, group: "body", value: 90, unit: "kg", start: localIso(2026, 9, 19, 7) }));
    await h.post(envelope({ samples }));

    const mass = card(model(), BODY_MASS);
    assert.equal(mass?.kind, "line", "drawn by the catch-all loop, not a dedicated card");
    assert.equal(mass?.today, 90);
    assertTodayPartial(mass, 80);
  });

  it("averages nothing when every day in the window is today", () => {
    const points = resolveDays([{ day: "2026-09-19", source: WATCH, total: 10, n: 1 }], ["2026-09-19"], "2026-09-19");
    assert.equal(averageOfCompleteDays(points, 7), null);
  });
});

describe("an empty store", () => {
  it("says so rather than rendering a page of zeroes", () => {
    const m = model();
    assert.equal(m.empty, true);
    assert.equal(m.sync.state, "empty");
    assert.equal(m.cards.length, 0);
    assert.equal(m.rings.every((r) => !r.present), true);
    assert.equal(m.sources.length, 0);
    assert.ok(!JSON.stringify(m).includes("NaN"));
    assert.ok(!JSON.stringify(m).includes("null,null"));
  });
});

describe("day bucketing", () => {
  it("gives every local day its own bucket across a DST change", async () => {
    const at = (d: number, hh: number) => localIso(2026, 10, d, hh);
    await h.post(
      envelope({
        samples: [
          sample({ type: STEP_TYPE, source: WATCH, value: 100, unit: "count", start: at(24, 12) }),
          sample({ type: STEP_TYPE, source: WATCH, value: 200, unit: "count", start: at(25, 12) }),
          sample({ type: STEP_TYPE, source: WATCH, value: 300, unit: "count", start: at(26, 12) }),
        ],
      }),
    );
    const m = model(new Date(2026, 9, 26, 18, 0, 0));
    const steps = card(m, "steps");
    const days = steps?.series.map((d) => d.day) ?? [];
    assert.equal(new Set(days).size, days.length, "no duplicated or skipped bucket over the DST boundary");
    assert.equal(steps?.series.find((d) => d.day === "2026-10-24")?.value, 100);
    assert.equal(steps?.series.find((d) => d.day === "2026-10-25")?.value, 200);
    assert.equal(steps?.series.find((d) => d.day === "2026-10-26")?.value, 300);
  });

  it("builds a Monday-first week that contains today", () => {
    const week = weekAxis(new Date(2026, 8, 19, 12, 0, 0));
    assert.deepEqual(week, [
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ]);
  });

  it("marks future days and pre-store days differently from empty ones", async () => {
    await h.post(
      envelope({
        samples: [sample({ type: STEP_TYPE, source: WATCH, value: 500, unit: "count", start: localIso(2026, 9, 18, 9) })],
      }),
    );
    const m = model();
    const sunday = m.week.find((d) => d.day === "2026-09-20");
    assert.equal(sunday?.future, true);
    assert.equal(m.week.find((d) => d.day === "2026-09-14")?.beforeData, true, "before the first sample is not zero");
    assert.equal(m.week.find((d) => d.day === "2026-09-18")?.beforeData, false);
    assert.equal(m.week.find((d) => d.day === "2026-09-19")?.today, true);
  });
});

describe("the sync pill borrows the pipe's one opinion", () => {
  it("is green when the strip is ok and red when sign-ins are being rejected", async () => {
    await h.post(envelope({ samples: [sample({ type: HEART_RATE_TYPE, value: 61 })] }));
    assert.equal(model().sync.state, "ok");

    await h.post(envelope({ samples: [] }), { token: "wrong-token-entirely" });
    const m = model();
    assert.equal(m.sync.state, "bad");
    assert.match(m.sync.label, /rejected sign-in/);
  });

  it("stops shouting about a 401 once an export has succeeded after it", async () => {
    // Measured on the real store: 25 rejected sign-ins during a morning of
    // setup, then 117 good exports. A red pill for the rest of the day would
    // be a false alarm, and a status light nobody believes is worse than none.
    await h.post(envelope({ samples: [] }), { token: "wrong-token-entirely" });
    await h.post(envelope({ samples: [sample({ type: HEART_RATE_TYPE, value: 61 })] }));
    const m = model();
    assert.equal(m.sync.state, "ok", "the credential was fixed; the rejections are history");
    assert.match(m.sync.detail, /rejected earlier/, "history is still stated, just not as an alarm");
    assert.equal(m.strip.unauthorised24h, 1, "and the count itself is never edited away");
  });

  it("does not claim the numbers are stale while today still has data", async () => {
    await h.post(
      envelope({
        samples: [sample({ type: STEP_TYPE, source: WATCH, value: 900, unit: "count", start: localIso(2026, 9, 19, 9) })],
      }),
    );
    // 90 minutes on from a run with no final batch: amber pipe, current data.
    const m = model(new Date(NOW.getTime() + 90 * 60_000));
    assert.equal(m.sync.state, "warn");
    assert.equal(m.staleBanner, null, "a truncated run does not make today's rings yesterday's");
  });

  it("goes amber with the pipe, and says which day the numbers are from", async () => {
    await h.post(
      envelope({
        samples: [sample({ type: STEP_TYPE, source: WATCH, value: 900, unit: "count", start: localIso(2026, 9, 17, 10) })],
      }),
    );
    const m = model(new Date(NOW.getTime() + 72 * 3600_000));
    assert.equal(m.sync.state, "warn");
    assert.match(String(m.staleBanner), /not today/);
    assert.equal(m.sync.detail, m.strip.stateReason, "the pill quotes the strip, it does not re-derive it");
  });
});

describe("the api", () => {
  it("serves the same model at /api/fitness and writes nothing", async () => {
    await h.post(
      envelope({
        samples: [sample({ type: STEP_TYPE, source: WATCH, value: 1500, unit: "count", start: localIso(2026, 9, 19, 9) })],
      }),
    );
    const res = await h.read.inject({ method: "GET", url: "/api/fitness" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Fitness;
    assert.equal(body.rings.length, 3);
    assert.equal(body.cards.find((c) => c.key === "steps")?.today, 1500);
  });
});
