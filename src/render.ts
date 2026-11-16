import type { Dashboard, DayValue, TypeFreshness } from "./dashboard.js";
import { P90_FACTOR, STALE_FACTOR, STALE_FLOOR_SECONDS } from "./dashboard.js";

/**
 * Server-rendered HTML, no client build step, no chart library, no
 * JavaScript on the page at all -- the sparklines are hand-rolled SVG
 * polylines. It should read like a Synapse tile that grew a table, not
 * like a SaaS dashboard.
 *
 * Everything user-influenced is escaped on the way out, and nothing here
 * ever touches the credential: the read listener does not even load it.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`.replace(" 0s", "");
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/** "3m ago" / "2d 4h ago" / "never". Relative is what a glance needs; the
 *  absolute instant goes in the title attribute underneath it. */
export function relativeTime(iso: string | null, now: Date): string {
  if (iso === null) return "never";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 0) return "in the future";
  if (ms < 45_000) return "just now";
  return `${formatDuration(ms / 1000)} ago`;
}

/** Local wall-clock rendering. The store is UTC; the reader is not. */
export function localStamp(iso: string | null): string {
  if (iso === null) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
}

/**
 * A sparkline, drawn by hand: baseline, area, line, and a dot on the last
 * point. An all-zero series draws a flat baseline rather than dividing by
 * zero, because "nothing happened" is a reading too.
 */
export function sparkline(values: number[], opts: { width?: number; height?: number; label?: string } = {}): string {
  const width = opts.width ?? 140;
  const height = opts.height ?? 28;
  const label = escapeHtml(opts.label ?? `${values.length} buckets`);
  if (values.length === 0) {
    return `<svg class="spark" width="${width}" height="${height}" role="img" aria-label="no data"></svg>`;
  }
  const max = Math.max(...values, 0);
  const n = values.length;
  const step = n > 1 ? (width - 2) / (n - 1) : 0;
  const base = height - 1;
  const round = (v: number): string => (Math.round(v * 10) / 10).toString();
  const y = (v: number): number => (max <= 0 ? base : base - (v / max) * (height - 3));
  const pts = values.map((v, i) => `${round(1 + i * step)},${round(y(v))}`);
  const lastX = round(1 + (n - 1) * step);
  const lastY = round(y(values[n - 1] as number));
  const area = `1,${base} ${pts.join(" ")} ${lastX},${base}`;
  return (
    `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">` +
    `<polygon class="spark-area" points="${area}"></polygon>` +
    `<polyline class="spark-line" points="${pts.join(" ")}"></polyline>` +
    `<circle class="spark-dot" cx="${lastX}" cy="${lastY}" r="2"></circle>` +
    `</svg>`
  );
}

function tile(
  label: string,
  value: string,
  sub: string,
  tone: "ok" | "warn" | "muted" | "plain" = "plain",
  wide = false,
): string {
  return (
    `<div class="tile tile-${tone}${wide ? " tile-wide" : ""}">` +
    `<div class="tile-label">${escapeHtml(label)}</div>` +
    `<div class="tile-value">${value}</div>` +
    `<div class="tile-sub">${sub}</div>` +
    `</div>`
  );
}

function shortType(type: string): string {
  const short = type
    .replace(/^HKQuantityTypeIdentifier/, "")
    .replace(/^HKCategoryTypeIdentifier/, "")
    .replace(/^HKWorkoutTypeIdentifier/, "")
    .replace(/^HKDataType/, "");
  // "HKWorkoutTypeIdentifier" is the whole identifier, not a prefix: stripping
  // it leaves an empty cell. A label that vanishes is worse than a long one.
  return short.length === 0 ? type : short;
}

/**
 * One table cell, labelled with its column header. Below 720 px every `.grid`
 * table stacks into label | value rows, and the label is this attribute read
 * by `td::before { content: attr(data-k) }`: markup, not an inline style, so
 * `style-src 'self'` still holds. Every cell of a `.grid` table goes through
 * here; tests/dashboard.test.ts checks each label against its header.
 */
function cell(k: string, body: string, cls = "", attrs = ""): string {
  return `<td${cls === "" ? "" : ` class="${cls}"`}${attrs} data-k="${escapeHtml(k)}">${body}</td>`;
}

function th(label: string, num = false): string {
  return `<th${num ? ` class="num"` : ""}>${escapeHtml(label)}</th>`;
}

function gridTable(cls: string, head: string, rows: string): string {
  return (
    `<div class="table-wrap"><table class="grid ${cls}"><thead><tr>${head}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function typeRow(t: TypeFreshness, now: Date, sparkDays: number): string {
  // Bursty cadences break before "in bursts", so the column holds two short
  // lines instead of one long one.
  const cadence =
    t.medianGapSeconds === null
      ? "not enough history"
      : t.p90GapSeconds !== null && t.p90GapSeconds > t.medianGapSeconds * 2
        ? `${escapeHtml(`every ~${formatDuration(t.medianGapSeconds)},`)}<br>` +
          `${escapeHtml(`in bursts ~${formatDuration(t.p90GapSeconds)} apart`)}`
        : escapeHtml(`every ~${formatDuration(t.medianGapSeconds)}`);
  const stateTitle =
    t.thresholdSeconds === null ? "no cadence yet" : `amber above ${formatDuration(t.thresholdSeconds)} behind`;
  const lag = t.lagSeconds === null ? "-" : t.lagSeconds < 60 ? "current" : `${formatDuration(t.lagSeconds)} behind`;
  const state = t.state === "amber" ? "stopped?" : t.state === "ok" ? "ok" : "new";
  return (
    `<tr class="state-${t.state}">` +
    cell(
      "type",
      `<span class="dot dot-${t.state}"></span>${escapeHtml(shortType(t.type))}` +
        (shortType(t.type) === t.type ? "" : `<span class="muted t-full">${escapeHtml(t.type)}</span>`),
      "t-name",
    ) +
    cell(
      "last sample",
      `${localStamp(t.lastSampleAt)}<span class="muted"> (${escapeHtml(relativeTime(t.lastSampleAt, now))})</span>`,
      "num t-last",
      ` title="${escapeHtml(t.lastSampleAt ?? "")}"`,
    ) +
    cell("vs newest", escapeHtml(lag), "num t-vs") +
    cell("observed cadence", cadence, "num t-cad") +
    cell("7d", formatNumber(t.count7d), "num t-7d") +
    cell("total", formatNumber(t.total), "num t-total") +
    cell(`last ${sparkDays}d`, sparkline(t.spark, { label: `${shortType(t.type)} daily counts` }), "spark-cell") +
    cell("state", escapeHtml(state), "num state-word", ` title="${escapeHtml(stateTitle)}"`) +
    `</tr>`
  );
}

/** A reading card lists its newest days only; the sparkline beside it still
 *  plots every day, so nothing leaves the page -- only the table. */
const READING_ROWS = 7;

function dayTable(rows: DayValue[], unit: string, decimals: number): string {
  const shown = [...rows].reverse().filter((r) => r.samples > 0 || r.value > 0);
  if (shown.length === 0) return "";
  const listed = shown.slice(0, READING_ROWS);
  const hidden = shown.length - listed.length;
  return (
    `<table class="mini"><tbody>` +
    listed
      .map(
        (r) =>
          `<tr>${cell("day", escapeHtml(r.day), "day")}` +
          cell(
            "value",
            `${escapeHtml(decimals === 0 ? formatNumber(r.value) : r.value.toFixed(decimals))} ` +
              `<span class="muted">${escapeHtml(unit)}</span>`,
            "num",
          ) +
          `${cell("samples", `${formatNumber(r.samples)} samples`, "num muted")}</tr>`,
      )
      .join("") +
    `</tbody></table>` +
    (hidden > 0 ? `<p class="caption">${formatNumber(hidden)} older rows not shown</p>` : "")
  );
}

function reading(title: string, body: string): string {
  return `<section class="card reading"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function section(title: string, body: string, note?: string, card = false): string {
  return (
    `<section class="panel${card ? " card" : ""}">` +
    `<h2>${escapeHtml(title)}</h2>` +
    (note === undefined ? "" : `<p class="note">${note}</p>`) +
    body +
    `</section>`
  );
}

const EMPTY = (what: string): string => `<p class="empty">${escapeHtml(what)}</p>`;

/** Said out loud wherever a sum appears, not hidden in a README. */
const COALESCING_NOTE =
  `Apple Health <strong>coalesces</strong> historic samples, so a sum over a span can count the same ` +
  `underlying activity twice, and schemaVersion 1 carries <strong>no deletions</strong> — a sample removed ` +
  `on the phone stays here. Read every total below as <em>append-only, first stored wins per uuid</em>: a floor ` +
  `with duplicates, not a ledger.`;

export function renderDashboard(model: Dashboard): string {
  const now = new Date(model.generatedAt);
  const s = model.strip;
  const empty = s.state === "empty";

  const headline =
    s.state === "ok" ? "pipe alive" : s.state === "warn" ? "check the pipe" : "nothing has arrived yet";

  const tiles = [
    tile(
      "last delivery",
      escapeHtml(relativeTime(s.lastDeliveryAt, now)),
      s.lastDeliveryAt === null
        ? "no request has ever reached this receiver"
        : `${escapeHtml(localStamp(s.lastDeliveryAt))} local`,
      s.state === "ok" ? "ok" : s.state === "warn" ? "warn" : "muted",
    ),
    tile(
      "last complete run",
      escapeHtml(relativeTime(s.lastCompleteRunAt, now)),
      s.lastCompleteRunAt === null
        ? "no run has yet sent its final batch"
        : `${escapeHtml(localStamp(s.lastCompleteRunAt))} local`,
      s.lastCompleteRunAt === null ? "muted" : "ok",
    ),
    tile(
      "truncated runs",
      formatNumber(s.truncatedRuns7d),
      `last 7 days · ${formatNumber(s.truncatedRuns)} all time · a run that stopped without its final batch`,
      s.truncatedRuns7d > 0 ? "warn" : "ok",
    ),
    tile(
      "unauthorised 24h",
      formatNumber(s.unauthorised24h),
      `401s answered · ${formatNumber(s.quarantined24h)} quarantined 24h, ${formatNumber(s.quarantinedTotal)} all time`,
      s.unauthorised24h > 0 ? "warn" : "ok",
    ),
    tile(
      "samples in 24h",
      formatNumber(s.samplesReceived24h),
      `${formatNumber(s.samplesReceived7d)} in 7d · counted by <strong>arrival</strong>, not by sample time`,
      "plain",
    ),
    tile(
      "samples stored",
      formatNumber(s.samplesTotal),
      `${formatNumber(s.runsTotal)} run(s) · ${formatNumber(s.samplesDuplicate)} duplicate · ${formatNumber(s.samplesRejected)} rejected`,
      s.samplesRejected > 0 ? "warn" : "plain",
    ),
    tile("database", escapeHtml(formatBytes(s.dbBytes)), escapeHtml(s.dbPath), "muted", true),
  ].join("");

  const freshness =
    model.types.length === 0
      ? EMPTY("No samples yet, so there is no cadence to judge. This table fills in on the first export.")
      : gridTable(
          "freshness",
          th("type") + th("last sample") + th("vs newest") + th("observed cadence") +
            th("7d", true) + th("total", true) + th(`last ${model.sparkDays}d`) + th("state", true),
          model.types.map((t) => typeRow(t, now, model.sparkDays)).join(""),
        );

  const freshnessNote =
    `A type goes amber on <em>its own</em> observed rhythm: further behind the newest sample in the store than ` +
    `${STALE_FACTOR}× its median gap or ${P90_FACTOR}× its 90th-percentile gap, whichever is larger ` +
    `(floor ${formatDuration(STALE_FLOOR_SECONDS)}, to absorb export boundaries). The p90 term is what keeps a ` +
    `<em>bursty</em> type — sleep stages 90 minutes apart, then 22 hours of nothing — from going amber by breakfast. ` +
    `The comparison is against the newest sample, <strong>not against now</strong> — healthd has no scheduler, ` +
    `so between manual exports everything is stale and only "the others kept coming, this one stopped" is a signal.`;

  const stepsTotal = model.steps.reduce((acc, d) => acc + d.value, 0);
  const stepsDays = model.steps.filter((d) => d.samples > 0).length;
  const stepsBody =
    stepsDays === 0
      ? EMPTY("No step samples in this window.")
      : `<div class="reading-figure">${sparkline(
          model.steps.map((d) => d.value),
          { width: 260, height: 48, label: "steps per day" },
        )}<div class="muted reading-sub">${formatNumber(stepsTotal)} steps summed over ${stepsDays} day(s) with data</div></div>` +
        dayTable(model.steps, "steps", 0);

  const hrWithData = model.restingHr.filter((d) => d.samples > 0);
  const hrLatest = hrWithData.at(-1);
  const hrBody =
    hrWithData.length === 0
      ? EMPTY("No resting heart rate samples in this window.")
      : `<div class="reading-figure">${sparkline(
          model.restingHr.map((d) => d.value),
          { width: 260, height: 48, label: "resting heart rate" },
        )}<div class="muted reading-sub">latest ${escapeHtml((hrLatest?.value ?? 0).toFixed(0))} bpm on ${escapeHtml(
          hrLatest?.day ?? "-",
        )} · min ${escapeHtml(Math.min(...hrWithData.map((d) => d.value)).toFixed(0))} · max ${escapeHtml(
          Math.max(...hrWithData.map((d) => d.value)).toFixed(0),
        )} over ${model.hrDays}d</div></div>` +
        dayTable(model.restingHr, "bpm avg", 0);

  const sleepWithData = model.sleep.filter((d) => d.samples > 0);
  const sleepBody =
    sleepWithData.length === 0
      ? EMPTY("No sleep samples in this window.")
      : `<div class="reading-figure">${sparkline(
          model.sleep.map((d) => d.value),
          { width: 260, height: 48, label: "sleep hours per night" },
        )}<div class="muted reading-sub">filed under the day you woke up · asleep stages only, inBed and awake excluded</div></div>` +
        dayTable(model.sleep, "h", 1);

  const workoutsBody =
    model.workouts.length === 0
      ? EMPTY("No workouts stored.")
      : gridTable(
          "workouts",
          th("started") + th("activity") + th("duration", true) + th("distance", true) + th("energy", true),
          model.workouts
            .map(
              (w) =>
                `<tr>${cell("started", escapeHtml(localStamp(w.startAt)))}` +
                cell("activity", escapeHtml(w.name ?? `activityType ${w.activityType ?? "?"}`)) +
                cell("duration", escapeHtml(w.durationSeconds === null ? "-" : formatDuration(w.durationSeconds)), "num") +
                cell(
                  "distance",
                  escapeHtml(w.distanceMeters === null ? "-" : `${(w.distanceMeters / 1000).toFixed(2)} km`),
                  "num",
                ) +
                `${cell("energy", escapeHtml(w.energyKcal === null ? "-" : `${Math.round(w.energyKcal)} kcal`), "num")}</tr>`,
            )
            .join(""),
        );

  const deliveriesBody =
    model.deliveries.length === 0
      ? EMPTY("The delivery log is empty: nothing has reached this receiver, not even a rejected request.")
      : gridTable(
          "deliveries",
          th("when") + th("from") + th("outcome") + th("status", true) + th("samples", true) + th("bytes", true) +
            th("path") + th("note"),
          model.deliveries
            .map(
              (d) =>
                `<tr class="outcome-${escapeHtml(d.outcome)}">` +
                cell("when", escapeHtml(localStamp(d.receivedAt)), "", ` title="${escapeHtml(d.receivedAt)}"`) +
                cell("from", escapeHtml(d.remoteAddr ?? "-")) +
                cell("outcome", escapeHtml(d.outcome)) +
                cell("status", escapeHtml(d.status), "num") +
                cell("samples", formatNumber(d.sampleCount), "num") +
                cell("bytes", escapeHtml(formatBytes(d.bytes)), "num") +
                cell("path", escapeHtml(d.path), "path") +
                `${cell("note", escapeHtml(d.note ?? ""), "muted")}</tr>`,
            )
            .join(""),
        );

  const runsBody =
    model.runs.length === 0
      ? EMPTY("No export run has been seen yet.")
      : gridTable(
          "runs",
          th("export") + th("span") + th("batches", true) + th("claimed", true) + th("stored", true) +
            th("last seen") + th("state"),
          model.runs
            .map(
              (r) =>
                `<tr class="${r.truncated ? "state-amber" : "state-ok"}">` +
                cell("export", escapeHtml(r.exportId.slice(0, 8)), "path", ` title="${escapeHtml(r.exportId)}"`) +
                cell(
                  "span",
                  `${escapeHtml(localStamp(r.span.start))} → ${escapeHtml(localStamp(r.span.end))}`,
                  "",
                  ` title="${r.span.source}"`,
                ) +
                cell(
                  "batches",
                  `${formatNumber(r.batchesSeen)} / ${formatNumber(r.maxSequence)}${
                    r.finalSeen ? "" : " <span class=\"muted\">no final</span>"
                  }`,
                  "num",
                ) +
                cell("claimed", formatNumber(r.sampleCount), "num") +
                cell("stored", formatNumber(r.storedCount), "num") +
                cell("last seen", escapeHtml(localStamp(r.lastSeen))) +
                `${cell("state", r.truncated ? "truncated" : r.finalSeen ? "complete" : "in flight", "state-word")}</tr>`,
            )
            .join(""),
        );

  const emptyBanner = empty
    ? `<section class="panel card banner">` +
      `<h2>Nothing has arrived yet</h2>` +
      `<p>The receiver is up and this page is reading an empty store. Nothing is wrong with it yet — ` +
      `no request, not even a rejected one, has reached the ingest listener.</p>` +
      `<p class="muted">In healthd: set the destination to <code>http://&lt;this-mac&gt;:4781/ingest</code>, ` +
      `set the credential header to the one you minted with <code>npm run token:mint</code>, and tap ` +
      `Test connection. The probe alone will light up "last delivery" above.</p>` +
      `</section>`
    : "";

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>vitals — ${escapeHtml(headline)}</title>\n` +
    `<link rel="stylesheet" href="/assets/pipe.css">\n` +
    `</head>\n<body>\n` +
    `<header class="top"><div class="top-row">` +
    `<h1>vitals</h1>` +
    `<span class="status status-${s.state}"><span class="dot dot-${s.state === "warn" ? "amber" : s.state === "ok" ? "ok" : "unknown"}"></span>${escapeHtml(headline)}</span>` +
    `<span class="muted top-reason">${escapeHtml(s.stateReason)}</span>` +
    `<span class="grow"></span>` +
    `<a class="top-link" href="/">&larr; today</a></div>` +
    `<p class="muted top-meta">rendered ${escapeHtml(localStamp(model.generatedAt))} local · read-only · loopback</p>` +
    `</header>\n<main class="page">\n` +
    emptyBanner +
    section("Is the pipe alive?", `<div class="strip">${tiles}</div>`,
      `Delivery health first, body data second: the failure mode of this whole category is <strong>silent ` +
      `non-delivery</strong>, and a dashboard full of heart rates cannot tell you that nothing arrived. ` +
      `<strong>samples in 24h counts arrivals</strong> (<code>received_at</code>), not sample time — a backfill ` +
      `of March lands in today's number.`) +
    section(`Freshness per metric type`, freshness, freshnessNote, true) +
    // The coalescing caveat covers all three readings, so it opens their row.
    `<div class="panel"><p class="note">${COALESCING_NOTE}</p><div class="readings">` +
    reading("Steps per day", stepsBody) +
    reading(`Resting heart rate (${model.hrDays}d, daily average)`, hrBody) +
    reading("Sleep", sleepBody) +
    `</div></div>` +
    section("Workouts", workoutsBody, undefined, true) +
    section("Delivery log", deliveriesBody,
      `Every request that reached us, including the ones we refused. healthd never reads our response body, ` +
      `so this table is the only record of our side of the conversation.`, true) +
    section("Export runs", runsBody,
      `A run with no final batch and no traffic since the cutoff is <strong>truncated</strong>: kept, never deleted. ` +
      `<em>claimed</em> is what the batches said they carried, <em>stored</em> is what we persisted.`, true) +
    `<footer class="muted foot">vitals · read listener is loopback-only and serves no write route · ` +
    `ingest listens separately on :4781 and serves no page · this page never renders the credential.</footer>\n` +
    `</main>\n</body>\n</html>\n`
  );
}

export const DASHBOARD_CSS = `:root {
  --bg: #f5f5f7;
  --surface: #ffffff;
  --inset: #f2f2f7;
  --ink: #1d1d1f;
  --muted: #6e6e73;
  --accent: #d70015;
  --line: #d2d2d7;
  --band: #1d1d1f;
  --band-ink: #f5f5f7;
  --band-muted: #a1a1a6;
  --ok: #1b7a36;
  --warn: #8a5300;
  --bad: #d70015;
  --warn-bg: #fff3d1;
  --move-a: #d70038;
  --exer-a: #2f8a00;
  --stand-a: #007c88;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #000000;
  --surface: #1c1c1e;
  --inset: #2c2c2e;
  --ink: #f5f5f7;
  --muted: #a1a1a6;
  --accent: #ff453a;
  --line: #38383a;
  --band: #1c1c1e;
  --band-ink: #f5f5f7;
  --band-muted: #a1a1a6;
  --ok: #30d158;
  --warn: #ffd60a;
  --bad: #ff453a;
  --warn-bg: #2b2410;
  --move-a: #fa114f;
  --exer-a: #7ae82a;
  --stand-a: #1ad4e2;
} }
/* Layout. Below 720 px every .grid table stacks into label | value rows (the data-k labels), so the document never exceeds the viewport. */
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
.page { max-width: var(--page-max); margin: 0 auto; padding: var(--page-pad); }
.top { background: var(--top-bg); color: var(--top-ink); border-bottom: 1px solid var(--top-line); }
.top-row { max-width: var(--page-max); margin: 0 auto; padding: 14px var(--page-x) 0; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.top-meta { max-width: var(--page-max); margin: 0 auto; padding: 4px var(--page-x) 12px; color: var(--top-muted); }
h1 { margin: 0; }
.top .muted, .top-reason { color: var(--top-muted); }
.grow { flex: 1; }
.top-link { color: var(--top-ink); text-decoration: none; } .top-link:hover { text-decoration: underline; }
.muted { color: var(--muted); }
code { font-family: var(--font-mono); font-size: .92em; color: var(--ink); }
.status { font-weight: 600; display: inline-flex; align-items: center; }
.status-ok { color: var(--top-ok); } .status-warn { color: var(--top-warn); } .status-empty { color: var(--top-muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; background: var(--muted); vertical-align: middle; flex: none; }
.dot-ok { background: var(--ok); } .dot-amber { background: var(--warn); } .dot-unknown { background: var(--muted); }
.status .dot-ok { background: var(--top-ok); }
.panel { margin-top: var(--section-gap); }
.card { background: var(--surface); border-radius: var(--radius); padding: var(--card-pad); }
h2 { margin: 0 0 8px; }
.note { color: var(--muted); margin: 0 0 14px; max-width: 72ch; }
.empty { color: var(--muted); font-style: italic; }
.banner p { max-width: 72ch; }
.banner h2 { margin-bottom: 10px; }
.strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--gap); }
.tile { background: var(--surface); border-radius: var(--radius); padding: var(--card-pad); display: flex; flex-direction: column; min-width: 0; }
.tile-label { color: var(--muted); }
.tile-value { margin: 6px 0 4px; letter-spacing: -.02em; }
.tile-sub { color: var(--muted); margin-top: auto; overflow-wrap: anywhere; }
.tile-ok .tile-label::before, .tile-warn .tile-label::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: middle; }
.tile-ok .tile-label::before { background: var(--ok); } .tile-warn .tile-label::before { background: var(--warn); }
.tile-warn .tile-value { color: var(--warn); }
.tile-wide { grid-column: span 2; }
.table-wrap { max-width: 100%; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
.grid th { text-align: left; color: var(--muted); font-weight: 600; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); }
.grid td { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
.grid th:last-child, .grid td:last-child { padding-right: 0; }
.grid tbody tr:last-child td { border-bottom: 0; }
.grid th.num, .num { text-align: right; white-space: nowrap; }
.grid td.num, .grid th.num { padding-left: 12px; }
.freshness td.t-last, .freshness td.t-vs { text-align: left; }
.freshness td.t-cad { text-align: left; white-space: nowrap; }
.freshness td.t-last .muted { display: block; }
.freshness td.t-vs { white-space: nowrap; }
.path { color: var(--muted); font-family: var(--font-mono); font-size: .92em; }
.t-name { white-space: normal; min-width: 14ch; }
.t-full { display: block; margin-left: 15px; font-family: var(--font-mono); overflow-wrap: anywhere; }
.state-word { font-weight: 600; }
.state-ok .state-word { color: var(--ok); }
.state-amber td { background: var(--warn-bg); }
.state-amber .state-word, .state-amber .t-name { color: var(--warn); }
.state-amber .dot { background: var(--warn); }
.state-unknown .dot { background: var(--muted); }
.outcome-unauthorised td { color: var(--bad); } .outcome-quarantined td { color: var(--warn); }
.spark-cell { width: 150px; }
.spark { display: block; }
.spark-area { fill: var(--spark-fill); stroke: none; }
.spark-line { fill: none; stroke: var(--spark); stroke-width: 1.4; stroke-linejoin: round; }
.spark-dot { fill: var(--spark); }
.state-amber .spark-line { stroke: var(--warn); } .state-amber .spark-dot { fill: var(--warn); } .state-amber .spark-area { fill: var(--warn-fill); }
:root { --warn-fill: rgba(138,83,0,.16); } @media (prefers-color-scheme: dark) { :root { --warn-fill: rgba(255,214,10,.16); } }
.readings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); }
.reading { display: flex; flex-direction: column; }
.reading-figure { margin-bottom: 12px; }
.reading-figure .spark { width: 100%; height: auto; }
.reading-sub { margin-top: 6px; }
.mini td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); } .mini td:last-child { padding-right: 0; }
.mini tr:last-child td { border-bottom: 0; }
.mini .day { color: var(--muted); }
.reading .caption { color: var(--muted); margin: 10px 0 0; }
.foot { margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--line); }
@media (max-width: 1023px) { .strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } .readings { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 719px) {
  .strip { grid-template-columns: minmax(0, 1fr); } .tile-wide { grid-column: span 1; }
  .grid thead { display: none; }
  .grid, .grid tbody, .grid tr, .grid td { display: block; width: 100%; }
  .grid tr { padding: 8px 0 10px; border-bottom: 1px solid var(--line); }
  .grid tbody tr:last-child { border-bottom: 0; }
  .grid td { border: 0; padding: 3px 0; text-align: left; white-space: normal !important; display: grid; grid-template-columns: 9em 1fr; gap: 10px; align-items: baseline; }
  .grid td::before { content: attr(data-k); color: var(--muted); font-weight: 400; }
  .grid td.num, .grid th.num { padding-left: 0; }
  .freshness td.t-last .muted { grid-column: 2; }
  .grid td.t-name { display: block; font-weight: 600; margin-bottom: 4px; } .grid td.t-name::before { content: none; }
  .state-amber td { background: none; } .state-amber { background: var(--warn-bg); margin: 0 calc(-1 * var(--card-pad)); padding-left: var(--card-pad); padding-right: var(--card-pad); width: auto; }
  .spark-cell { width: auto; } .spark-cell .spark { max-width: 100%; } .grid td.spark-cell { align-items: center; }
  .t-full { display: none; }
}
@media (prefers-color-scheme: dark) { .card, .tile { border: 1px solid var(--line); } }

/* Type scale and spacing: grey page, white 18 px cards. Sans with tabular numerals; mono only for identifiers and paths. */
:root { --page-max: 1200px; --page-x: 24px; --page-pad: 0 var(--page-x) 48px; --gap: 16px; --card-pad: 20px 22px; --radius: 18px; --section-gap: 28px;
  --font-body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif; --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --top-bg: var(--surface); --top-ink: var(--ink); --top-muted: var(--muted); --top-line: var(--line); --top-ok: var(--ok); --top-warn: var(--warn);
  --spark: var(--muted); --spark-fill: var(--inset); }
body { font-size: 15px; line-height: 1.5; }
.top { position: sticky; top: 0; z-index: 2; }
h1 { font-size: 19px; font-weight: 700; letter-spacing: -.01em; }
h2 { font-size: 21px; font-weight: 600; line-height: 1.3; }
.status, .top-reason, .top-link { font-size: 15px; }
.top-meta { font-size: 13px; }
.note { font-size: 15px; }
.card { box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.tile-label { font-size: 13px; font-weight: 600; }
.tile-value { font-size: 30px; font-weight: 700; }
.tile-sub { font-size: 13px; }
.grid th { font-size: 13px; font-weight: 600; }
.grid td { font-size: 14px; }
.t-full, .path { font-size: 12px; }
.mini td { font-size: 15px; } .reading-sub, .reading .caption { font-size: 13px; }
.foot { font-size: 13px; }
@media (max-width: 719px) { :root { --page-x: 14px; --card-pad: 16px 16px; } h2 { font-size: 19px; } .tile-value { font-size: 28px; } .note { font-size: 14px; } }
`;
