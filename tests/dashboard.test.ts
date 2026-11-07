import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildDashboard,
  percentile,
  lastDays,
  localDay,
  median,
  RESTING_HR_TYPE,
  SLEEP_TYPE,
  STEP_TYPE,
} from "../src/dashboard.js";
import { formatBytes, formatDuration, localStamp, relativeTime, sparkline } from "../src/render.js";
import { count, envelope, fixtureBytes, harness, one, pinnedClock, quantitySample, rows, TOKEN, type Harness } from "./helpers.js";

/**
 * Slice 3. Three things are being defended here:
 *   1. The page answers "did anything arrive" before it answers anything
 *      else, and it answers it honestly when the store is empty -- that is
 *      the first state the owner will ever see.
 *   2. The read listener cannot write and cannot leak the credential.
 *   3. Nothing dashboard-shaped is reachable on the ingest listener.
 */

let h: Harness;
beforeEach(() => {
  // `page()` fetches /pipe over HTTP and so reads the server's clock, not
  // `model()`'s. Both are pinned to NOW, the instant this file's data is
  // dated against.
  h = harness({}, { now: pinnedClock(NOW) });
});
afterEach(async () => {
  await h.close();
});

const NOW = new Date(2026, 8, 19, 12, 0, 0);
const model = (now: Date = NOW) =>
  buildDashboard(h.db, { dbPath: ":memory:", truncatedAfterMinutes: 60, now });

/** The ops dashboard now lives at /pipe. Every assertion in this file is
 *  about that page and follows it there, rather than being deleted. */
const page = async (): Promise<{ statusCode: number; html: string; headers: Record<string, unknown> }> => {
  const res = await h.read.inject({ method: "GET", url: "/pipe" });
  return { statusCode: res.statusCode, html: res.body, headers: res.headers as Record<string, unknown> };
};

/** A local wall-clock instant, serialised the way healthd serialises. */
function localIso(y: number, m: number, d: number, hh = 12, mm = 0): string {
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}

describe("the empty store", () => {
  it("renders a page that says nothing has arrived, rather than a page of zeroes", async () => {
    const res = await page();
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
    assert.match(res.html, /Nothing has arrived yet/);
    assert.match(res.html, /never/, "last delivery must read 'never', not '0'");
    assert.match(res.html, /no cadence to judge/, "the freshness table explains its own emptiness");
    assert.match(res.html, /delivery log is empty/);
    assert.ok(!res.html.includes("NaN"), "an empty store must not produce NaN");
    assert.ok(!res.html.includes("undefined"), "an empty store must not produce undefined");
    assert.ok(!res.html.includes("Infinity"));
  });

  it("reports the empty state in the model, not as a healthy one", () => {
    const m = model();
    assert.equal(m.strip.state, "empty");
    assert.equal(m.strip.lastDeliveryAt, null);
    assert.equal(m.strip.samplesTotal, 0);
    assert.equal(m.types.length, 0);
    assert.deepEqual(m.workouts, []);
  });
});

describe("the read listener is read-only", () => {
  it("rendering the page writes nothing at all", async () => {
    await h.post(fixtureBytes("worked-example.json"));
    const before = {
      samples: count(h.db, "samples"),
      deliveries: count(h.db, "deliveries"),
      runs: count(h.db, "runs"),
      batches: count(h.db, "batches"),
      quarantine: count(h.db, "quarantine"),
      meta: count(h.db, "meta"),
    };
    await page();
    await h.read.inject({ method: "GET", url: "/api/summary" });
    assert.deepEqual(
      {
        samples: count(h.db, "samples"),
        deliveries: count(h.db, "deliveries"),
        runs: count(h.db, "runs"),
        batches: count(h.db, "batches"),
        quarantine: count(h.db, "quarantine"),
        meta: count(h.db, "meta"),
      },
      before,
    );
    // /healthz is the one read route that writes -- that probe is how
    // dbWritable is proved. The dashboard must not go through it.
    assert.equal(rows(h.db, "SELECT * FROM meta WHERE key = 'healthz_probe_at'").length, 0);
  });

  it("refuses every write method before routing", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const url of ["/", "/pipe", "/api/summary", "/api/fitness", "/ingest", "/healthz"]) {
        const res = await h.read.inject({ method, url, payload: "{}" });
        assert.equal(res.statusCode, 405, `${method} ${url} must be refused`);
        assert.equal(res.headers.allow, "GET, HEAD");
      }
    }
    assert.equal(count(h.db, "samples"), 0);
    assert.equal(count(h.db, "deliveries"), 0);
  });

  it("never renders the credential", async () => {
    await h.post(fixtureBytes("worked-example.json"), { headers: { "x-extra": "nothing" } });
    const res = await page();
    assert.ok(!res.html.includes(TOKEN), "the page must never echo the credential");
    const summary = await h.read.inject({ method: "GET", url: "/api/summary" });
    assert.ok(!summary.body.includes(TOKEN));
    const css = await h.read.inject({ method: "GET", url: "/assets/pipe.css" });
    assert.equal(css.statusCode, 200);
    assert.match(String(css.headers["content-type"]), /text\/css/);
    assert.ok(!css.body.includes(TOKEN));
  });

  it("serves the stylesheet the page links, and no script at all", async () => {
    const res = await page();
    assert.match(res.html, /<link rel="stylesheet" href="\/assets\/pipe\.css">/);
    assert.ok(!/<script/i.test(res.html), "no JavaScript on the page");
    assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(res.headers["content-security-policy"]), /style-src 'self'/);
  });
});

describe("nothing dashboard-shaped is reachable on the ingest listener", () => {
  it("answers 404 to GET / and GET /healthz and returns no HTML", async () => {
    for (const url of ["/", "/pipe", "/healthz", "/api/summary", "/api/fitness", "/assets/app.css"]) {
      const res = await h.ingest.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, `GET ${url} must not be served on the ingest port`);
      assert.ok(!res.body.includes("<html"), "the ingest port must never emit a page");
      assert.ok(!res.body.includes("vitals —"));
    }
  });
});

describe("the top strip", () => {
  it("counts arrivals, and the page says so where the number is", async () => {
    await h.post(fixtureBytes("worked-example.json"));
    const m = model();
    assert.equal(m.strip.samplesReceived24h, 3);
    assert.equal(m.strip.samplesTotal, 3);
    assert.equal(m.strip.state, "ok");

    const res = await page();
    assert.match(res.html, /counted by <strong>arrival<\/strong>/);
    assert.match(res.html, /received_at/, "the received_at caveat is stated in the UI, not only in the log");
    assert.match(res.html, /coalesces/, "the coalescing caveat sits next to the sums");
    assert.match(res.html, /no deletions/);
    assert.match(res.html, /append-only, first stored wins per uuid/);
  });

  it("goes warn when a run truncated inside the last 7 days", async () => {
    const exportId = "99999999-8888-4777-8666-555555555555";
    await h.post(envelope({ exportId, batchSequence: 1, samples: [quantitySample()] }));
    // 90 minutes later, still no final batch: past the 60-minute cutoff.
    const m = model(new Date(NOW.getTime() + 90 * 60_000));
    assert.equal(m.strip.truncatedRuns7d, 1);
    assert.equal(m.strip.state, "warn");
    assert.match(m.strip.stateReason, /truncated/);
    assert.equal(m.runs[0]?.truncated, true);
  });

  it("goes warn when nothing has arrived for more than 36 hours", async () => {
    await h.post(fixtureBytes("probe.json"));
    const m = model(new Date(NOW.getTime() + 40 * 3600_000));
    assert.equal(m.strip.state, "warn");
    assert.match(m.strip.stateReason, /no delivery for 40h/);
  });
});

describe("freshness per metric type", () => {
  /** Ten samples of `type`, `gapMinutes` apart, the newest `agoMinutes` before `end`. */
  function series(type: string, uuidPrefix: string, end: Date, agoMinutes: number, gapMinutes: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      const at = new Date(end.getTime() - (agoMinutes + i * gapMinutes) * 60_000);
      out.push(
        quantitySample({
          uuid: `${uuidPrefix}-0000-4000-8000-${String(i).padStart(12, "0")}`,
          type,
          start: at.toISOString(),
          end: at.toISOString(),
          id: `${uuidPrefix}${i}`.padEnd(64, "0"),
        }),
      );
    }
    return out;
  }

  it("ambers a type that stopped while the others kept arriving, on its own cadence", async () => {
    const end = NOW;
    await h.post(
      envelope({
        isFinalBatch: true,
        samples: [
          // heart rate: every 10 minutes, right up to the window end
          ...series("HKQuantityTypeIdentifierHeartRate", "AAAAAAAA", end, 0, 10),
          // step count: also every 10 minutes, but it stopped 6 hours ago
          ...series(STEP_TYPE, "BBBBBBBB", end, 360, 10),
        ],
      }),
    );
    const m = model(end);
    const byType = new Map(m.types.map((t) => [t.type, t]));
    const hr = byType.get("HKQuantityTypeIdentifierHeartRate");
    const steps = byType.get(STEP_TYPE);

    assert.equal(hr?.state, "ok");
    assert.equal(hr?.lagSeconds, 0);
    assert.equal(hr?.medianGapSeconds, 600);
    assert.equal(steps?.state, "amber", "a type 6h behind a 10-minute cadence is amber");
    assert.equal(steps?.lagSeconds, 6 * 3600);
    assert.equal(steps?.thresholdSeconds, 1800, "3x a 10-minute median, above the 15m floor");

    const res = await page();
    assert.match(res.html, /stopped\?/, "the amber state is visible on the page");
    assert.match(res.html, /its own<\/em> observed rhythm/);
  });

  it("does not amber a bursty type between its bursts", async () => {
    // Sleep is the shape that breaks a median-only rule: four stage samples
    // ~90 minutes apart, then 22 hours of nothing. Measured on seeded data,
    // the median-only rule flagged it "stopped?" six hours after a normal
    // night -- which is a false alarm on the one metric that arrives daily.
    const samples: unknown[] = [];
    let n = 0;
    for (let night = 0; night < 6; night += 1) {
      for (let stage = 0; stage < 4; stage += 1) {
        const at = new Date(NOW.getTime() - night * 24 * 3600_000 - (6 - stage * 1.5) * 3600_000);
        n += 1;
        samples.push(
          quantitySample({
            uuid: `FFFFFFFF-0000-4000-8000-${String(n).padStart(12, "0")}`,
            type: "HKQuantityTypeIdentifierSleepProxy",
            start: at.toISOString(),
            end: at.toISOString(),
          }),
        );
      }
    }
    // ...and one type that is current, so the reference instant is "now".
    samples.push(quantitySample({ uuid: "FFFFFFFF-0000-4000-8000-999999999999", start: NOW.toISOString(), end: NOW.toISOString() }));
    await h.post(envelope({ samples }));

    const t = model().types.find((x) => x.type === "HKQuantityTypeIdentifierSleepProxy");
    assert.equal(t?.medianGapSeconds, 1.5 * 3600, "intra-burst gap");
    assert.equal(t?.p90GapSeconds, 19.5 * 3600, "the gap between bursts is the real period");
    assert.equal(t?.lagSeconds, 1.5 * 3600);
    assert.equal(t?.thresholdSeconds, Math.round(1.5 * 19.5 * 3600), "the p90 term, not the median, sets the tolerance");
    assert.equal(t?.state, "ok", "1.5h behind a daily burst is not a stopped feed");
  });

  it("does not judge a type it has not seen enough of", async () => {
    await h.post(envelope({ samples: [quantitySample({ type: "HKQuantityTypeIdentifierBodyMass", value: 71 })] }));
    const t = model().types.find((x) => x.type === "HKQuantityTypeIdentifierBodyMass");
    assert.equal(t?.state, "unknown");
    assert.equal(t?.medianGapSeconds, null);
  });

  it("escapes a hostile type name instead of rendering it", async () => {
    await h.post(
      envelope({
        samples: [quantitySample({ type: "HKQuantityTypeIdentifier<script>alert(1)</script>" })],
      }),
    );
    const res = await page();
    assert.ok(!res.html.includes("<script>alert(1)</script>"), "type names come off the wire and are escaped");
    assert.match(res.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

describe("the readings", () => {
  it("buckets steps on the local calendar day and sums them", async () => {
    const day = localIso(2026, 9, 18, 10, 30);
    const day2 = localIso(2026, 9, 19, 9, 0);
    await h.post(
      envelope({
        samples: [
          quantitySample({ uuid: "CCCCCCCC-0000-4000-8000-000000000001", type: STEP_TYPE, start: day, end: day, value: 1200, unit: "count" }),
          quantitySample({ uuid: "CCCCCCCC-0000-4000-8000-000000000002", type: STEP_TYPE, start: day, end: day, value: 800, unit: "count" }),
          quantitySample({ uuid: "CCCCCCCC-0000-4000-8000-000000000003", type: STEP_TYPE, start: day2, end: day2, value: 500, unit: "count" }),
        ],
      }),
    );
    const m = model();
    const axis = lastDays(NOW, m.sparkDays);
    assert.equal(axis.at(-1), localDay(NOW));
    const byDay = new Map(m.steps.map((d) => [d.day, d]));
    assert.equal(byDay.get("2026-09-18")?.value, 2000, "SQLite localtime bucketing must agree with the JS axis");
    assert.equal(byDay.get("2026-09-18")?.samples, 2);
    assert.equal(byDay.get("2026-09-19")?.value, 500);
    assert.equal(m.steps.length, m.sparkDays);

    const res = await page();
    assert.match(res.html, /Steps per day/);
    assert.match(res.html, /2 000 <span class="muted">steps/);
  });

  it("averages resting heart rate per day and lists workouts", async () => {
    const at = localIso(2026, 9, 19, 7, 0);
    const at2 = localIso(2026, 9, 19, 8, 0);
    await h.post(
      envelope({
        samples: [
          quantitySample({ uuid: "DDDDDDDD-0000-4000-8000-000000000001", type: RESTING_HR_TYPE, start: at, end: at, value: 52 }),
          quantitySample({ uuid: "DDDDDDDD-0000-4000-8000-000000000002", type: RESTING_HR_TYPE, start: at2, end: at2, value: 56 }),
          {
            uuid: "EEEEEEEE-0000-4000-8000-000000000001",
            id: "e".repeat(64),
            type: "HKWorkoutTypeIdentifier",
            group: "workout",
            source: "com.apple.health.dev",
            start: localIso(2026, 9, 19, 18, 0),
            end: localIso(2026, 9, 19, 18, 45),
            kind: "workout",
            activityType: 37,
            activityName: "Running",
            durationSeconds: 2700,
            distanceMeters: 7400,
            activeEnergyKilocalories: 512,
          },
        ],
      }),
    );
    const m = model();
    const hr = m.restingHr.find((d) => d.day === "2026-09-19");
    assert.equal(hr?.value, 54);
    assert.equal(hr?.samples, 2);
    assert.equal(m.restingHr.length, m.hrDays);
    assert.equal(m.workouts.length, 1);
    assert.equal(m.workouts[0]?.name, "Running");


    const res = await page();
    assert.match(res.html, /Running/);
    assert.match(res.html, /dot-unknown"><\/span>HKWorkoutTypeIdentifier/, "a type that is all prefix still gets a label");
    assert.match(res.html, /7\.40 km/);
    assert.match(res.html, /512 kcal/);
    // the reading is a daily average, not the last sample: (52 + 56) / 2
    assert.match(res.html, /latest 54 bpm/);
  });

  it("counts asleep stages as sleep and ignores inBed and awake", async () => {
    const night = (hh: number, mm: number): string => localIso(2026, 9, 19, hh, mm);
    const category = (uuid: string, value: number, start: string, end: string): Record<string, unknown> => ({
      uuid,
      id: "f".repeat(64),
      type: SLEEP_TYPE,
      group: "sleep",
      source: "com.apple.health.dev",
      start,
      end,
      kind: "category",
      value,
      name: "HKCategoryValueSleepAnalysis",
    });
    await h.post(
      envelope({
        samples: [
          category("11111111-0000-4000-8000-000000000001", 3, night(0, 0), night(3, 0)),
          category("11111111-0000-4000-8000-000000000002", 5, night(3, 0), night(4, 30)),
          category("11111111-0000-4000-8000-000000000003", 0, night(23, 0), night(23, 59)),
          category("11111111-0000-4000-8000-000000000004", 2, night(4, 30), night(5, 0)),
        ],
      }),
    );
    const m = model();
    const night19 = m.sleep.find((d) => d.day === "2026-09-19");
    assert.equal(Math.round((night19?.value ?? 0) * 10) / 10, 4.5, "3h core + 1.5h REM, inBed and awake excluded");
    assert.equal(night19?.samples, 2);
  });
});

describe("run metadata drift", () => {
  it("notes a batch that changes generatedAt, keeps the samples and the first values", async () => {
    const exportId = "77777777-6666-4555-8444-333333333333";
    await h.post(
      envelope({ exportId, batchSequence: 1, generatedAt: "2026-09-19T12:00:00.000+02:00", samples: [quantitySample()] }),
    );
    const second = await h.post(
      envelope({
        exportId,
        batchSequence: 2,
        isFinalBatch: true,
        generatedAt: "2026-09-19T13:00:00.000+02:00",
        windowEnd: "2026-09-19T13:00:00.000+02:00",
        samples: [quantitySample({ uuid: "AAAAAAAA-0000-4000-8000-000000000002", id: "b".repeat(64) })],
      }),
    );
    assert.equal(second.statusCode, 200, "drift is noted, never a reason to reject data");
    assert.equal(count(h.db, "samples"), 2);
    assert.equal(count(h.db, "quarantine"), 0);

    const run = one<{ generated_at: string; window_end: string }>(h.db, "SELECT * FROM runs");
    assert.equal(run.generated_at, "2026-09-19T10:00:00.000Z", "the first values stand");
    // Slice 6: the window is the run's extent, not batch 1's bracket, and a
    // window that moves is never drift on its own.
    assert.equal(run.window_end, "2026-09-19T11:00:00.000Z");

    const note = one<{ note: string }>(h.db, "SELECT note FROM deliveries WHERE batch_sequence = 2").note;
    assert.match(note, /run metadata drift/);
    assert.match(note, /generatedAt/);
    assert.doesNotMatch(note, /windowEnd/);

    const res = await page();
    assert.match(res.html, /run metadata drift/, "the drift note is visible in the delivery log");
  });

  it("counts duplicates when a re-delivered batch agrees with itself", async () => {
    await h.post(fixtureBytes("worked-example.json"));
    await h.post(fixtureBytes("worked-example.json"));
    const notes = rows<{ note: string | null }>(h.db, "SELECT note FROM deliveries ORDER BY id").map((d) => d.note);
    assert.equal(notes[0], null);
    assert.equal(notes[1], "3 duplicate sample(s)");
    assert.equal(buildDashboard(h.db, { dbPath: ":memory:", truncatedAfterMinutes: 60 }).strip.samplesDuplicate, 3);
  });
});

describe("the runs list's span", () => {
  // Slice 6. Synthetic instants, chosen so occasion and window cannot be
  // mistaken for one another in the rendered row.
  const exportId = "88888888-7777-4666-8555-444444444444";

  it("shows the occasion as the run's span when the run carries one", async () => {
    await h.post(
      envelope({
        exportId,
        basis: "anchor",
        occasionStart: "2026-09-17T06:00:00.000+02:00",
        occasionEnd: "2026-09-19T11:00:00.000+02:00",
        windowStart: "2026-09-18T20:00:00.000+02:00",
        windowEnd: "2026-09-18T22:00:00.000+02:00",
        samples: [quantitySample({ start: "2026-09-18T21:00:00.000+02:00" })],
      }),
    );
    const run = model().runs[0];
    assert.deepEqual(run?.span, {
      start: "2026-09-17T04:00:00.000Z",
      end: "2026-09-19T09:00:00.000Z",
      source: "occasion",
    });
    const res = await page();
    const cell = `<td title="occasion">${localStamp("2026-09-17T04:00:00.000Z")} → ${localStamp("2026-09-19T09:00:00.000Z")}</td>`;
    assert.ok(res.html.includes(cell), "the runs list shows the occasion, not batch 1's bracket");
  });

  it("falls back to the run's window when the run carries no occasion", async () => {
    await h.post(envelope({ exportId, batchSequence: 1, samples: [quantitySample()] }));
    await h.post(
      envelope({
        exportId,
        batchSequence: 2,
        isFinalBatch: true,
        windowEnd: "2026-09-19T12:30:00.000+02:00",
        samples: [quantitySample({ uuid: "AAAAAAAA-0000-4000-8000-000000000009", id: "9".repeat(64) })],
      }),
    );
    const run = model().runs[0];
    assert.deepEqual(run?.span, { start: "2026-09-18T10:00:00.000Z", end: "2026-09-19T10:30:00.000Z", source: "window" });
    const res = await page();
    const cell = `<td title="window">${localStamp("2026-09-18T10:00:00.000Z")} → ${localStamp("2026-09-19T10:30:00.000Z")}</td>`;
    assert.ok(res.html.includes(cell), "no occasion: the run's extent across both batches");
  });
});

describe("the rendering primitives", () => {
  it("draws a sparkline without dividing by zero", () => {
    const flat = sparkline([0, 0, 0, 0]);
    assert.match(flat, /<polyline/);
    assert.ok(!flat.includes("NaN"));
    const shaped = sparkline([1, 5, 3]);
    assert.match(shaped, /points="1,27 /);
    assert.ok(!shaped.includes("NaN"));
    assert.match(sparkline([]), /aria-label="no data"/);
  });

  it("formats the numbers a glance needs", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(3600), "1h");
    assert.equal(formatDuration(90000), "1d 1h");
    assert.equal(relativeTime(null, NOW), "never");
    assert.equal(relativeTime(new Date(NOW.getTime() - 7200_000).toISOString(), NOW), "2h ago");
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 5]), 2.5);
    assert.equal(median([]), null);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(percentile([], 0.9), null);
  });

  it("builds a DST-safe day axis", () => {
    const axis = lastDays(new Date(2026, 9, 26, 12, 0, 0), 3);
    assert.deepEqual(axis, ["2026-10-24", "2026-10-25", "2026-10-26"]);
  });
});
