import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { fixtureBytes } from "./helpers.js";

/**
 * Drift detector. The two golden fixtures are byte-for-byte copies of the
 * pinned blocks in healthd's contract document, and payload.md says both
 * blocks are checked against the app's pinned test fixture on every build.
 *
 * The document is vendored at docs/payload.md, so these checks always run --
 * on a clean clone and in CI, with nothing beside the repo. A missing copy is
 * a failure, not a skip. To check against a newer healthd checkout instead,
 * set VITALS_HEALTHD_PAYLOAD_DOC to its docs/payload.md: if healthd's document
 * moves, this test fails here rather than silently in production.
 */
const DOC =
  process.env.VITALS_HEALTHD_PAYLOAD_DOC ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "payload.md");

function pinnedJson(doc: string, tag: string): string {
  const marker = `<!-- pinned:${tag} -->`;
  const at = doc.indexOf(marker);
  assert.ok(at >= 0, `payload.md carries no ${marker}`);
  const fence = doc.indexOf("```json", at);
  assert.ok(fence > at, `no json fence after ${marker}`);
  const bodyStart = doc.indexOf("\n", fence) + 1;
  const bodyEnd = doc.indexOf("```", bodyStart);
  return doc.slice(bodyStart, bodyEnd).trim();
}

describe("golden fixtures", () => {
  // Read inside each test, so a missing document is a named failure, not a
  // suite that never registers its tests.
  const doc = (): string => fs.readFileSync(DOC, "utf8");

  it("probe.json is the pinned probe, byte for byte", () => {
    assert.equal(fixtureBytes("probe.json"), pinnedJson(doc(), "probe"));
  });

  it("worked-example.json is the pinned payload, byte for byte", () => {
    assert.equal(fixtureBytes("worked-example.json"), pinnedJson(doc(), "payload"));
  });

  it("are encoded the way healthd encodes: no BOM, unindented, no trailing newline", () => {
    for (const name of ["probe.json", "worked-example.json"]) {
      const bytes = fixtureBytes(name);
      assert.ok(!bytes.startsWith("﻿"), `${name}: BOM`);
      assert.ok(!bytes.endsWith("\n"), `${name}: trailing newline`);
      assert.ok(!bytes.includes("\n"), `${name}: indented or multi-line`);
      assert.ok(!bytes.includes(": "), `${name}: pretty-printed`);
    }
  });

  /**
   * Was "the nine-key envelope" until healthd added `basis`, `occasionStart`
   * and `occasionEnd` within schemaVersion 1 (payload.md's additive-only
   * policy). The list stays a full, literal, sorted deepEqual rather than a
   * subset or a length check: this line is the only thing in the suite that
   * would notice a key being REMOVED, and a removal is the breaking change
   * the additive policy is supposed to make impossible.
   */
  it("the probe is the twelve-key envelope, empty", () => {
    const probe = JSON.parse(fixtureBytes("probe.json")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(probe).sort(), [
      "basis",
      "batchSequence",
      "connectivityTest",
      "exportId",
      "generatedAt",
      "isFinalBatch",
      "occasionEnd",
      "occasionStart",
      "samples",
      "schemaVersion",
      "windowEnd",
      "windowStart",
    ]);
    assert.equal(probe.connectivityTest, true);
    assert.deepEqual(probe.samples, []);
    assert.equal(probe.exportId, "00000000-0000-0000-0000-000000000000");
    assert.equal(probe.generatedAt, "1970-01-01T00:00:00.000Z");
  });

  it("the worked example carries all three sample kinds", () => {
    const payload = JSON.parse(fixtureBytes("worked-example.json")) as { samples: { kind: string }[] };
    assert.deepEqual(
      payload.samples.map((s) => s.kind),
      ["quantity", "category", "workout"],
    );
  });
});
