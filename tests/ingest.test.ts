import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  count,
  envelope,
  fixtureBytes,
  harness,
  one,
  quantitySample,
  rows,
  TOKEN,
  WRONG_TOKEN,
  type Harness,
} from "./helpers.js";

/**
 * Everything here exercises the real ingest server against a real (in-memory)
 * SQLite store. The contract under test is docs/payload.md plus the
 * one rule the design hangs on: healthd never reads our body, and every
 * 4xx we send (401, 404, bare 413) is permanent for healthd -- never
 * retried, so permanent data loss for that batch. Only no answer and 5xx are
 * retried from its outbox, for up to 7 days
 * (healthd/Export/RetryDisposition.swift:80-120, PendingWork.swift:31).
 */

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await h.close();
});

const EXPORT = "11111111-2222-4333-8444-555555555555";

describe("the connectivity probe (golden bytes)", () => {
  it("is answered 200 and records a delivery but no health data", async () => {
    const res = await h.post(fixtureBytes("probe.json"));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, probe: true });

    assert.equal(count(h.db, "samples"), 0);
    assert.equal(count(h.db, "runs"), 0);
    assert.equal(count(h.db, "batches"), 0);
    assert.equal(count(h.db, "quarantine"), 0);

    const delivery = one<{ outcome: string; status: number; export_id: string; sample_count: number }>(
      h.db,
      "SELECT * FROM deliveries",
    );
    assert.equal(delivery.outcome, "probe");
    assert.equal(delivery.status, 200);
    assert.equal(delivery.export_id, "00000000-0000-0000-0000-000000000000");
    assert.equal(delivery.sample_count, 0);
  });

  it("moves lastDeliveryAt but not lastExportAt: the pipe is alive, no data arrived", async () => {
    await h.post(fixtureBytes("probe.json"));
    const health = h.store.health();
    assert.ok(health.lastDeliveryAt, "a probe proves the pipe is alive");
    assert.equal(health.lastExportAt, null, "a probe is not an export");
    assert.equal(health.samplesTotal, 0);
    assert.equal(health.lastCompleteRunAt, null);
  });

  it("carrying samples is treated as an export: we never bin samples over a flag", async () => {
    const body = envelope({
      connectivityTest: true,
      isFinalBatch: true,
      samples: [quantitySample()],
    });
    const res = await h.post(body);
    assert.equal(res.statusCode, 200);
    assert.equal(count(h.db, "samples"), 1);
    assert.equal(one<{ outcome: string }>(h.db, "SELECT * FROM deliveries").outcome, "export");
  });
});

describe("the worked example (golden bytes)", () => {
  beforeEach(async () => {
    const res = await h.post(fixtureBytes("worked-example.json"));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, stored: 3, duplicates: 0, quarantined: 0 });
  });

  it("stores all three samples, keyed on uuid", () => {
    assert.equal(count(h.db, "samples"), 3);
    const uuids = rows<{ uuid: string }>(h.db, "SELECT uuid FROM samples ORDER BY uuid").map((r) => r.uuid);
    assert.deepEqual(uuids, [
      "A1B2C3D4-0000-4000-8000-000000000001",
      "A1B2C3D4-0000-4000-8000-000000000002",
      "A1B2C3D4-0000-4000-8000-000000000003",
    ]);
  });

  it("decodes the quantity sample into value+unit and nothing else", () => {
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples WHERE kind = 'quantity'");
    assert.equal(row.type, "HKQuantityTypeIdentifierStepCount");
    assert.equal(row.sample_group, "activity");
    assert.equal(row.value, 42);
    assert.equal(row.unit, "count");
    assert.equal(row.category_value, null);
    assert.equal(row.activity_type, null);
    assert.equal(row.content_id, "3cae82ce29b729ba872bdd31f1db79f0a31013c3546710bd4fe1adb8192ec011");
  });

  it("decodes the category sample: the enum goes in category_value, never in value", () => {
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples WHERE kind = 'category'");
    assert.equal(row.category_value, 4, "asleepDeep raw value");
    assert.equal(row.category_name, "asleepDeep");
    assert.equal(row.value, null, "a category enum is not a measurement");
    assert.equal(row.unit, null);
  });

  it("decodes the workout sample: units live in the key names", () => {
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples WHERE kind = 'workout'");
    assert.equal(row.activity_type, 37);
    assert.equal(row.activity_name, "running");
    assert.equal(row.duration_seconds, 1800);
    assert.equal(row.distance_meters, 5000);
    assert.equal(row.active_energy_kcal, 320);
    assert.equal(row.value, null, "a workout has no value key");
    assert.equal(row.unit, null, "a workout has no unit key");
  });

  it("stores instants in UTC, not the phone's offset", () => {
    const row = one<{ start_at: string; end_at: string }>(
      h.db,
      "SELECT * FROM samples WHERE uuid = 'A1B2C3D4-0000-4000-8000-000000000001'",
    );
    assert.equal(row.start_at, "2026-08-21T08:25:30.000Z", "+02:00 10:25:30 is 08:25:30Z");
    assert.equal(row.end_at, "2026-08-21T08:25:30.000Z");
  });

  it("keeps the whole sample object verbatim, because keys will be added inside v1", () => {
    const row = one<{ raw: string }>(h.db, "SELECT raw FROM samples WHERE kind = 'workout'");
    const raw = JSON.parse(row.raw) as Record<string, unknown>;
    assert.equal(raw.activityName, "running");
    assert.equal(raw.start, "2026-08-21T07:00:00.000+02:00", "the wire offset survives in raw");
    assert.ok(!("value" in raw));
  });

  it("records the run as complete: 1..1 ending in isFinalBatch", () => {
    const run = one<Record<string, number | string>>(h.db, "SELECT * FROM runs");
    assert.equal(run.export_id, "6C7F1E22-1B3D-4A5E-9F00-2C1D4E5A6B70");
    assert.equal(run.batches_seen, 1);
    assert.equal(run.max_sequence, 1);
    assert.equal(run.final_seen, 1);
    assert.equal(run.sample_count, 3);
    assert.equal(run.stored_count, 3);
    assert.equal(run.window_start, "2026-08-20T10:00:00.000Z");
    assert.equal(run.window_end, "2026-08-21T10:00:00.000Z");

    const health = h.store.health();
    assert.ok(health.lastCompleteRunAt, "a complete run is visible as complete");
    assert.equal(health.truncatedRuns, 0);
    assert.equal(health.samplesDropped, 0);
    assert.equal(health.samples24h, 3);
  });
});

describe("batching and reassembly", () => {
  const sampleFor = (n: number) =>
    quantitySample({
      uuid: `BBBBBBBB-0000-4000-8000-00000000000${n}`,
      id: `${n}`.repeat(64),
      start: `2026-09-19T0${n}:00:00.000+02:00`,
    });

  it("keeps a run that never sent its final batch, and calls it truncated (not invalid)", async () => {
    // A three-batch run whose third batch -- the one carrying isFinalBatch --
    // has not arrived: receiver down and healthd's outbox retries not yet
    // landed or exhausted after 7 days, or dropped on a permanent status.
    for (const seq of [1, 2]) {
      const res = await h.post(envelope({ batchSequence: seq, samples: [sampleFor(seq)] }));
      assert.equal(res.statusCode, 200);
    }

    assert.equal(count(h.db, "samples"), 2, "the batches we did receive are complete and valid");
    const run = one<Record<string, number>>(h.db, "SELECT * FROM runs");
    assert.equal(run.batches_seen, 2);
    assert.equal(run.max_sequence, 2);
    assert.equal(run.final_seen, 0);
    assert.equal(run.sample_count, 2);

    const fresh = h.store.health();
    assert.equal(fresh.truncatedRuns, 0, "a run still in flight is not truncated yet");
    assert.equal(fresh.lastCompleteRunAt, null);

    const later = h.store.health(new Date(Date.now() + 61 * 60_000));
    assert.equal(later.truncatedRuns, 1, "silent for longer than the cutoff: truncated");
    assert.equal(later.truncatedRuns7d, 1, "and recent enough for the tile to go amber");
    assert.equal(count(h.db, "samples"), 2, "still never deleted");

    // Eight days on, the tile is green again and the all-time count still
    // remembers. A number that can never return to zero stops being read.
    const muchLater = h.store.health(new Date(Date.now() + 8 * 24 * 3600_000));
    assert.equal(muchLater.truncatedRuns, 1, "all-time never forgets");
    assert.equal(muchLater.truncatedRuns7d, 0, "the tile's window has moved past it");
  });

  it("a hole in the sequence is not complete even when the final batch arrives", async () => {
    await h.post(envelope({ batchSequence: 1, samples: [sampleFor(1)] }));
    await h.post(envelope({ batchSequence: 3, isFinalBatch: true, samples: [sampleFor(3)] }));

    const run = one<Record<string, number>>(h.db, "SELECT * FROM runs");
    assert.equal(run.batches_seen, 2);
    assert.equal(run.max_sequence, 3);
    assert.equal(run.final_seen, 1);
    assert.equal(
      h.store.health().lastCompleteRunAt,
      null,
      "complete means a contiguous 1..N, not merely a final flag",
    );
    assert.equal(h.store.health(new Date(Date.now() + 61 * 60_000)).truncatedRuns, 1);
  });

  it("a contiguous 1..3 ending in the final batch is complete", async () => {
    await h.post(envelope({ batchSequence: 1, samples: [sampleFor(1)] }));
    await h.post(envelope({ batchSequence: 2, samples: [sampleFor(2)] }));
    await h.post(envelope({ batchSequence: 3, isFinalBatch: true, samples: [sampleFor(3)] }));

    const run = one<Record<string, number>>(h.db, "SELECT * FROM runs");
    assert.equal(run.batches_seen, 3);
    assert.equal(run.max_sequence, 3);
    assert.equal(run.final_seen, 1);
    assert.equal(run.sample_count, 3);
    assert.ok(h.store.health().lastCompleteRunAt);
    assert.equal(h.store.health(new Date(Date.now() + 61 * 60_000)).truncatedRuns, 0);
  });

  it("a re-delivered batch does not inflate the run's counts", async () => {
    const body = envelope({ batchSequence: 1, samples: [sampleFor(1), sampleFor(2)] });
    await h.post(body);
    await h.post(body);

    assert.equal(count(h.db, "batches"), 1, "same (exportId, sequence) is one batch");
    assert.equal(count(h.db, "samples"), 2);
    const run = one<Record<string, number>>(h.db, "SELECT * FROM runs");
    assert.equal(run.batches_seen, 1);
    assert.equal(run.sample_count, 2, "recomputed from batches, not accumulated");
    assert.equal(count(h.db, "deliveries"), 2, "both requests are still in the delivery log");
  });
});

describe("identity: uuid is the key, id is not", () => {
  it("re-delivering a uuid is a duplicate, first stored wins", async () => {
    await h.post(
      envelope({
        exportId: EXPORT,
        batchSequence: 1,
        isFinalBatch: true,
        samples: [quantitySample({ value: 61 })],
      }),
    );
    // A second export over an overlapping window re-sends the overlap. That is
    // normal and must be free, not an error.
    await h.post(
      envelope({
        exportId: "99999999-8888-4777-8666-555555555555",
        batchSequence: 1,
        isFinalBatch: true,
        samples: [quantitySample({ value: 62 })],
      }),
    );

    assert.equal(count(h.db, "samples"), 1, "one sample, not two");
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples");
    assert.equal(row.value, 61, "first stored wins: a duplicate must not rewrite provenance");
    assert.equal(row.export_id, EXPORT);
    assert.equal(count(h.db, "runs"), 2, "two runs, though, both recorded");
    assert.equal(h.store.health().samplesTotal, 1);
    assert.equal(h.store.health().samplesDuplicate, 1);
  });

  it("dedupes across uuid letter case, which is how dedupe silently stops working", async () => {
    const upper = quantitySample({ uuid: "CCCCCCCC-0000-4000-8000-000000000001", value: 70 });
    const lower = quantitySample({ uuid: "cccccccc-0000-4000-8000-000000000001", value: 71 });
    await h.post(envelope({ batchSequence: 1, samples: [upper] }));
    await h.post(envelope({ batchSequence: 2, samples: [lower] }));

    assert.equal(count(h.db, "samples"), 1, "the same uuid in a different case is the same sample");
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples");
    assert.equal(row.uuid, "CCCCCCCC-0000-4000-8000-000000000001", "stored uppercase, as healthd sends");
    assert.equal(row.value, 70);
  });

  it("two non-heart-rate samples sharing one id are two samples: id collides by design", async () => {
    // Measured on a real device: 720 samples carried 195 distinct ids, because
    // one writer stamps every reading with its containing hour. Only HeartRate
    // is deduped on content_id, where healthd re-mints uuid for identical content.
    const shared = "f".repeat(64);
    const samples = [
      quantitySample({ uuid: "DDDDDDDD-0000-4000-8000-000000000001", id: shared, type: "HKQuantityTypeIdentifierStepCount", value: 80, unit: "count" }),
      quantitySample({ uuid: "DDDDDDDD-0000-4000-8000-000000000002", id: shared, type: "HKQuantityTypeIdentifierStepCount", value: 80, unit: "count" }),
    ];
    const res = await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, stored: 2, duplicates: 0, quarantined: 0 });
    assert.equal(count(h.db, "samples"), 2, "both kept");
    assert.equal(
      rows(h.db, "SELECT * FROM samples WHERE content_id = @id", { id: shared }).length,
      2,
      "non-heart-rate content_id is indexed but NOT unique",
    );
  });

  it("collapses duplicate HeartRate samples by content_id", async () => {
    const samples = Array.from({ length: 12 }, (_, i) =>
      quantitySample({
        uuid: `EEEEEEEE-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        id: String(i % 3).repeat(64),
        value: 60 + i,
      }),
    );
    await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples }));
    assert.equal(count(h.db, "samples"), 3);
    assert.equal(
      rows(h.db, "SELECT DISTINCT content_id FROM samples").length,
      3,
      "three fingerprints, three stored records",
    );
    assert.equal(h.store.health().samplesDuplicate, 9);
    const delivery = one<Record<string, unknown>>(h.db, "SELECT * FROM deliveries");
    assert.equal(delivery.sample_count, 12);
    assert.equal(delivery.stored_count, 3);
    assert.equal(delivery.duplicate_count, 9);
  });
});

describe("the credential is the only data-free refusal", () => {
  it("answers 401 with no credential header and logs the attempt", async () => {
    const res = await h.post(envelope({ samples: [quantitySample()] }), { token: null });
    assert.equal(res.statusCode, 401);
    assert.equal(count(h.db, "samples"), 0);
    const delivery = one<Record<string, unknown>>(h.db, "SELECT * FROM deliveries");
    assert.equal(delivery.outcome, "unauthorised");
    assert.equal(delivery.status, 401);
    assert.equal(delivery.note, "no credential header");
  });

  it("answers 401 on a mismatch and distinguishes it in the log", async () => {
    const res = await h.post(envelope(), { token: WRONG_TOKEN });
    assert.equal(res.statusCode, 401);
    assert.equal(one<Record<string, unknown>>(h.db, "SELECT * FROM deliveries").note, "credential mismatch");
  });

  it("counts unauthorised attempts in the last 24h, which is a dashboard number", async () => {
    await h.post(envelope(), { token: null });
    await h.post(envelope(), { token: WRONG_TOKEN });
    await h.post(fixtureBytes("probe.json"), { token: TOKEN });
    const health = h.store.health();
    assert.equal(health.unauthorised24h, 2);
    assert.ok(health.lastDeliveryAt, "the good probe still counts as a delivery");
  });

  it("never writes the credential into the store", async () => {
    await h.post("not json at all", { token: TOKEN });
    const q = one<{ headers: string; body: string }>(h.db, "SELECT * FROM quarantine");
    assert.ok(!q.headers.includes(TOKEN), "the credential header is redacted before it is stored");
    assert.equal((JSON.parse(q.headers) as Record<string, string>)["x-vitals-token"], "[redacted]");
  });
});

describe("quarantine: bytes we cannot use are still health data", () => {
  it("answers 200 and keeps unparseable bytes verbatim", async () => {
    const body = '{"schemaVersion":1,"samples":[';
    const res = await h.post(body);
    assert.equal(res.statusCode, 200, "a 400 here would destroy the batch forever");
    assert.deepEqual(res.json, { ok: true, stored: 0, quarantined: 1 });

    const q = one<Record<string, unknown>>(h.db, "SELECT * FROM quarantine");
    assert.equal(q.reason, "unparseable-json");
    assert.equal(q.body, body, "verbatim");
    assert.equal(q.bytes, Buffer.byteLength(body, "utf8"));

    const delivery = one<Record<string, unknown>>(h.db, "SELECT * FROM deliveries");
    assert.equal(delivery.outcome, "quarantined");
    assert.equal(delivery.status, 200);
    assert.equal(q.delivery_id, delivery.id, "the quarantine row points at its delivery");
  });

  it("quarantines a schemaVersion we do not know instead of rejecting it", async () => {
    const res = await h.post(envelope({ schemaVersion: 2, samples: [quantitySample()] }));
    assert.equal(res.statusCode, 200);
    assert.equal(count(h.db, "samples"), 0, "we do not guess at a contract we have not read");
    const q = one<Record<string, unknown>>(h.db, "SELECT * FROM quarantine");
    assert.equal(q.reason, "unknown-schema-version");
    assert.equal(q.detail, "schemaVersion=2");
    assert.equal(h.store.health().quarantined24h, 1);
  });

  it("quarantines a body that is JSON but not an envelope", async () => {
    const res = await h.post('{"schemaVersion":1,"hello":"world"}');
    assert.equal(res.statusCode, 200);
    const q = one<Record<string, unknown>>(h.db, "SELECT * FROM quarantine");
    assert.equal(q.reason, "bad-envelope");
    assert.ok(String(q.detail).includes("samples"), `detail should name the missing keys: ${String(q.detail)}`);
  });

  it("one malformed sample does not cost the good ones beside it", async () => {
    const good = quantitySample({ uuid: "ABABABAB-0000-4000-8000-000000000001" });
    const alsoGood = quantitySample({ uuid: "ABABABAB-0000-4000-8000-000000000002", id: "b".repeat(64) });
    const broken = { ...quantitySample({ uuid: "ABABABAB-0000-4000-8000-000000000003" }), unit: 42 };

    const res = await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples: [good, broken, alsoGood] }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true, stored: 2, duplicates: 0, quarantined: 1 });
    assert.equal(count(h.db, "samples"), 2);

    const q = one<Record<string, unknown>>(h.db, "SELECT * FROM quarantine");
    assert.equal(q.reason, "bad-sample");
    assert.ok(String(q.detail).startsWith("[1] "), "the rejected sample's index is recorded");
    const parked = JSON.parse(String(q.body)) as { uuid: string }[];
    assert.equal(parked.length, 1);
    assert.equal(parked[0]?.uuid, "ABABABAB-0000-4000-8000-000000000003");

    const batch = one<Record<string, number>>(h.db, "SELECT * FROM batches");
    assert.equal(batch.sample_count, 3, "claimed");
    assert.equal(batch.stored_count, 2, "kept");
    assert.equal(h.store.health().samplesDropped, 1, "the gap is a number the dashboard can show");
  });
});

describe("tolerating a contract that only ever grows", () => {
  it("ignores unknown keys on the envelope and on a sample", async () => {
    const sample = { ...quantitySample(), sourceDeviceName: "Apple Watch", newKeyFromTheFuture: { a: 1 } };
    const body = JSON.parse(envelope({ batchSequence: 1, isFinalBatch: true, samples: [sample] })) as Record<
      string,
      unknown
    >;
    body.exportRevision = 7;
    const res = await h.post(JSON.stringify(body));

    assert.equal(res.statusCode, 200);
    assert.equal(count(h.db, "samples"), 1);
    const raw = JSON.parse(one<{ raw: string }>(h.db, "SELECT raw FROM samples").raw) as Record<string, unknown>;
    assert.equal(raw.sourceDeviceName, "Apple Watch", "an added key is kept, not dropped");
  });

  it("records the occasion healthd publishes beside the window", async () => {
    await h.post(
      envelope({
        exportId: EXPORT,
        basis: "anchor",
        occasionStart: "2026-09-18T12:00:00.000+02:00",
        occasionEnd: "2026-09-19T12:00:00.000+02:00",
        samples: [quantitySample()],
      }),
    );
    const run = one<{ basis: string | null; occasion_start: string | null; occasion_end: string | null }>(
      h.db,
      "SELECT basis, occasion_start, occasion_end FROM runs WHERE export_id = @id",
      { id: EXPORT },
    );
    assert.equal(run.basis, "anchor");
    // Normalised to UTC like every other instant here: the wire offset is the
    // phone's, not the occasion's.
    assert.equal(run.occasion_start, "2026-09-18T10:00:00.000Z");
    assert.equal(run.occasion_end, "2026-09-19T10:00:00.000Z");
  });

  it("stores NULL, not a guess, when the sender is older than the occasion", async () => {
    // The nine-key body: exactly what a healthd built before these keys sends.
    await h.post(envelope({ exportId: EXPORT, samples: [quantitySample()] }));
    const run = one<{ basis: string | null; occasion_start: string | null; occasion_end: string | null }>(
      h.db,
      "SELECT basis, occasion_start, occasion_end FROM runs WHERE export_id = @id",
      { id: EXPORT },
    );
    assert.equal(run.basis, null, "an absent field is absent, not defaulted to 'window'");
    assert.equal(run.occasion_start, null);
    assert.equal(run.occasion_end, null);
    assert.equal(count(h.db, "samples"), 1, "and the samples still land");
  });

  it("keeps a batch whose basis names a mechanism this build has never heard of", async () => {
    // The whole reason `basis` is a string and not an enum. Rejecting the
    // value would bin real health samples over one metadata word we do not
    // even read yet -- the same trade the quarantine rule already refuses.
    const res = await h.post(envelope({ exportId: EXPORT, basis: "teleport", samples: [quantitySample()] }));
    assert.equal(res.statusCode, 200);
    assert.equal(count(h.db, "samples"), 1);
    assert.equal(
      one<{ basis: string | null }>(h.db, "SELECT basis FROM runs WHERE export_id = @id", { id: EXPORT }).basis,
      "teleport",
      "stored verbatim: we are a receiver, not a censor",
    );
  });

  it("accepts a category sample this build has no name for", async () => {
    const sample = {
      uuid: "FAFAFAFA-0000-4000-8000-000000000001",
      id: "c".repeat(64),
      type: "HKCategoryTypeIdentifierSleepAnalysis",
      group: "sleep",
      source: "com.apple.Health",
      start: "2026-09-19T00:10:00.000+02:00",
      end: "2026-09-19T00:55:00.000+02:00",
      kind: "category",
      value: 99,
    };
    const res = await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples: [sample] }));
    assert.equal(res.statusCode, 200);
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples");
    assert.equal(row.category_value, 99);
    assert.equal(row.category_name, null, "absent, never null -- and absent stays absent");
  });

  it("accepts a workout with neither distance nor energy", async () => {
    const sample = {
      uuid: "FBFBFBFB-0000-4000-8000-000000000001",
      id: "d".repeat(64),
      type: "HKWorkoutTypeIdentifier",
      group: "workouts",
      source: "com.apple.Health",
      start: "2026-09-19T07:00:00.000+02:00",
      end: "2026-09-19T07:30:00.000+02:00",
      kind: "workout",
      activityType: 14,
      durationSeconds: 1800,
    };
    const res = await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples: [sample] }));
    assert.equal(res.statusCode, 200);
    const row = one<Record<string, unknown>>(h.db, "SELECT * FROM samples");
    assert.equal(row.activity_type, 14);
    assert.equal(row.activity_name, null, "14 is a deprecated activity with no name");
    assert.equal(row.distance_meters, null);
    assert.equal(row.active_energy_kcal, null);
    assert.equal(row.duration_seconds, 1800);
  });

  it("accepts a fractional quantity: switch on kind, never on what the number looks like", async () => {
    const samples = [
      quantitySample({ uuid: "FCFCFCFC-0000-4000-8000-000000000001", value: 0.98, unit: "fraction" }),
      quantitySample({ uuid: "FCFCFCFC-0000-4000-8000-000000000002", id: "e".repeat(64), value: 42, unit: "count" }),
    ];
    await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples }));
    const values = rows<{ value: number }>(h.db, "SELECT value FROM samples ORDER BY value").map((r) => r.value);
    assert.deepEqual(values, [0.98, 42]);
  });
});

describe("the ingest listener's edges", () => {
  it("takes an export posted to the wrong path rather than losing it", async () => {
    const res = await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples: [quantitySample()] }), {
      url: "/health",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(count(h.db, "samples"), 1, "a typo in the endpoint must not cost an export");
    const delivery = one<Record<string, unknown>>(h.db, "SELECT * FROM deliveries");
    assert.equal(delivery.path, "/health");
    assert.equal(delivery.note, "non-canonical path /health");
  });

  it("takes a body whose Content-Type lies", async () => {
    const res = await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples: [quantitySample()] }), {
      headers: { "content-type": "text/plain" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(count(h.db, "samples"), 1);
  });

  it("answers 413 above the body cap and records it as a configuration error", async () => {
    const small = harness({ VITALS_MAX_BODY_BYTES: "200" });
    try {
      const big = envelope({
        batchSequence: 1,
        samples: Array.from({ length: 5 }, (_, i) =>
          quantitySample({ uuid: `FDFDFDFD-0000-4000-8000-00000000000${i}` }),
        ),
      });
      assert.ok(Buffer.byteLength(big) > 200);
      const res = await small.post(big);
      assert.equal(res.statusCode, 413);
      assert.equal(count(small.db, "samples"), 0);
      assert.equal(one<Record<string, unknown>>(small.db, "SELECT * FROM deliveries").outcome, "oversize");
    } finally {
      await small.close();
    }
  });

  it("answers 404 to a GET and still logs that something knocked", async () => {
    const res = await h.ingest.inject({ method: "GET", url: "/ingest" });
    assert.equal(res.statusCode, 404);
    const delivery = one<Record<string, unknown>>(h.db, "SELECT * FROM deliveries");
    assert.equal(delivery.outcome, "unroutable");
    assert.equal(delivery.method, "GET");
  });

  it("logs one line per delivery, and never the credential", async () => {
    await h.post(fixtureBytes("probe.json"));
    await h.post(envelope({ batchSequence: 1, isFinalBatch: true, samples: [quantitySample()] }));
    await h.post(envelope(), { token: WRONG_TOKEN });
    assert.equal(h.logLines.length, 3);
    assert.ok(h.logLines[0]?.includes("200 probe"));
    assert.ok(h.logLines[1]?.includes("200 export"));
    assert.ok(h.logLines[2]?.includes("401 unauthorised"));
    assert.ok(!h.logLines.join("\n").includes(TOKEN));
    assert.ok(!h.logLines.join("\n").includes(WRONG_TOKEN));
  });
});

describe("the read listener", () => {
  it("serves /healthz with every field the Synapse tile needs", async () => {
    await h.post(fixtureBytes("worked-example.json"));
    const res = await h.read.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    for (const key of [
      "ok",
      "startedAt",
      "uptimeSeconds",
      "dbWritable",
      "lastDeliveryAt",
      "lastCompleteRunAt",
      "truncatedRuns",
      "samples24h",
      "unauthorised24h",
      "dbBytes",
    ]) {
      assert.ok(key in body, `/healthz is missing ${key}`);
    }
    assert.equal(body.ok, true);
    assert.equal(body.dbWritable, true);
    assert.equal(body.samples24h, 3);
  });

  it("accepts no credential and offers no way to write", async () => {
    // Slice 3 turned this from "no such route" into "no such method": the
    // read listener refuses anything but GET/HEAD before routing, so a new
    // route can never accidentally become writable.
    const post = await h.read.inject({ method: "POST", url: "/ingest", payload: fixtureBytes("worked-example.json") });
    assert.equal(post.statusCode, 405, "the read listener refuses every write method");
    assert.equal(post.headers.allow, "GET, HEAD");
    assert.equal(count(h.db, "samples"), 0);
  });
});

describe("the run's identity and extent (anchor runs)", () => {
  /**
   * Slice 6. On basis "anchor" every batch carries its own bracket, so the
   * window differs between batches of one run by contract; generatedAt and
   * the occasion are what stay put. The drift check keys on the latter, and
   * the run row's window is the run's extent rather than batch 1's bracket.
   * Every instant below is synthetic.
   */
  const RUN = "66666666-5555-4444-8333-222222222222";
  const GENERATED = "2026-09-30T09:00:00.000+02:00";
  const OCCASION = {
    basis: "anchor",
    occasionStart: "2026-09-29T08:00:00.000+02:00",
    occasionEnd: GENERATED,
  };
  // Batch 2 starts EARLIER than batch 1: a later batch may carry earlier
  // dates, which is why first-batch-wins was never the run's window.
  const BRACKETS: Record<number, [string, string]> = {
    1: ["2026-09-29T09:00:00.000+02:00", "2026-09-29T21:00:00.000+02:00"],
    2: ["2026-09-28T23:00:00.000+02:00", "2026-09-29T07:00:00.000+02:00"],
    3: ["2026-09-30T00:00:00.000+02:00", "2026-09-30T08:30:00.000+02:00"],
  };
  const EXTENT = { start: "2026-09-28T21:00:00.000Z", end: "2026-09-30T06:30:00.000Z" };

  const batch = (n: number, overrides: Record<string, unknown> = {}, withOccasion = true): string => {
    const [windowStart, windowEnd] = BRACKETS[n] as [string, string];
    return envelope({
      exportId: RUN,
      generatedAt: GENERATED,
      batchSequence: n,
      isFinalBatch: n === 3,
      windowStart,
      windowEnd,
      ...(withOccasion ? OCCASION : {}),
      samples: [quantitySample({ uuid: `CCCCCCCC-0000-4000-8000-00000000000${n}`, id: String(n).repeat(64), start: windowStart })],
      ...overrides,
    });
  };
  const notes = (): (string | null)[] =>
    rows<{ note: string | null }>(h.db, "SELECT note FROM deliveries WHERE export_id = @id ORDER BY id", { id: RUN }).map(
      (d) => d.note,
    );
  const driftNotes = (): string[] => notes().filter((n): n is string => n !== null && /run metadata drift/.test(n));
  const runWindow = () =>
    one<{ window_start: string; window_end: string; batches_seen: number }>(
      h.db,
      "SELECT window_start, window_end, batches_seen FROM runs WHERE export_id = @id",
      { id: RUN },
    );

  it("raises no drift note on a run of three batches with different brackets and one occasion", async () => {
    for (const n of [1, 2, 3]) assert.equal((await h.post(batch(n))).statusCode, 200);
    assert.equal(count(h.db, "samples"), 3);
    assert.deepEqual(notes(), [null, null, null], "a bracket that moves is the contract, not drift");
  });

  it("names generatedAt, and only generatedAt, when a batch changes it", async () => {
    await h.post(batch(1));
    await h.post(batch(2, { generatedAt: "2026-09-30T10:00:00.000+02:00" }));
    await h.post(batch(3));
    const drift = driftNotes();
    assert.equal(drift.length, 1);
    assert.equal(drift[0], "run metadata drift: generatedAt 2026-09-30T07:00:00.000Z -> 2026-09-30T08:00:00.000Z");
  });

  it("names the occasion field when a batch claims a different occasion", async () => {
    await h.post(batch(1));
    await h.post(batch(2, { occasionEnd: "2026-09-30T09:30:00.000+02:00" }));
    const drift = driftNotes();
    assert.equal(drift.length, 1);
    assert.match(drift[0] ?? "", /^run metadata drift: occasionEnd 2026-09-30T07:00:00.000Z -> 2026-09-30T07:30:00.000Z$/);
    assert.doesNotMatch(drift[0] ?? "", /occasionStart|window/);
  });

  it("keeps the run's window at MIN/MAX across its batches, in delivery order", async () => {
    for (const n of [1, 2, 3]) await h.post(batch(n));
    const run = runWindow();
    assert.equal(run.window_start, EXTENT.start, "batch 2's earlier start, not batch 1's");
    assert.equal(run.window_end, EXTENT.end);
  });

  it("keeps the run's window at MIN/MAX across its batches, in reverse order", async () => {
    for (const n of [3, 2, 1]) await h.post(batch(n));
    const run = runWindow();
    assert.equal(run.window_start, EXTENT.start);
    assert.equal(run.window_end, EXTENT.end);
    assert.deepEqual(notes(), [null, null, null]);
  });

  it("moves nothing when a delivered batch is replayed", async () => {
    for (const n of [1, 2, 3]) await h.post(batch(n));
    const before = runWindow();
    await h.post(batch(2));
    await h.post(batch(1));
    assert.deepEqual(runWindow(), before);
    assert.equal(driftNotes().length, 0, "a replay agrees with itself");
  });

  it("still checks generatedAt on a body older than the occasion, and never the window", async () => {
    await h.post(batch(1, {}, false));
    await h.post(batch(2, {}, false));
    await h.post(batch(3, { generatedAt: "2026-09-30T10:00:00.000+02:00" }, false));
    const drift = driftNotes();
    assert.equal(drift.length, 1, "the moved windows of batch 2 and 3 are not drift");
    assert.match(drift[0] ?? "", /^run metadata drift: generatedAt /);
    assert.doesNotMatch(drift[0] ?? "", /window|occasion/);
    const run = runWindow();
    assert.equal(run.window_start, EXTENT.start);
    assert.equal(run.window_end, EXTENT.end);
  });
});
