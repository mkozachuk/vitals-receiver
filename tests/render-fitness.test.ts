import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { STEP_TYPE } from "../src/dashboard.js";
import { ACTIVE_ENERGY_TYPE, buildFitness, STAND_TYPE, type Fitness } from "../src/fitness.js";
import { FITNESS_CSS, renderFitness } from "../src/render-fitness.js";
import { envelope, harness, pinnedClock, quantitySample, type Harness } from "./helpers.js";

/**
 * Slice 2. The page is a second job for this repo -- it has to make a stranger
 * want the pipe -- and it must not buy that with a number it cannot support.
 * So: no script, no webfont, no inline style (the CSP forbids all three), a
 * <title> on every ring, and the double-count disclosure said in words on the
 * face of the card rather than in a README.
 */

let h: Harness;
beforeEach(() => {
  // The page is fetched over HTTP, so it gets its `now` from the read server,
  // not from `model()`. Pinned to the same instant the fixtures are dated
  // against -- otherwise every assertion here is really an assertion about
  // what today's date happens to be.
  h = harness({}, { now: pinnedClock(NOW) });
});
afterEach(async () => {
  await h.close();
});

const NOW = new Date(2026, 8, 19, 12, 0, 0);
const WATCH = "com.example.watch";
const PHONE = "com.apple.health.00000000-0000-0000-0000-000000000000";

let seq = 0;
function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return quantitySample({
    uuid: `BBBBBBBB-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    id: `${seq}`.padStart(64, "0"),
    ...overrides,
  });
}

const model = (opts: Record<string, unknown> = {}): Fitness =>
  buildFitness(h.db, { dbPath: ":memory:", truncatedAfterMinutes: 60, now: NOW, ...opts });

const get = async (url: string) => {
  const res = await h.read.inject({ method: "GET", url });
  return { statusCode: res.statusCode, html: res.body, headers: res.headers as Record<string, unknown> };
};

async function seedTwoSources(): Promise<void> {
  await h.post(
    envelope({
      samples: [
        sample({ type: STEP_TYPE, source: WATCH, value: 9245, unit: "count", start: new Date(2026, 8, 19, 10).toISOString() }),
        sample({ type: STEP_TYPE, source: PHONE, value: 6580, unit: "count", start: new Date(2026, 8, 19, 10, 30).toISOString() }),
        sample({ type: ACTIVE_ENERGY_TYPE, source: WATCH, value: 790, unit: "kcal", start: new Date(2026, 8, 19, 10).toISOString() }),
        sample({ type: ACTIVE_ENERGY_TYPE, source: PHONE, value: 154, unit: "kcal", start: new Date(2026, 8, 19, 10).toISOString() }),
      ],
    }),
  );
}

describe("the page keeps every constraint the CSP states", () => {
  it("has no script, no webfont and no inline style anywhere", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.equal(res.statusCode, 200);
    assert.ok(!/<script/i.test(res.html), "no JavaScript on the page");
    // style-src 'self' blocks inline style ATTRIBUTES too -- a single
    // style="..." would render the page unstyled in a compliant browser.
    assert.ok(!/ style="/.test(res.html), "no inline style attribute may exist");
    assert.ok(!/<style/i.test(res.html), "no inline stylesheet either");
    assert.ok(!/@import|fonts\.googleapis|https?:\/\//.test(FITNESS_CSS), "the stylesheet fetches nothing");
    assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(res.html, /<link rel="stylesheet" href="\/assets\/app\.css">/);
  });

  it("serves the fitness stylesheet at /assets/app.css and the ops one at /assets/pipe.css", async () => {
    const app = await get("/assets/app.css");
    const pipe = await get("/assets/pipe.css");
    assert.equal(app.statusCode, 200);
    assert.equal(pipe.statusCode, 200);
    assert.match(app.html, /--move-a/);
    assert.match(pipe.html, /ui-monospace/);
    assert.ok(!app.html.includes("text-transform: uppercase"), "the ops terminal voice stays on /pipe");
  });

  it("keeps the ops dashboard whole at /pipe", async () => {
    await seedTwoSources();
    const res = await get("/pipe");
    assert.equal(res.statusCode, 200);
    assert.match(res.html, /Is the pipe alive\?/);
    assert.match(res.html, /Delivery log/);
    assert.match(res.html, /<link rel="stylesheet" href="\/assets\/pipe\.css">/);
  });
});

describe("the rings on the page", () => {
  it("gives every ring an accessible title, since colour cannot carry a value", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.match(res.html, /<title>Move: 790 of 600 kcal \(132%\)<\/title>/);
    assert.match(res.html, /<title>Stand: not exported\. Goal 12 h\.<\/title>/);
  });

  it("draws a second lap when the goal is passed, and still prints the true number", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.match(res.html, /class="ring-arc ring-arc-move ring-lap"/, "over-goal draws the remainder on top");
    assert.match(res.html, /readout-num-move">790</, "the numeral is the literal truth, not the capped one");
  });

  it("ghosts an absent ring instead of hiding it or faking it", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.match(res.html, /ring-track-stand ring-ghost/);
    assert.match(res.html, /Stand time is not being exported/);
    assert.match(res.html, /&mdash;<\/span><span class="readout-goal">\/12 H/);
  });

  it("names the fallback ring Workouts rather than quietly calling it Exercise", async () => {
    await h.post(
      envelope({
        samples: [
          {
            uuid: "CCCCCCCC-0000-4000-8000-000000000001",
            id: "c".repeat(64),
            type: "HKWorkoutTypeIdentifier",
            group: "workouts",
            source: WATCH,
            start: new Date(2026, 8, 19, 8).toISOString(),
            end: new Date(2026, 8, 19, 9, 19).toISOString(),
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
    const res = await get("/");
    assert.match(res.html, /readout-label">Workouts</);
    assert.match(res.html, /Exercise minutes are not being exported/);
    assert.match(res.html, /Walking/, "the workout list title-cases Apple's lowerCamelCase name");
    assert.match(res.html, /5\.9 km/);
  });
});

describe("the double count, said out loud", () => {
  it("prints the resolved number and names the source that lost", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.match(res.html, /9 245/, "the day is one device's total");
    assert.ok(!res.html.includes("15 825"), "the sum of two devices is never shown");
    assert.match(res.html, /iPhone also recorded 6 580 steps today; showing the higher source rather than the sum/);
    assert.match(res.html, /class="chip" title="com\.example\.watch">Watch &middot; \+1</);
  });

  it("says nothing about sources at all when there is only one", async () => {
    await h.post(
      envelope({ samples: [sample({ type: STEP_TYPE, source: WATCH, value: 1200, unit: "count", start: new Date(2026, 8, 19, 9).toISOString() })] }),
    );
    const res = await get("/");
    assert.ok(!res.html.includes("also recorded"), "no disclosure when there is nothing to disclose");
    assert.ok(!res.html.includes("&middot; +1"));
  });
});

describe("the states a page must have", () => {
  it("offers setup instructions instead of a grid of zeroes when the store is empty", async () => {
    const res = await get("/");
    assert.match(res.html, /No data yet/);
    assert.match(res.html, /4781\/ingest/);
    assert.ok(!res.html.includes("ring-arc"), "an empty store draws no rings at all");
    assert.ok(!res.html.includes("NaN"));
    assert.ok(!res.html.includes("undefined"));
    assert.ok(!res.html.includes("Infinity"));
  });

  it("lists what healthd is not exporting, as configuration rather than failure", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.match(res.html, /Not exported: .*Stand time/);
    assert.match(res.html, /metric groups that are switched off, not failures/);
  });

  it("hatches today's bar, because the day is not over", async () => {
    await seedTwoSources();
    const res = await get("/");
    assert.match(res.html, /class="bar bar-steps bar-partial"/);
    assert.match(res.html, /class="bar-hatch"/);
    assert.match(res.html, /pattern id="hatch"/);
  });

  it("escapes a hostile source id instead of rendering it", async () => {
    await h.post(
      envelope({
        samples: [
          sample({
            type: STEP_TYPE,
            source: "com.evil.<script>alert(1)</script>",
            value: 10,
            unit: "count",
            start: new Date(2026, 8, 19, 9).toISOString(),
          }),
        ],
      }),
    );
    const res = await get("/");
    assert.ok(!res.html.includes("<script>alert(1)</script>"));
    assert.match(res.html, /&lt;script&gt;/);
  });
});

describe("the refresh flag", () => {
  it("adds the meta refresh only when it is switched on", () => {
    assert.match(renderFitness(model({ autoRefreshSeconds: 300 })), /<meta http-equiv="refresh" content="300">/);
    assert.ok(!renderFitness(model({ autoRefreshSeconds: 0 })).includes("http-equiv"));
  });
});

describe("the pill is a link to the page that owns the truth about the pipe", () => {
  it("points at /pipe and quotes the strip's own reason", async () => {
    await h.post(envelope({ samples: [sample({ type: STAND_TYPE, value: 1, unit: "min" })] }));
    const res = await get("/");
    assert.match(res.html, /<a class="pill pill-\w+" href="\/pipe"/);
    assert.match(res.html, /Delivery &amp; diagnostics/);
  });
});

describe("the honesty contract, state by state", () => {
  it("marks a card amber on the SAME staleness rule the ops page uses", async () => {
    // steps stop six hours before the heart rate does: on their own observed
    // cadence that is a stopped feed, and TypeFreshness already says so. The
    // card borrows that verdict rather than inventing a second one.
    const samples: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      samples.push(
        sample({
          type: "HKQuantityTypeIdentifierHeartRate",
          source: WATCH,
          value: 61,
          start: new Date(NOW.getTime() - i * 10 * 60_000).toISOString(),
        }),
      );
      samples.push(
        sample({
          type: STEP_TYPE,
          source: WATCH,
          value: 120,
          unit: "count",
          start: new Date(NOW.getTime() - (360 + i * 10) * 60_000).toISOString(),
        }),
      );
    }
    await h.post(envelope({ samples }));
    const m = model();
    assert.equal(m.cards.find((c) => c.key === "steps")?.state, "amber");
    const res = await get("/");
    assert.match(res.html, /dot dot-steps dot-amber/);
    assert.match(res.html, /last reading \d+ \w+/);
  });

  it("honours prefers-reduced-motion and fetches no font", () => {
    assert.match(FITNESS_CSS, /@media \(prefers-reduced-motion: no-preference\)/);
    assert.match(FITNESS_CSS, /@media \(prefers-color-scheme: light\)/);
    assert.ok(!/@font-face/.test(FITNESS_CSS), "system stack only");
    // The animation has to end on the element's own attribute value: a
    // keyframe with a `to` would overwrite the ring's actual progress.
    assert.match(FITNESS_CSS, /@keyframes fill-92 \{ from \{ stroke-dashoffset: 578\.05; \} \}/);
  });
});
