import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildFitness, type Fitness } from "../src/fitness.js";
import { generate, parseArgs } from "../scripts/demo.js";
import { envelope, harness, type Harness } from "./helpers.js";

/**
 * Slice 4. A distributed example is judged on `npm run demo`, so the subsets
 * from the brief are a test rather than a claim: everything, one group, and
 * nothing at all must each render a page that is honest about itself.
 */

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await h.close();
});

const NOW = new Date(2026, 8, 19, 19, 0, 0);

async function seed(argv: string[]): Promise<Fitness> {
  const args = parseArgs(argv);
  const samples = generate({ ...args, days: 12 }, NOW);
  // Through the real ingest path, so the demo cannot drift from the contract.
  for (let i = 0; i < samples.length; i += 400) {
    const slice = samples.slice(i, i + 400);
    const res = await h.post(
      envelope({
        exportId: "DEM0FEED-0000-4000-8000-000000000001",
        batchSequence: i / 400 + 1,
        isFinalBatch: i + 400 >= samples.length,
        samples: slice,
      }),
    );
    assert.equal(res.statusCode, 200);
  }
  return buildFitness(h.db, { dbPath: ":memory:", truncatedAfterMinutes: 60, now: NOW });
}

describe("npm run demo", () => {
  it("lights all three rings on the default seed, with no iPhone anywhere near it", async () => {
    const m = await seed([]);
    assert.equal(m.rings.length, 3);
    assert.equal(
      m.rings.every((r) => r.present && (r.value ?? 0) > 0),
      true,
      "Move, Exercise and Stand must all have real numbers in the shipped screenshot",
    );
    assert.equal(m.rings[1]?.label, "Exercise", "the real type is present, so no fallback name");
    assert.equal(m.sources.length, 2, "two devices, so the double-count disclosure is visible");
    assert.ok(m.cards.find((c) => c.key === "steps")?.alternatives.length === 1);
    assert.equal(m.empty, false);
  });

  it("ships one group switched off on purpose, so the ghost state is in the screenshot", async () => {
    const m = await seed([]);
    assert.match(m.notExported.join(", "), /Vitals/);
  });

  it("degrades honestly when only one group is exported", async () => {
    const sleepOnly = await seed(["--groups=sleep"]);
    assert.equal(sleepOnly.cards.length, 1);
    assert.equal(sleepOnly.cards[0]?.key, "sleep");
    assert.equal(sleepOnly.rings.every((r) => !r.present), true, "no activity means three ghost rings");
    assert.match(sleepOnly.notExported.join(", "), /Activity/);

    const activityOnly = await (async () => {
      await h.close();
      h = harness();
      return seed(["--groups=activity"]);
    })();
    assert.equal(activityOnly.rings.every((r) => r.present), true);
    assert.equal(activityOnly.cards.some((c) => c.key === "sleep"), false);
  });

  it("renders the empty state, not a page of zeroes, when nothing is exported", async () => {
    const m = await seed(["--groups="]);
    assert.equal(m.empty, true);
    assert.equal(m.cards.length, 0);
  });

  it("is deterministic: the same seed is the same person", () => {
    const a = generate(parseArgs(["--seed=42", "--days=3"]), NOW);
    const b = generate(parseArgs(["--seed=42", "--days=3"]), NOW);
    assert.deepEqual(
      a.map((s) => `${s.type}:${s.start}:${"value" in s ? s.value : ""}`),
      b.map((s) => `${s.type}:${s.start}:${"value" in s ? s.value : ""}`),
    );
    const c = generate(parseArgs(["--seed=43", "--days=3"]), NOW);
    assert.notDeepEqual(
      a.map((s) => ("value" in s ? s.value : 0)),
      c.map((s) => ("value" in s ? s.value : 0)),
    );
  });
});
