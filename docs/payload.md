<!--
Vendored copy of the healthd payload contract, schemaVersion 1.

Source: docs/payload.md in the healthd iOS app (not yet public), as of healthd
commit 7d213eb. This is the contract vitals implements, and the pinned blocks
below are what tests/fixtures.test.ts checks tests/fixtures/*.json against,
byte for byte -- so the suite runs on a clean clone with nothing beside it.

Changes from the source, and nothing else: this comment, and three links to
healthd's sibling documents (csv.md, shortcuts.md) turned into plain text,
because those documents are not part of this repository. The pinned blocks are
untouched.

To check this copy against a newer healthd checkout, point the fixture test at
it: VITALS_HEALTHD_PAYLOAD_DOC=/path/to/newer/payload.md npm test
-->

# The healthd payload, version 1

This is the contract. It describes every byte healthd sends to your endpoint, and it
is written so that you can implement a receiver from this page alone — you do not
need the app's source, and you should not have to read it.

**This page describes the JSON rendering.** JSON is one of two, and a destination can
be set to CSV instead — the same samples, the same window, the same batching and the
same transport, rendered as a CSV document rather than a JSON object. That contract is
healthd's `docs/csv.md` (not vendored here). Everything below is scoped to a destination set to JSON.

**An export can also be triggered from a Shortcut**, which sends exactly these bytes on
the user's own schedule — see healthd's `docs/shortcuts.md` (not vendored here). It is worth knowing
about while you write your receiver: an automation over an overlapping window resends
samples by design, which is what [`uuid` deduplication](#identity-and-deduplication)
absorbs.

**Everything on this page is frozen.** `schemaVersion: 1` means the keys described
here keep the names, types, and meanings they have here for as long as the app emits
that version. The one thing that may change inside v1 is that **new keys may appear**
— see [Compatibility](#compatibility-what-may-change-inside-v1).

If you read nothing else, read these four:

1. **Deduplicate on `samples[].uuid`.** Upsert on it. Not on `id`, which is a content
   fingerprint that repeats by design — see [Identity](#identity-and-deduplication).
2. **Ignore keys you do not recognise.** New ones will appear; none will be removed
   or repurposed.
3. **Answer with any `2xx`.** The response body is never read, and a redirect is
   never followed.
4. **A batch is at most 1000 samples and stays under 1 MB**, so the request will not
   trip a default `client_max_body_size`. But an export can be many batches — see
   [Batching](#batching-and-reassembly).

---

## Transport

| | |
| --- | --- |
| **Method** | Whatever the user configured. `POST` is the usual choice; the app validates the token and otherwise sends it verbatim. |
| **URL** | Whatever the user configured, exactly. The app appends no path and no query. |
| **`Content-Type`** | `application/json`, always. The app sets it *after* the user's own headers, so a user cannot accidentally mislabel the body. |
| **Body** | One JSON object, UTF-8, no BOM, unindented, no trailing newline. Not compressed, not chunked, not multipart. |
| **Other headers** | Any the user configured, plus their credential in the header name they chose. The credential header is applied last and wins over a same-named header the user typed by hand. |
| **Success** | Any status in `200...299`. Everything else is a failure the user sees. |
| **Response body** | **Never read.** The app records the status code and nothing else, so no data can travel back from your receiver into the app. |
| **Redirects** | Refused, not followed. A `3xx` is a failure. |
| **Timeout** | 60 seconds on a batch's first attempt; 15 seconds on a retry, which has to fit inside a background wake's own budget. A receiver slower than that is not lost — the batch stays queued and is tried again. See [the caveat that matters](#the-caveat-that-matters). |
| **Concurrency** | One request at a time, in sequence. The next batch is not built until the previous one has been answered. |

There is no server in this product. Your endpoint is the only place this data goes.

---

## The envelope

Every request body — export or connectivity probe — is one object with exactly these
twelve keys. All twelve are always present.

| Key | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Always `1` today. The version of *this* document. Key on it before parsing anything else. |
| `connectivityTest` | boolean | `true` only for the connectivity probe, which carries no samples. **A receiver should not record a payload with `true` here.** See [The connectivity probe](#the-connectivity-probe). |
| `exportId` | string (UUID) | One value shared by **every batch of one export run**. This is how you tell "three batches of one export" from "three exports". |
| `generatedAt` | string (timestamp) | When the batch was built — one instant for the whole run, identical on every batch of it. **Not** when any sample was recorded. |
| `batchSequence` | integer | 1-based, incrementing within one run: `1`, `2`, `3`, … |
| `isFinalBatch` | boolean | `true` on the last batch of the run and no other. See the caveat in [Batching](#batching-and-reassembly). |
| `basis` | string | `window` or `anchor` — which mechanism produced the batch, and therefore **what the window is evidence of**. See [`basis`](#basis-how-to-read-the-window). |
| `windowStart` | string (timestamp) | Inclusive start of the span this batch's samples fall inside. **No sample in the batch starts before it, on either `basis`.** |
| `windowEnd` | string (timestamp) | End of that span. **No sample in the batch ends after it, on either `basis`.** Exclusive on `basis: "window"`, where it is the end of the range that was asked for. |
| `occasionStart` | string (timestamp) | Inclusive start of the **occasion** — one export run — this batch belongs to. Identical on every batch of one run. On `basis: "anchor"` it is the previous scheduled run that delivered something; on `basis: "window"` it equals `windowStart`. |
| `occasionEnd` | string (timestamp) | End of that occasion: this run's `generatedAt` on `basis: "anchor"`, and `windowEnd` on `basis: "window"`. |
| `samples` | array of objects | The batch's samples. Empty on the probe; never absent. |

On `basis: "window"`, `windowStart` / `windowEnd` describe **what was asked for**, not
what came back. A window can legitimately produce zero samples, and a run that finds
nothing sends no request at all.

### `basis`: how to read the window

Two mechanisms produce a batch, and `basis` names which one produced this batch.

**It does not change what `windowStart` / `windowEnd` mean.** On both, every sample in
the batch falls inside them, so filtering, bucketing, or validating on the pair is safe
without branching on `basis` at all. What `basis` tells you is what the pair is
*evidence of*.

**`basis: "window"`** — a manual export, or one triggered from a Shortcut. The user
picked a time range, the app asked Health for the samples whose `start` falls inside
it, and `windowStart` / `windowEnd` *are* that range. So the pair is a **complete
statement about a range**: nothing inside it was withheld. This is what every payload
was before `basis` existed, so a body from an older build that carries no `basis` key
at all is this one.

**`basis: "anchor"`** — a scheduled export, running unattended in the background.
There is no range. The app resumes from a per-type position recorded when it last
delivered, and Health returns what has changed since. `windowStart` / `windowEnd` are
then the batch's own **bracket**: the earliest `start` and the latest `end` among the
samples it carries. Every sample is still inside the pair — but the pair is only the
span this batch happened to cover, not a claim that you have everything in it. A later
batch may carry earlier dates than an earlier one, brackets from different occasions
may overlap, and a gap between two brackets means nothing at all. A reading written
today carrying last week's date is exactly what an anchored read exists to catch, and
it arrives with a window that contains it.

**`occasionStart` / `occasionEnd` are how you correlate a run.** They are identical on
every batch of one export, where an anchored run's windows are per batch. On
`basis: "anchor"` they run from the previous scheduled export that delivered something
to this one, so consecutive occasions tile time end to end: every instant since you
were last handed anything is inside the next occasion. On `basis: "window"` the
occasion *is* the window, and the two pairs are equal.

**What this asks of you: nothing, if you filter on `windowStart` / `windowEnd`.** That
is the point of publishing them this way. What you must not do is read an *occasion* as
a filter — samples routinely fall outside `occasionStart` / `occasionEnd`, because a
scheduled export exists to deliver readings that were written long after the dates they
carry.

---

## The sample object

Every sample carries these eight keys, always:

| Key | Type | Meaning |
| --- | --- | --- |
| `uuid` | string (UUID) | Apple Health's own identifier for the sample. **This is the deduplication key.** |
| `id` | string | A 64-character lowercase hex SHA-256 content fingerprint. **Not a key.** See [Identity](#identity-and-deduplication). |
| `type` | string | Apple's own type identifier, e.g. `HKQuantityTypeIdentifierStepCount`. The full list is in [The catalog](#the-catalog-what-can-arrive). |
| `group` | string | Which of the app's six groups this type belongs to: `activity`, `heart`, `body`, `sleep`, `vitals`, `workouts`. A type belongs to exactly one group, forever. |
| `source` | string | The bundle identifier of whatever *recorded* the sample — e.g. `com.apple.health.<device-UUID>` for Apple's own data, or a third-party app's identifier. |
| `start` | string (timestamp) | When the reading began. |
| `end` | string (timestamp) | When it ended. Equal to `start` for instantaneous readings. |
| `kind` | string | `quantity`, `category`, or `workout`. **This is the discriminator** — it tells you which of the remaining keys are present and what type `value` has. |

Then, per `kind`:

### `kind: "quantity"` — a number in a unit

| Key | Type | Presence |
| --- | --- | --- |
| `value` | number | always |
| `unit` | string | always — one of the [units](#units) below |

```json
{"kind":"quantity","type":"HKQuantityTypeIdentifierStepCount","value":42,"unit":"count", …}
```

### `kind: "category"` — an enumerated state

| Key | Type | Presence |
| --- | --- | --- |
| `value` | integer | always — Apple's raw enum value |
| `name` | string | **only when this build has a name for that integer** |

Sleep analysis is the only category type in v1. `value` is an
`HKCategoryValueSleepAnalysis` raw value, and `name` is Apple's own case name:

| `value` | `name` |
| --- | --- |
| 0 | `inBed` |
| 1 | `asleepUnspecified` |
| 2 | `awake` |
| 3 | `asleepCore` |
| 4 | `asleepDeep` |
| 5 | `asleepREM` |

An integer this build does not know arrives **with no `name` key at all**. Key on
`value`; treat `name` as a convenience.

### `kind: "workout"` — a recorded session

| Key | Type | Presence |
| --- | --- | --- |
| `activityType` | integer | always — Apple's `HKWorkoutActivityType` raw value |
| `activityName` | string | **only when this build has a name for that integer** |
| `durationSeconds` | number | always |
| `distanceMeters` | number | only when the workout recorded a distance |
| `activeEnergyKilocalories` | number | only when the workout recorded energy |

A workout has **no `value` key and no `unit` key**. The units are in the key names
instead: metres, seconds, kilocalories.

`activityName` is Apple's case name in lowerCamelCase — `running`, `cycling`,
`highIntensityIntervalTraining`, `traditionalStrengthTraining`, and so on. Three
values are deliberately unnamed because Apple deprecated them: `14` (dance), `15`
(dance-inspired training), and `30` (mixed metabolic cardio training). They arrive
with their integer and no name, which is the same encoding as any unknown value.

### Absent, never null

**An optional that has no value is an absent key.** The payload contains no `null`
anywhere, ever. This works for a receiver testing presence and for one testing null,
and it is the only honest encoding of "this build has no name for that integer" — a
`null` would read as "the value has no name", which is a different and false claim.

Concretely: a workout with no distance has no `distanceMeters` key. A sleep sample
with an unrecognised value has no `name` key. Never `"distanceMeters": null`.

### Numbers and identifiers

Encoding details that will bite a strictly-typed receiver, and that no single
example reveals:

**A whole-number quantity is written without a decimal point.** `42` steps, a
`1800`-second duration, and `5000` metres all appear as bare integers on the wire,
even though they are floating-point measurements — JSON has one number type and the
encoder emits the shortest form. So `"value": 42` on a `quantity` sample and
`"value": 4` on a `category` sample are indistinguishable as literals, while the
first is a measurement and the second is an enum member.

**Switch on `kind`, never on what the number looks like.** Decode `quantity.value`
as a floating-point number and `category.value` as an integer, and take that decision
from `kind` alone. A receiver that infers types from the literal will read step counts
as integers until the first fractional one arrives.

**UUIDs are uppercase**, in both `exportId` and `samples[].uuid` —
`A1B2C3D4-0000-4000-8000-000000000001`, canonical 8-4-4-4-12 hyphenated form. If your
storage layer normalises case anywhere, normalise it *everywhere*: comparing a
lowercased `uuid` against a stored uppercase one is how a deduplication key silently
stops deduplicating, and the symptom is a second copy of every sample.

---

## Identity and deduplication

Two keys, answering different questions. **`uuid` is the one to deduplicate on.**

### `uuid` — upsert on this

`uuid` is Apple Health's own identifier for the sample. It is unique by construction
and stable for the life of the record on that device. Your receiver should treat it
as the primary key and **upsert**: a payload carrying a `uuid` you already hold is
the same sample, and the new copy should replace the old one rather than being
inserted beside it.

Re-delivery of an already-seen `uuid` is expected and normal, and there are two
ordinary causes. **Overlapping windows:** a `basis: "window"` export — manual, or
triggered from a Shortcut — is the window the user picked, start to finish, and the
app tracks no delivery position for it, so two such exports over overlapping windows
re-send the overlap. A `basis: "anchor"` export resumes from a position instead and
does not re-send what it has already delivered; that is the whole difference between
the two, and it is why [`basis`](#basis-how-to-read-the-window) is on the envelope.
**Retries**, which apply to both: a batch that failed
is tried again later under its original `exportId` and `batchSequence`, byte for byte,
so you may see the same batch twice with nothing else having changed — see
[the caveat that matters](#the-caveat-that-matters). Upserting makes both free, and it
is the reason your receiver must not treat a repeat as an error.

What `uuid` does not survive, stated plainly: **anything that re-mints it.** A
reinstall of Health data, or a device migration that assigns new identifiers, will
deliver the same readings again under new `uuid`s, and a receiver keyed on `uuid`
alone will store them a second time. `id` is published precisely so you can notice
that if you care to; v1 asks nothing of you here.

### `id` — a content fingerprint, not a key

`id` is a SHA-256 over the sample's *content*: its type, its start and end instants
in UTC, and its value. Two records that assert the same reading over the same span
have the same `id`, **by design**. It is not unique and must not be used as a primary
key.

This is worth being concrete about, because it is the reverse of what an earlier
draft of this contract said, and the reversal came from measurement. On a real
device, **720 samples over one day carried only 195 distinct `id`s.** One third-party
writer stamps every heart-rate reading with its containing *hour* rather than the
measurement instant, so 600 readings occupied 24 hour-aligned spans and 76 distinct
(span, value) pairs — records identical in every field the app can read. A receiver
upserting on `id` would have kept 195 of 720 and silently discarded the rest. Apple's
own samples in the same export collided zero times, so this is one writer's stamping
and not a general property of health data — but it is enough to disqualify the key.

Use `id` for what it is good at: **it is stable across a `uuid` re-mint.** If you
want to detect the reinstall case above, index it as a secondary, non-unique column
and treat a new `uuid` with a known `id` as a probable re-delivery.

### What neither key detects

Apple Health sometimes **coalesces** historic samples: two step samples of 30 and 70
may be replaced upstream by one of 100 covering the same span. That is a genuine
content change, so it has a different `id`, and it is a different record, so it has a
different `uuid`. Your receiver will legitimately hold all three rows over one span,
and **nothing in v1 tells you the first two are gone.** Only a deletion feed resolves
it, and v1 carries no deletions.

If you aggregate, be aware that summing over a span can therefore double-count after
a coalesce. The safe reading of v1 data is *append-only, latest-wins per `uuid`*.

---

## Units

`unit` is always one of these spellings, and the spelling is part of the contract.
This table may gain rows; it will not lose or respell one.

<!-- pinned:units -->

| `unit` | Meaning |
| --- | --- |
| `count` | a dimensionless count |
| `count/min` | counts per minute |
| `m` | metres |
| `kcal` | kilocalories |
| `min` | minutes |
| `ms` | milliseconds |
| `kg` | kilograms |
| `fraction` | a proportion in `0…1` |
| `ml/(kg*min)` | millilitres per kilogram per minute |
| `degC` | degrees Celsius |
| `mmHg` | millimetres of mercury |

Two of these deliberately differ from what Apple's canonical unit for the type would
give you, and both differences are the app choosing the reading a receiver actually
wants:

- **`count/min`, not `count/s`,** for heart rate and respiratory rate. Every receiver
  expects beats per minute; `1.2` beats per second is a correct number nobody can
  read.
- **`fraction`, not a percentage,** for blood oxygen and body fat. Apple's percent
  unit yields `0.98`, not `98`. Naming the spelling `fraction` is what stops you from
  charting a 0.98% oxygen saturation. **Multiply by 100 yourself if you want
  percent.**

Forward slashes and parentheses arrive **unescaped**: the bytes are `count/min`, not
`count\/min`.

---

## Dates

Every timestamp key — `generatedAt`, `windowStart`, `windowEnd`, `start`, `end` — is
an ISO-8601 string in exactly this shape:

```
2026-08-21T10:25:30.000+02:00
```

- Full date, `T` separator, full time.
- **Always exactly three fractional digits**, even when they are `.000`.
- **Always a numeric UTC offset with a colon** — `+02:00`, `-05:00` — except that UTC
  renders as `Z`: `2026-08-21T08:25:30.000Z`.

The offset is the **exporting device's** offset at the moment of encoding, not the
sample's. Two batches of one run share one offset. A user who travels will send the
same historic sample under a different offset later; it is the same instant, and any
correct ISO-8601 parser will agree. Store instants in UTC.

Millisecond resolution is the limit of the wire format. Health's underlying
timestamps are finer, so two samples a few microseconds apart can arrive with
identical `start` and `end`. They are still distinct records with distinct `uuid`s.

---

## Batching and reassembly

One export run reads — a window, or an anchor position; see
[`basis`](#basis-how-to-read-the-window) — and delivers what it read as **one or more
batches, sent in sequence**, each its own HTTP request:

- Every batch of the run carries the **same** `exportId`, `generatedAt`, `basis`,
  `occasionStart`, and `occasionEnd`. `windowStart` / `windowEnd` are the same across
  a `basis: "window"` run and **per batch** on a `basis: "anchor"` one, where each
  batch brackets its own samples.
- `batchSequence` starts at `1` and increments by one.
- `isFinalBatch` is `true` on the last batch **only**.
- A batch carries at most **1000** samples.

To reassemble a run: group by `exportId`, order by `batchSequence`, and consider the
run complete when you have seen a contiguous `1…N` ending in `isFinalBatch: true`.

### The caveat that matters

**A run can stop without ever sending `isFinalBatch: true`.** If a batch fails — your
receiver is down, returns a non-`2xx`, or the network drops — the run ends there. You
will hold batches `1…k` of an export whose final flag has not arrived.

That is not corruption, and the batches you did receive are complete and valid. Treat
a run with no final batch as **truncated, not invalid**: keep its samples, do not
discard a partial run, and do not hold what you already have hostage to a batch that
has not arrived.

**The batch that failed may arrive later rather than never.** The app keeps the batch
it built and tries it again on its own schedule, with backoff. A retry is the *same
bytes* the first attempt carried, under the **same `exportId` and the same
`batchSequence`** — so a batch you see twice is one batch tried twice, never a second
run. That is precisely the case
[upserting on `uuid`](#identity-and-deduplication) already covers: the repeat is
expected and normal, and a correct receiver absorbs it.

**Your answer decides how long it keeps trying**, and there are only three endings:

| Your answer | What the app does |
| --- | --- |
| Any `2xx` | Acknowledged. The batch is dropped from the queue and never sent again. |
| Nothing at all, or `408` / `425` / `429` / any `5xx` / a `413` with `Retry-After` | Retried with backoff — 15 minutes, then doubling to a ceiling of one hour — until it succeeds or ages out. |
| `400` / `401` / `403` / `404` / `405` / `422`, any `3xx`, a bare `413`, or anything else outside the two rows above | **Not retried at all.** The batch is dropped the moment you answer. No amount of retrying fixes a wrong path, a wrong credential, or a body your receiver will never accept — so if you answer this way by mistake, that batch is gone and the only way back is a manual export over a window covering it. |

A `3xx` is in the last row because redirects are refused rather than followed, so a
redirect is a rejection here and retrying it forever would be retrying an address the
user needs to be told to fix.

What this changes for reassembly is the clock, not the rule. Batch `k+1` of an
`exportId` you last saw hours or days ago is that same run continuing, and a
contiguous `1…N` ending in `isFinalBatch: true` may complete long after batch `1`
landed. Do not time out an `exportId` and do not renumber anything: identity is stable
across the wait.

**The wait is bounded at seven days.** Pending work older than that is dropped, and
the app does not go back for it. An `exportId` still incomplete a week after its first
batch will stay incomplete — treat it as truncated, permanently. The only way back
is a manual export over a window covering the loss, and that is a **new** `exportId`
on `basis: "window"` — never the dropped one resumed — so it resends everything that
already landed inside that range. Upserting on `uuid` is what makes that free.

That recovery is a user's deliberate act, and on a scheduled export it is the *only*
one: a `basis: "anchor"` run's position has already moved past a batch aged out this
way, and the app does not move it back. Rewinding would re-send everything delivered
since, which is a worse failure than the bounded loss it would be repairing.

### Ordering

Within a batch, samples arrive grouped by type, ascending by `start` within each
type. **This is not part of the contract** — do not rely on it. Order by `start`
yourself if you need it.

---

## Size

**A batch body stays under 1 MB.**

That number is nginx's `client_max_body_size` default, and therefore the ceiling most
self-hosted receivers actually have, whatever the application behind the proxy would
accept. The cap is the app's own, sized so that this is true without negotiation:
1000 samples of the heaviest shape the app can emit is roughly 516 KB, half the
ceiling, and a real device export measured 389 bytes a sample.

Raising `client_max_body_size` on your side gains you nothing — the app will not send
larger batches — and you do not need to raise it to receive this payload.

If your receiver answers a **bare `413`**, that is a permanent configuration problem
for this batch size, not a transient one: no number of retries makes the same bytes
smaller, so the app does not retry it and treats it as a failure the user must see.

A **`413` carrying `Retry-After`** is treated as temporary instead, and the batch is
retried after the interval you asked for. RFC 9110 §15.5.14 is why the two are read
differently: "If the condition is temporary, the server SHOULD generate a
`Retry-After` header field." Send one if your limit is a rate rather than a ceiling.

**`Retry-After` is honored but clamped to one hour**, on any status that carries it,
in both forms RFC 9110 §10.2.3 defines (`delay-seconds` and an `HTTP-date`). The clamp
is not a hedge against you: Apple's own server APIs emit a non-RFC UNIX-milliseconds
value in this header, so an unclamped `60000` would read as sixteen hours. Ask for
longer than an hour and you will be retried in an hour; ask for something the app
cannot parse and it falls back to its own backoff.

---

## The connectivity probe

When the user taps "Test connection", the app sends **the same envelope with no
samples in it** and `connectivityTest: true`. For a destination set to JSON, that is —
byte for byte, always exactly this:

<!-- pinned:probe -->

```json
{"basis":"window","batchSequence":1,"connectivityTest":true,"exportId":"00000000-0000-0000-0000-000000000000","generatedAt":"1970-01-01T00:00:00.000Z","isFinalBatch":true,"occasionEnd":"1970-01-01T00:00:00.000Z","occasionStart":"1970-01-01T00:00:00.000Z","samples":[],"schemaVersion":1,"windowEnd":"1970-01-01T00:00:00.000Z","windowStart":"1970-01-01T00:00:00.000Z"}
```

`exportId` is the nil UUID and `generatedAt` is the Unix epoch — both fixed
constants, identical on every probe from every user forever, so that a receiver
keying on either sees one value and can recognise it as synthetic.

**Recommended handling:** answer `2xx` and record nothing. A probe is not an export
and contains no health data. If your pipeline records it anyway, the nil `exportId`
makes it trivial to filter later.

The probe is deliberately not a second shape. It is this shape, empty — so that
testing a connection exercises the real path: your method, your headers, your
credential, the same content type. **A destination set to CSV therefore sends a CSV
probe**, not this one: a header row with no data rows, carrying no `exportId`, sent as
`text/csv`. See *The probe* in healthd's `docs/csv.md` (not vendored here).

---

## Compatibility: what may change inside v1

The policy is **additive only**.

- **New keys may be added** to the envelope or to a sample object, at any time,
  without a version bump.
- **No key will ever be removed, renamed, or repurposed** within `schemaVersion: 1`.
  A key's type and meaning are fixed once published.
- **`schemaVersion` changes only if that promise is broken.** If you ever see a
  version other than `1`, the guarantees on this page no longer apply to that payload
  and you should reject it rather than guess.

**What this asks of you: ignore keys you do not recognise.** A parser that rejects
unknown keys — a strict schema validator, a struct decoder configured to fail on
extras — will break the first time a key is added, and that break will be your
outage, not ours. Every parser this contract is designed for is tolerant of extra
keys. This is the same rule Google's API design guide gives for JSON responses and
that CloudEvents gives for unknown attributes.

This is also why `kind` exists as an explicit discriminator rather than being
inferred from which keys are present: a new key must never be able to change how you
decide what a sample is.

---

## What v1 does not carry

Three absences, each with a reason and none of them an oversight:

### No deletions

If a sample is deleted in Health after healthd has delivered it, **you will never
hear about it.** v1 is append-only, and that is a property of this envelope rather
than of how the samples were read: there is no deletion key here for either
[basis](#basis-how-to-read-the-window) to fill. A `basis: "window"` read could not
report a deletion even if there were one — there is nothing to read where a record
used to be. A `basis: "anchor"` read can observe one, and v1 deliberately does not
publish it: a deletion feed needs a new key and a receiver contract for acting on it,
which is later work rather than a silent change of meaning inside `schemaVersion: 1`.

Consequence for you: your copy is a superset of what Health currently holds, and it
does not shrink. If you need to reconcile, you must do it out of band.

### No samples backdated outside the window — on a windowed export

**`basis: "window"`.** The window is matched on a sample's `start`. A sample
**written today** carrying **last week's** start date will not appear in a "last 24
hours" export, because its start is not in that window — even though it is new
information.

Consequence for you: a windowed run is not a complete statement about what changed
since the previous run. It is a complete statement about a *time range*. Users who
want the backdated sample must export a window that contains it.

**`basis: "anchor"`.** A scheduled export has this the other way round: it resumes
from a position rather than a range, so a backdated sample *does* arrive, on the first
scheduled export after it was written — and it arrives inside that batch's
`windowStart` / `windowEnd`, which is the bracket of what the batch carries rather than
a range anyone asked for. The batch's `occasionStart` / `occasionEnd` will not contain
it, and that is expected: the occasion says *when the app looked*, not *what dates it
found*. What an anchored export still cannot tell you is *which* samples were backdated
— a sample carries its own dates and nothing about when it was written.

### No coalescing signal

Covered under [Identity](#what-neither-key-detects), and repeated here because it is
the one that quietly corrupts aggregates: Health may replace fine-grained historic
samples with a combined one. You will receive both, over the same span, with no
indication that the originals are gone.

---

## The catalog: what can arrive

Six groups, each enabled independently by the user. A type belongs to exactly one
group. Only enabled groups are read, so a receiver should expect any subset — an
export carrying only `sleep` is normal, not a partial failure.

<!-- pinned:catalog -->

| `group` | `type` | `kind` | `unit` |
| --- | --- | --- | --- |
| `activity` | `HKQuantityTypeIdentifierStepCount` | quantity | `count` |
| `activity` | `HKQuantityTypeIdentifierDistanceWalkingRunning` | quantity | `m` |
| `activity` | `HKQuantityTypeIdentifierFlightsClimbed` | quantity | `count` |
| `activity` | `HKQuantityTypeIdentifierActiveEnergyBurned` | quantity | `kcal` |
| `activity` | `HKQuantityTypeIdentifierBasalEnergyBurned` | quantity | `kcal` |
| `activity` | `HKQuantityTypeIdentifierAppleExerciseTime` | quantity | `min` |
| `activity` | `HKQuantityTypeIdentifierAppleStandTime` | quantity | `min` |
| `heart` | `HKQuantityTypeIdentifierHeartRate` | quantity | `count/min` |
| `heart` | `HKQuantityTypeIdentifierRestingHeartRate` | quantity | `count/min` |
| `heart` | `HKQuantityTypeIdentifierWalkingHeartRateAverage` | quantity | `count/min` |
| `heart` | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | quantity | `ms` |
| `body` | `HKQuantityTypeIdentifierBodyMass` | quantity | `kg` |
| `body` | `HKQuantityTypeIdentifierHeight` | quantity | `m` |
| `body` | `HKQuantityTypeIdentifierBodyMassIndex` | quantity | `count` |
| `body` | `HKQuantityTypeIdentifierBodyFatPercentage` | quantity | `fraction` |
| `body` | `HKQuantityTypeIdentifierLeanBodyMass` | quantity | `kg` |
| `sleep` | `HKCategoryTypeIdentifierSleepAnalysis` | category | — |
| `vitals` | `HKQuantityTypeIdentifierOxygenSaturation` | quantity | `fraction` |
| `vitals` | `HKQuantityTypeIdentifierRespiratoryRate` | quantity | `count/min` |
| `vitals` | `HKQuantityTypeIdentifierVO2Max` | quantity | `ml/(kg*min)` |
| `vitals` | `HKQuantityTypeIdentifierBodyTemperature` | quantity | `degC` |
| `vitals` | `HKQuantityTypeIdentifierBloodPressureSystolic` | quantity | `mmHg` |
| `vitals` | `HKQuantityTypeIdentifierBloodPressureDiastolic` | quantity | `mmHg` |
| `workouts` | `HKWorkoutTypeIdentifier` | workout | — |

Workout **routes** — GPS traces — are deliberately absent and will not be added to
v1. Heart-rate samples recorded during a workout arrive as ordinary `heart` samples,
not nested inside the workout object.

This table may grow (new types are an additive change). It will not shrink, and no
type will move between groups.

---

## Worked example

A single export batch carrying all three sample kinds — the exact bytes, as sent:

<!-- pinned:payload -->

```json
{"basis":"window","batchSequence":1,"connectivityTest":false,"exportId":"6C7F1E22-1B3D-4A5E-9F00-2C1D4E5A6B70","generatedAt":"2026-08-21T12:00:00.000+02:00","isFinalBatch":true,"occasionEnd":"2026-08-21T12:00:00.000+02:00","occasionStart":"2026-08-20T12:00:00.000+02:00","samples":[{"end":"2026-08-21T10:25:30.000+02:00","group":"activity","id":"3cae82ce29b729ba872bdd31f1db79f0a31013c3546710bd4fe1adb8192ec011","kind":"quantity","source":"com.apple.Health","start":"2026-08-21T10:25:30.000+02:00","type":"HKQuantityTypeIdentifierStepCount","unit":"count","uuid":"A1B2C3D4-0000-4000-8000-000000000001","value":42},{"end":"2026-08-21T00:55:00.000+02:00","group":"sleep","id":"8b8f956b04e59162cf497570f22a2f9f96f82b5ffddc090b0c060ba910f14e21","kind":"category","name":"asleepDeep","source":"com.apple.Health","start":"2026-08-21T00:10:00.000+02:00","type":"HKCategoryTypeIdentifierSleepAnalysis","uuid":"A1B2C3D4-0000-4000-8000-000000000002","value":4},{"activeEnergyKilocalories":320,"activityName":"running","activityType":37,"distanceMeters":5000,"durationSeconds":1800,"end":"2026-08-21T07:30:00.000+02:00","group":"workouts","id":"689c84ea50249537ec039e00b603c06985d1c24a864d02cba7261764e669e477","kind":"workout","source":"com.apple.Health","start":"2026-08-21T07:00:00.000+02:00","type":"HKWorkoutTypeIdentifier","uuid":"A1B2C3D4-0000-4000-8000-000000000003"}],"schemaVersion":1,"windowEnd":"2026-08-21T12:00:00.000+02:00","windowStart":"2026-08-20T12:00:00.000+02:00"}
```

The same object, indented for reading:

<!-- pinned:payload-pretty -->

```json
{
  "basis": "window",
  "batchSequence": 1,
  "connectivityTest": false,
  "exportId": "6C7F1E22-1B3D-4A5E-9F00-2C1D4E5A6B70",
  "generatedAt": "2026-08-21T12:00:00.000+02:00",
  "isFinalBatch": true,
  "occasionEnd": "2026-08-21T12:00:00.000+02:00",
  "occasionStart": "2026-08-20T12:00:00.000+02:00",
  "samples": [
    {
      "end": "2026-08-21T10:25:30.000+02:00",
      "group": "activity",
      "id": "3cae82ce29b729ba872bdd31f1db79f0a31013c3546710bd4fe1adb8192ec011",
      "kind": "quantity",
      "source": "com.apple.Health",
      "start": "2026-08-21T10:25:30.000+02:00",
      "type": "HKQuantityTypeIdentifierStepCount",
      "unit": "count",
      "uuid": "A1B2C3D4-0000-4000-8000-000000000001",
      "value": 42
    },
    {
      "end": "2026-08-21T00:55:00.000+02:00",
      "group": "sleep",
      "id": "8b8f956b04e59162cf497570f22a2f9f96f82b5ffddc090b0c060ba910f14e21",
      "kind": "category",
      "name": "asleepDeep",
      "source": "com.apple.Health",
      "start": "2026-08-21T00:10:00.000+02:00",
      "type": "HKCategoryTypeIdentifierSleepAnalysis",
      "uuid": "A1B2C3D4-0000-4000-8000-000000000002",
      "value": 4
    },
    {
      "activeEnergyKilocalories": 320,
      "activityName": "running",
      "activityType": 37,
      "distanceMeters": 5000,
      "durationSeconds": 1800,
      "end": "2026-08-21T07:30:00.000+02:00",
      "group": "workouts",
      "id": "689c84ea50249537ec039e00b603c06985d1c24a864d02cba7261764e669e477",
      "kind": "workout",
      "source": "com.apple.Health",
      "start": "2026-08-21T07:00:00.000+02:00",
      "type": "HKWorkoutTypeIdentifier",
      "uuid": "A1B2C3D4-0000-4000-8000-000000000003"
    }
  ],
  "schemaVersion": 1,
  "windowEnd": "2026-08-21T12:00:00.000+02:00",
  "windowStart": "2026-08-20T12:00:00.000+02:00"
}
```

Reading it back: one export (`exportId` `6C7F1E22…`) built at noon Warsaw time,
covering the preceding 24 hours, complete in one batch. Three samples — 42 steps at
10:25:30, 45 minutes of deep sleep from 00:10, and a 30-minute 5 km run burning
320 kcal. Every sample's `start` falls inside `[windowStart, windowEnd)` — as it does
on either `basis` — and `basis` is `window`, so the pair additionally says nothing
inside that range was withheld. `occasionStart` / `occasionEnd` equal the window here,
because on a windowed export the occasion *is* the range that was asked for.

Both blocks above are checked against the app's own pinned test fixture on every
build, so this example cannot drift away from what the app actually sends.

---

## A minimal receiver

Enough to be correct, in pseudocode:

```
on POST /health:
    body = parse_json(request.body)

    if body.schemaVersion != 1:
        return 400                      # unknown contract; do not guess

    if body.connectivityTest:
        return 200                      # probe: acknowledge, record nothing

    for s in body.samples:
        upsert into samples
            key    = s.uuid             # NOT s.id
            values = { type, group, source, start, end, kind,
                       fingerprint = s.id,
                       payload     = s }  # keep the whole object; keys will grow

    record_run(body.exportId, body.batchSequence, body.isFinalBatch,
               body.basis, body.windowStart, body.windowEnd,
               body.occasionStart, body.occasionEnd, body.generatedAt)
                                        # windowStart/windowEnd contain every sample
                                        # on either basis, so bucketing on them is
                                        # safe; occasionStart/occasionEnd are a run
                                        # label and NOT a filter

    return 200
```

Three things this gets right and a naive version does not: it keys on `uuid`, it
stores the whole sample object so an added key is not silently dropped, and it
acknowledges the probe without recording it.

---

## Questions this document should have answered

If any of these are still unclear after reading, the document has a gap worth filling:

- Which key do I deduplicate on, and why is there a second one? → [Identity](#identity-and-deduplication)
- What happens when a key I expect is missing? → [Absent, never null](#absent-never-null)
- How do I know an export finished? → [Batching](#batching-and-reassembly)
- I saw the same `exportId` and `batchSequence` twice — what does that mean? → [The caveat that matters](#the-caveat-that-matters)
- How long will the app keep trying, and what happens when it stops? → [The caveat that matters](#the-caveat-that-matters)
- How big can a request be? → [Size](#size)
- Will this payload change under me? → [Compatibility](#compatibility-what-may-change-inside-v1)
- What is this payload *not* telling me? → [What v1 does not carry](#what-v1-does-not-carry)
- What is the difference between the window and the occasion? → [`basis`](#basis-how-to-read-the-window)
