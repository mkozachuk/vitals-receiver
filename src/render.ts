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

function tile(label: string, value: string, sub: string, tone: "ok" | "warn" | "muted" | "plain" = "plain"): string {
  return (
    `<div class="tile tile-${tone}">` +
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

function typeRow(t: TypeFreshness, now: Date): string {
  const cadence =
    t.medianGapSeconds === null
      ? "not enough history"
      : t.p90GapSeconds !== null && t.p90GapSeconds > t.medianGapSeconds * 2
        ? `every ~${formatDuration(t.medianGapSeconds)}, in bursts ~${formatDuration(t.p90GapSeconds)} apart`
        : `every ~${formatDuration(t.medianGapSeconds)}`;
  const stateTitle =
    t.thresholdSeconds === null ? "no cadence yet" : `amber above ${formatDuration(t.thresholdSeconds)} behind`;
  const lag = t.lagSeconds === null ? "-" : t.lagSeconds < 60 ? "current" : `${formatDuration(t.lagSeconds)} behind`;
  const state = t.state === "amber" ? "stopped?" : t.state === "ok" ? "ok" : "new";
  return (
    `<tr class="state-${t.state}">` +
    `<td class="t-name"><span class="dot dot-${t.state}"></span>${escapeHtml(shortType(t.type))}` +
    (shortType(t.type) === t.type ? "" : `<span class="muted t-full">${escapeHtml(t.type)}</span>`) +
    `</td>` +
    `<td class="num" title="${escapeHtml(t.lastSampleAt ?? "")}">${localStamp(t.lastSampleAt)}` +
    `<span class="muted"> (${escapeHtml(relativeTime(t.lastSampleAt, now))})</span></td>` +
    `<td class="num">${escapeHtml(lag)}</td>` +
    `<td class="num">${escapeHtml(cadence)}</td>` +
    `<td class="num">${formatNumber(t.count7d)}</td>` +
    `<td class="num">${formatNumber(t.total)}</td>` +
    `<td class="spark-cell">${sparkline(t.spark, { label: `${shortType(t.type)} daily counts` })}</td>` +
    `<td class="num state-word" title="${escapeHtml(stateTitle)}">${escapeHtml(state)}</td>` +
    `</tr>`
  );
}

function dayTable(rows: DayValue[], unit: string, decimals: number): string {
  const shown = [...rows].reverse().filter((r) => r.samples > 0 || r.value > 0);
  if (shown.length === 0) return "";
  return (
    `<table class="mini"><tbody>` +
    shown
      .map(
        (r) =>
          `<tr><td class="day">${escapeHtml(r.day)}</td>` +
          `<td class="num">${escapeHtml(decimals === 0 ? formatNumber(r.value) : r.value.toFixed(decimals))} ` +
          `<span class="muted">${escapeHtml(unit)}</span></td>` +
          `<td class="num muted">${formatNumber(r.samples)} samples</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

function section(title: string, body: string, note?: string): string {
  return (
    `<section class="panel">` +
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
    tile("database", escapeHtml(formatBytes(s.dbBytes)), escapeHtml(s.dbPath), "muted"),
  ].join("");

  const freshness =
    model.types.length === 0
      ? EMPTY("No samples yet, so there is no cadence to judge. This table fills in on the first export.")
      : `<table class="grid"><thead><tr>` +
        `<th>type</th><th>last sample</th><th>vs newest</th><th>observed cadence</th>` +
        `<th>7d</th><th>total</th><th>last ${model.sparkDays}d</th><th>state</th>` +
        `</tr></thead><tbody>` +
        model.types.map((t) => typeRow(t, now)).join("") +
        `</tbody></table>`;

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
      : `<div class="reading">` +
        `<div class="reading-figure">${sparkline(
          model.steps.map((d) => d.value),
          { width: 260, height: 48, label: "steps per day" },
        )}<div class="muted">${formatNumber(stepsTotal)} steps summed over ${stepsDays} day(s) with data</div></div>` +
        dayTable(model.steps, "steps", 0) +
        `</div>`;

  const hrWithData = model.restingHr.filter((d) => d.samples > 0);
  const hrLatest = hrWithData.at(-1);
  const hrBody =
    hrWithData.length === 0
      ? EMPTY("No resting heart rate samples in this window.")
      : `<div class="reading">` +
        `<div class="reading-figure">${sparkline(
          model.restingHr.map((d) => d.value),
          { width: 260, height: 48, label: "resting heart rate" },
        )}<div class="muted">latest ${escapeHtml((hrLatest?.value ?? 0).toFixed(0))} bpm on ${escapeHtml(
          hrLatest?.day ?? "-",
        )} · min ${escapeHtml(Math.min(...hrWithData.map((d) => d.value)).toFixed(0))} · max ${escapeHtml(
          Math.max(...hrWithData.map((d) => d.value)).toFixed(0),
        )} over ${model.hrDays}d</div></div>` +
        dayTable(model.restingHr, "bpm avg", 0) +
        `</div>`;

  const sleepWithData = model.sleep.filter((d) => d.samples > 0);
  const sleepBody =
    sleepWithData.length === 0
      ? EMPTY("No sleep samples in this window.")
      : `<div class="reading">` +
        `<div class="reading-figure">${sparkline(
          model.sleep.map((d) => d.value),
          { width: 260, height: 48, label: "sleep hours per night" },
        )}<div class="muted">filed under the day you woke up · asleep stages only, inBed and awake excluded</div></div>` +
        dayTable(model.sleep, "h", 1) +
        `</div>`;

  const workoutsBody =
    model.workouts.length === 0
      ? EMPTY("No workouts stored.")
      : `<table class="grid"><thead><tr><th>started</th><th>activity</th><th>duration</th><th>distance</th><th>energy</th></tr></thead><tbody>` +
        model.workouts
          .map(
            (w) =>
              `<tr><td>${escapeHtml(localStamp(w.startAt))}</td>` +
              `<td>${escapeHtml(w.name ?? `activityType ${w.activityType ?? "?"}`)}</td>` +
              `<td class="num">${escapeHtml(w.durationSeconds === null ? "-" : formatDuration(w.durationSeconds))}</td>` +
              `<td class="num">${escapeHtml(
                w.distanceMeters === null ? "-" : `${(w.distanceMeters / 1000).toFixed(2)} km`,
              )}</td>` +
              `<td class="num">${escapeHtml(w.energyKcal === null ? "-" : `${Math.round(w.energyKcal)} kcal`)}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`;

  const deliveriesBody =
    model.deliveries.length === 0
      ? EMPTY("The delivery log is empty: nothing has reached this receiver, not even a rejected request.")
      : `<table class="grid"><thead><tr><th>when</th><th>from</th><th>outcome</th><th>status</th><th>samples</th><th>bytes</th><th>path</th><th>note</th></tr></thead><tbody>` +
        model.deliveries
          .map(
            (d) =>
              `<tr class="outcome-${escapeHtml(d.outcome)}">` +
              `<td title="${escapeHtml(d.receivedAt)}">${escapeHtml(localStamp(d.receivedAt))}</td>` +
              `<td>${escapeHtml(d.remoteAddr ?? "-")}</td>` +
              `<td>${escapeHtml(d.outcome)}</td>` +
              `<td class="num">${escapeHtml(d.status)}</td>` +
              `<td class="num">${formatNumber(d.sampleCount)}</td>` +
              `<td class="num">${escapeHtml(formatBytes(d.bytes))}</td>` +
              `<td class="path">${escapeHtml(d.path)}</td>` +
              `<td class="muted">${escapeHtml(d.note ?? "")}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`;

  const runsBody =
    model.runs.length === 0
      ? EMPTY("No export run has been seen yet.")
      : `<table class="grid"><thead><tr><th>export</th><th>span</th><th>batches</th><th>claimed</th><th>stored</th><th>last seen</th><th>state</th></tr></thead><tbody>` +
        model.runs
          .map(
            (r) =>
              `<tr class="${r.truncated ? "state-amber" : "state-ok"}">` +
              `<td class="path" title="${escapeHtml(r.exportId)}">${escapeHtml(r.exportId.slice(0, 8))}</td>` +
              `<td title="${r.span.source}">${escapeHtml(localStamp(r.span.start))} → ${escapeHtml(localStamp(r.span.end))}</td>` +
              `<td class="num">${formatNumber(r.batchesSeen)} / ${formatNumber(r.maxSequence)}${
                r.finalSeen ? "" : " <span class=\"muted\">no final</span>"
              }</td>` +
              `<td class="num">${formatNumber(r.sampleCount)}</td>` +
              `<td class="num">${formatNumber(r.storedCount)}</td>` +
              `<td>${escapeHtml(localStamp(r.lastSeen))}</td>` +
              `<td>${r.truncated ? "truncated" : r.finalSeen ? "complete" : "in flight"}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`;

  const emptyBanner = empty
    ? `<section class="panel banner">` +
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
    `<header class="top">` +
    `<h1>vitals</h1>` +
    `<span class="status status-${s.state}"><span class="dot dot-${s.state === "warn" ? "amber" : s.state === "ok" ? "ok" : "unknown"}"></span>${escapeHtml(headline)}</span>` +
    `<span class="muted">${escapeHtml(s.stateReason)}</span>` +
    `<span class="grow"></span>` +
    `<a class="muted" href="/">&larr; today</a>` +
    `<span class="muted">rendered ${escapeHtml(localStamp(model.generatedAt))} local · read-only · loopback</span>` +
    `</header>\n` +
    emptyBanner +
    section("Is the pipe alive?", `<div class="strip">${tiles}</div>`,
      `Delivery health first, body data second: the failure mode of this whole category is <strong>silent ` +
      `non-delivery</strong>, and a dashboard full of heart rates cannot tell you that nothing arrived. ` +
      `<strong>samples in 24h counts arrivals</strong> (<code>received_at</code>), not sample time — a backfill ` +
      `of March lands in today's number.`) +
    section(`Freshness per metric type`, freshness, freshnessNote) +
    section("Steps per day", stepsBody, COALESCING_NOTE) +
    section(`Resting heart rate (${model.hrDays}d, daily average)`, hrBody) +
    section("Sleep", sleepBody) +
    section("Workouts", workoutsBody) +
    section("Delivery log", deliveriesBody,
      `Every request that reached us, including the ones we refused. healthd never reads our response body, ` +
      `so this table is the only record of our side of the conversation.`) +
    section("Export runs", runsBody,
      `A run with no final batch and no traffic since the cutoff is <strong>truncated</strong>: kept, never deleted. ` +
      `<em>claimed</em> is what the batches said they carried, <em>stored</em> is what we persisted.`) +
    `<footer class="muted">vitals · read listener is loopback-only and serves no write route · ` +
    `ingest listens separately on :4781 and serves no page · this page never renders the credential.</footer>\n` +
    `</body>\n</html>\n`
  );
}

export const DASHBOARD_CSS = `:root {
  --bg: #0d1117;
  --panel: #151b23;
  --line: #222b36;
  --text: #c9d1d9;
  --muted: #7d8895;
  --ok: #3fb950;
  --amber: #d29922;
  --bad: #f85149;
  --accent: #58a6ff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 18px 22px 40px;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.45 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
h1 { font-size: 15px; margin: 0; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
h2 { font-size: 12px; margin: 0 0 8px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.grow { flex: 1; }
.muted { color: var(--muted); }
code { color: var(--accent); }
.status { font-weight: 600; }
.status-ok { color: var(--ok); }
.status-warn { color: var(--amber); }
.status-empty { color: var(--muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--muted); vertical-align: middle; }
.dot-ok { background: var(--ok); }
.dot-amber { background: var(--amber); }
.dot-unknown { background: var(--muted); }
.panel { margin-top: 22px; }
.banner { border-left: 3px solid var(--accent); padding-left: 12px; }
.note { color: var(--muted); margin: 0 0 10px; max-width: 108ch; }
.empty { color: var(--muted); font-style: italic; }
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: 4px; padding: 10px 12px; }
.tile-ok { border-left-color: var(--ok); }
.tile-warn { border-left-color: var(--amber); }
.tile-muted { border-left-color: var(--muted); }
.tile-label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.tile-value { font-size: 22px; margin: 4px 0 2px; }
.tile-sub { font-size: 11px; color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
.grid th { text-align: left; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); }
.grid td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
.grid tr:hover td { background: #131920; }
.num { text-align: right; white-space: nowrap; }
.path { color: var(--muted); }
.t-name { white-space: nowrap; }
.t-full { display: block; font-size: 10px; margin-left: 14px; }
.state-amber .state-word, .state-amber .t-name { color: var(--amber); }
.state-amber .dot { background: var(--amber); }
.state-unknown .dot { background: var(--muted); }
.outcome-unauthorised td { color: var(--bad); }
.outcome-quarantined td { color: var(--amber); }
.spark-cell { width: 150px; }
.spark { display: block; }
.spark-area { fill: rgba(88, 166, 255, .16); stroke: none; }
.spark-line { fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-linejoin: round; }
.spark-dot { fill: var(--accent); }
.reading { display: flex; gap: 26px; flex-wrap: wrap; align-items: flex-start; }
.reading-figure { min-width: 260px; }
.mini td { padding: 2px 14px 2px 0; }
.mini { width: auto; }
.day { color: var(--muted); }
footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 11px; }
`;
