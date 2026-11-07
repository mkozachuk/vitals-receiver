import { z } from "zod";

/**
 * The wire contract is docs/payload.md (vendored from healthd), schemaVersion 1.
 *
 * Two rules from that document shape every schema here:
 *   1. Unknown keys must be tolerated (the policy inside v1 is additive-only),
 *      so every object is loose.
 *   2. `kind` is the discriminator. Never infer a sample's shape from which
 *      keys happen to be present.
 */

export const SCHEMA_VERSION = 1;

const timestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "not a parsable ISO-8601 timestamp" });

const sampleBase = {
  uuid: z.string().min(1),
  id: z.string().min(1),
  type: z.string().min(1),
  group: z.string().min(1),
  source: z.string().min(1),
  start: timestamp,
  end: timestamp,
};

export const quantitySampleSchema = z.looseObject({
  ...sampleBase,
  kind: z.literal("quantity"),
  value: z.number(),
  unit: z.string().min(1),
});

export const categorySampleSchema = z.looseObject({
  ...sampleBase,
  kind: z.literal("category"),
  value: z.number().int(),
  name: z.string().optional(),
});

export const workoutSampleSchema = z.looseObject({
  ...sampleBase,
  kind: z.literal("workout"),
  activityType: z.number().int(),
  activityName: z.string().optional(),
  durationSeconds: z.number(),
  distanceMeters: z.number().optional(),
  activeEnergyKilocalories: z.number().optional(),
});

export const sampleSchema = z.discriminatedUnion("kind", [
  quantitySampleSchema,
  categorySampleSchema,
  workoutSampleSchema,
]);

/**
 * `samples` is deliberately `unknown[]` here. Samples are validated one at a
 * time downstream so that a single malformed sample quarantines itself rather
 * than binning the 999 good ones beside it.
 */
export const envelopeSchema = z.looseObject({
  schemaVersion: z.number().int(),
  connectivityTest: z.boolean(),
  exportId: z.string().min(1),
  generatedAt: timestamp,
  batchSequence: z.number().int().min(1),
  isFinalBatch: z.boolean(),
  windowStart: timestamp,
  windowEnd: timestamp,
  /**
   * The occasion -- one export run -- and which mechanism produced the batch.
   * healthd added these three inside schemaVersion 1, under the additive-only
   * policy payload.md states for v1.
   *
   * ALL THREE ARE OPTIONAL, and that is a statement about the sender, not
   * laziness: payload.md says a body from a build older than the change
   * carries no `basis` at all and is to be read as `basis: "window"`. A
   * required field here would reject every older phone.
   *
   * `basis` is a plain string rather than `z.enum(["window", "anchor"])` on
   * purpose. An enum would bin an entire batch of real health samples the day
   * healthd names a third mechanism -- discarding data to punish a metadata
   * value we do not even read. That is the same rule the loose objects above
   * already follow, and the same one the drift check states: never throw away
   * samples over envelope metadata.
   *
   * What reads them today: nothing. See the note on `runs` in src/db.ts.
   */
  basis: z.string().min(1).optional(),
  occasionStart: timestamp.optional(),
  occasionEnd: timestamp.optional(),
  samples: z.array(z.unknown()),
});

export type Envelope = z.infer<typeof envelopeSchema>;
export type Sample = z.infer<typeof sampleSchema>;

/** Store instants in UTC; the wire offset is the phone's, not the sample's. */
export function toUtcIso(value: string): string {
  return new Date(value).toISOString();
}

/**
 * healthd sends uppercase UUIDs. Normalise on the way in and never anywhere
 * else: a lowercased key compared against a stored uppercase one is how
 * deduplication silently stops deduplicating.
 */
export function normaliseUuid(value: string): string {
  return value.toUpperCase();
}

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
