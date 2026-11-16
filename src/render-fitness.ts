import type { DayPoint, Fitness, MetricCard, Ring, SourceTotal, WeekDay } from "./fitness.js";
import { escapeHtml, formatBytes, formatDuration, formatNumber, localStamp, relativeTime } from "./render.js";

/**
 * The fitness page: server-rendered HTML and hand-rolled SVG, no JavaScript,
 * no webfont, no network fetch of any kind. The CSP is `default-src 'none'`
 * and an offline example must stay offline.
 *
 * Two consequences of that constraint are worth knowing before editing:
 *
 *  1. `style-src 'self'` blocks inline style ATTRIBUTES as well as inline
 *     <style> elements. Every colour therefore arrives through a class, and
 *     every geometry through an SVG presentation attribute -- which is markup,
 *     not CSS, and so is not subject to the policy.
 *  2. The ring fill animation has no dynamic CSS to hang on. It is a keyframe
 *     with a `from` and no `to`: the implicit end value is the element's own
 *     computed stroke-dashoffset, which is exactly the presentation attribute
 *     we rendered. One keyframe per ring radius, all of them constants.
 */

const RING_GEOMETRY: Record<string, { r: number }> = {
  move: { r: 92 },
  exercise: { r: 70 },
  stand: { r: 48 },
  sleep: { r: 48 },
};

const RING_CLASS: Record<string, string> = {
  move: "move",
  exercise: "exer",
  stand: "stand",
  sleep: "sleepring",
};

const CARD_COLOUR: Record<string, string> = {
  steps: "steps",
  distance: "distance",
  flights: "flights",
  heart: "heart",
  sleep: "sleep",
  workouts: "exer",
  energy: "move",
};

/** Cards that span two grid tracks. With nine cards on three tracks these
 *  three make the rows close (3 / 2+1 / 2+1 / 1+2) with no orphan. */
const WIDE_CARDS = new Set(["heart", "workouts", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN"]);

const circumference = (r: number): number => Math.round(2 * Math.PI * r * 100) / 100;

const round = (v: number): string => String(Math.round(v * 100) / 100);

function fmt(value: number, decimals: number): string {
  return decimals === 0 ? formatNumber(value) : value.toFixed(decimals);
}

/** "18 Sep" -- short enough for a caption, unambiguous in any locale. */
function shortDay(iso: string | null): string {
  if (iso === null) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`;
}

// --------------------------------------------------------------------------
// rings
// --------------------------------------------------------------------------

function ringArcs(ring: Ring, index: number): string {
  const geo = RING_GEOMETRY[ring.key] ?? { r: 48 };
  const cls = RING_CLASS[ring.key] ?? "stand";
  const c = circumference(geo.r);
  const track = `<circle class="ring-track ring-track-${cls}${ring.present ? "" : " ring-ghost"}" cx="110" cy="110" r="${geo.r}"></circle>`;
  if (!ring.present) return `<g class="ring ring-${cls}">${title(ring.title)}${track}</g>`;

  const first = Math.min(ring.progress, 1);
  const offset = round(c * (1 - first));
  const arcs =
    `<circle class="ring-arc ring-arc-${cls}" cx="110" cy="110" r="${geo.r}" stroke="url(#g-${cls})" ` +
    `stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>`;
  // Over the goal: a second arc for the remainder, drawn on top with a soft
  // shadow so the overlap reads as a second lap. Two laps is the cap for
  // drawing; the numeral underneath always tells the literal truth.
  const extra = Math.min(Math.max(ring.progress - 1, 0), 1);
  const lap =
    extra > 0
      ? `<circle class="ring-arc ring-arc-${cls} ring-lap" cx="110" cy="110" r="${geo.r}" stroke="url(#g-${cls})" ` +
        `stroke-dasharray="${c}" stroke-dashoffset="${round(c * (1 - extra))}"></circle>`
      : "";
  return `<g class="ring ring-${cls}" data-index="${index}">${title(ring.title)}${track}${arcs}${lap}</g>`;
}

const title = (text: string): string => `<title>${escapeHtml(text)}</title>`;

function gradients(): string {
  const one = (key: string): string =>
    `<linearGradient id="g-${key}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" class="stop-${key}-a"></stop><stop offset="100%" class="stop-${key}-b"></stop>` +
    `</linearGradient>`;
  return (
    `<defs>${["move", "exer", "stand", "sleepring"].map(one).join("")}` +
    `<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line class="hatch-line" x1="0" y1="0" x2="0" y2="6"></line></pattern></defs>`
  );
}

function ringsBlock(model: Fitness): string {
  if (model.rings.length === 0) return "";
  const svg =
    `<svg class="rings" viewBox="0 0 220 220" role="img" aria-label="${escapeHtml(
      model.rings.map((r) => r.title).join(". "),
    )}">` +
    gradients() +
    `<g class="rings-rotate">${model.rings.map((r, i) => ringArcs(r, i)).join("")}</g>` +
    `</svg>`;

  const readout = model.rings
    .map((r) => {
      const cls = RING_CLASS[r.key] ?? "stand";
      const value = r.value === null ? "&mdash;" : escapeHtml(fmt(r.value, r.decimals));
      return (
        `<div class="readout-row${r.present ? "" : " readout-ghost"}">` +
        `<div class="readout-label">${escapeHtml(r.label)}</div>` +
        `<div class="readout-value"><span class="readout-num readout-num-${cls}">${value}</span>` +
        `<span class="readout-goal">/${escapeHtml(fmt(r.goal, 0))} ${escapeHtml(r.unit.toUpperCase())}</span></div>` +
        `</div>`
      );
    })
    .join("");

  const notes = model.ringNotes
    .map((n) => `<p class="footnote">${escapeHtml(n)}</p>`)
    .join("");

  // An empty day must read as "nothing yet", not as a page still loading. Only
  // when every ring reads a literal 0: a ring that is not exported reads a dash
  // and has its own note above.
  const allZero = model.rings.every((r) => r.value === 0);
  const emptyNote = allZero
    ? `<p class="caption rings-note">No activity recorded yet today. The rings fill as deliveries arrive.</p>`
    : "";

  return (
    `<section class="card rings-card" aria-label="Today's rings">` +
    `<div class="rings-wrap">${svg}<div class="readout">${readout}</div></div>` +
    emptyNote +
    notes +
    `</section>`
  );
}

// --------------------------------------------------------------------------
// week strip
// --------------------------------------------------------------------------

function weekRings(day: WeekDay): string {
  const radii = [16, 11, 6];
  const parts = day.rings
    .map((r, i) => {
      const geo = radii[i] ?? 6;
      const cls = RING_CLASS[r.key] ?? "stand";
      const c = circumference(geo);
      if (day.beforeData || day.future || !r.present) {
        return `<circle class="mini-track mini-dotted" cx="24" cy="24" r="${geo}"></circle>`;
      }
      const offset = round(c * (1 - Math.min(r.progress, 1)));
      return (
        `<circle class="mini-track mini-track-${cls}" cx="24" cy="24" r="${geo}"></circle>` +
        `<circle class="mini-arc mini-arc-${cls}" cx="24" cy="24" r="${geo}" ` +
        `stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>`
      );
    })
    .join("");
  const label = day.future
    ? `${day.day}: still to come`
    : day.beforeData
      ? `${day.day}: before this store's first sample`
      : `${day.day}: ${day.rings.map((r) => `${r.key} ${Math.round(r.progress * 100)}%`).join(", ")}`;
  return (
    `<svg class="mini" viewBox="0 0 48 48" role="img" aria-label="${escapeHtml(label)}">` +
    `<g class="rings-rotate-mini">${parts}</g></svg>`
  );
}

function weekStrip(model: Fitness): string {
  if (model.week.length === 0) return "";
  const days = model.week
    .map(
      (d) =>
        `<div class="week-day${d.today ? " week-today" : ""}">` +
        weekRings(d) +
        `<div class="week-initial">${escapeHtml(d.initial)}</div></div>`,
    )
    .join("");
  return `<section class="card week" aria-label="This week, Monday first">${days}</section>`;
}

// --------------------------------------------------------------------------
// charts
// --------------------------------------------------------------------------

const BAR_W = 280;
const BAR_H = 64;

function barChart(points: DayPoint[], colour: string, goal: number | null, label: string, decimals: number): string {
  const n = Math.max(points.length, 1);
  const step = BAR_W / n;
  const width = Math.max(step - 3, 2);
  const max = Math.max(...points.map((p) => p.value), goal ?? 0, 0);
  const scale = (v: number): number => (max <= 0 ? 0 : (v / max) * (BAR_H - 6));

  const rects = points
    .map((p, i) => {
      const x = round(i * step + 1.5);
      if (!p.present) return "";
      const h = Math.max(scale(p.value), 2);
      const y = round(BAR_H - h);
      const base =
        `<rect class="bar bar-${colour}${p.partial ? " bar-partial" : ""}" x="${x}" y="${y}" ` +
        `width="${round(width)}" height="${round(h)}" rx="3"></rect>`;
      // Today is not over. The bar is drawn faint and hatched, and today is
      // excluded from every average -- without this, every morning reads as a
      // collapse and an example that lies before lunch is worthless.
      const hatch = p.partial
        ? `<rect class="bar-hatch" x="${x}" y="${y}" width="${round(width)}" height="${round(h)}" rx="3" fill="url(#hatch)"></rect>`
        : "";
      return base + hatch;
    })
    .join("");

  const goalLine =
    goal === null || max <= 0
      ? ""
      : `<line class="goal-line" x1="0" y1="${round(BAR_H - scale(goal))}" x2="${BAR_W}" y2="${round(
          BAR_H - scale(goal),
        )}"></line>`;

  const summary = points
    .filter((p) => p.present)
    .slice(-5)
    .map((p) => `${p.day} ${fmt(p.value, decimals)}`)
    .join(", ");

  return (
    `<svg class="chart" viewBox="0 0 ${BAR_W} ${BAR_H}" role="img" ` +
    `aria-label="${escapeHtml(`${label}, last ${points.length} days`)}">` +
    `<title>${escapeHtml(`${label}. Most recent: ${summary || "no data"}`)}</title>` +
    goalLine +
    rects +
    `</svg>`
  );
}

/**
 * Body mass does not start at zero. Drawn as zero-based bars, a 1.5 kg spread
 * over 74 kg is fourteen identical full-height slabs -- a chart carrying no
 * information at all. So the ranged metrics get a line over their own min-max
 * window instead, with the window named in the accessible title so the zoom is
 * never mistaken for a collapse.
 */
function lineChart(points: DayPoint[], label: string, decimals: number, unit: string): string {
  const present = points.filter((p) => p.present);
  if (present.length === 0) return "";
  const lo = Math.min(...present.map((p) => p.value));
  const hi = Math.max(...present.map((p) => p.value));
  const pad = (hi - lo) * 0.18 || Math.max(Math.abs(hi) * 0.02, 0.5);
  const top = hi + pad;
  const bottom = lo - pad;
  const xOf = (i: number): number => (i / Math.max(points.length - 1, 1)) * (BAR_W - 6) + 3;
  const yOf = (v: number): number => BAR_H - 4 - ((v - bottom) / (top - bottom || 1)) * (BAR_H - 8);
  const pts = points
    .map((p, i) => (p.present ? `${round(xOf(i))},${round(yOf(p.value))}` : null))
    .filter((p): p is string => p !== null);
  const last = present[present.length - 1] as DayPoint;
  const lastIndex = points.lastIndexOf(last);
  return (
    `<svg class="chart" viewBox="0 0 ${BAR_W} ${BAR_H}" role="img" ` +
    `aria-label="${escapeHtml(`${label}, ${fmt(lo, decimals)} to ${fmt(hi, decimals)} ${unit}`)}">` +
    `<title>${escapeHtml(`${label}: ${fmt(lo, decimals)}-${fmt(hi, decimals)} ${unit} over ${points.length} days`)}</title>` +
    `<polyline class="line line-generic" points="${pts.join(" ")}"></polyline>` +
    `<circle class="line-dot" cx="${round(xOf(lastIndex))}" cy="${round(yOf(last.value))}" r="2.5"></circle>` +
    `</svg>`
  );
}

function heartChart(card: MetricCard): string {
  const days = card.heart?.days ?? [];
  if (days.length === 0) return "";
  const W = 560;
  const H = 96;
  const axis = card.series.map((s) => s.day);
  const xOf = (day: string): number => (axis.indexOf(day) / Math.max(axis.length - 1, 1)) * (W - 6) + 3;
  const rawLo = Math.min(...days.map((d) => d.min));
  const rawHi = Math.max(...days.map((d) => d.max));
  // Resting heart rate barely moves, so an unpadded range pins the band's
  // lower edge to the floor and it reads as an area chart rather than a range.
  const pad = (rawHi - rawLo) * 0.1 || 1;
  const lo = rawLo - pad;
  const hi = rawHi + pad;
  const yOf = (v: number): number => (hi <= lo ? H / 2 : H - 6 - ((v - lo) / (hi - lo)) * (H - 12));

  const top = days.map((d) => `${round(xOf(d.day))},${round(yOf(d.max))}`).join(" ");
  const bottom = [...days].reverse().map((d) => `${round(xOf(d.day))},${round(yOf(d.min))}`).join(" ");
  const mean = days.map((d) => `${round(xOf(d.day))},${round(yOf(d.mean))}`).join(" ");

  return (
    `<svg class="chart chart-tall" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="${escapeHtml(`Heart rate over ${card.series.length} days, ${Math.round(rawLo)} to ${Math.round(rawHi)} bpm`)}">` +
    `<title>${escapeHtml(`Heart rate range ${Math.round(rawLo)}-${Math.round(rawHi)} bpm, daily mean line`)}</title>` +
    `<polygon class="hr-band" points="${top} ${bottom}"></polygon>` +
    `<polyline class="hr-mean" points="${mean}"></polyline>` +
    `</svg>`
  );
}

function sleepChart(card: MetricCard): string {
  const nights = card.sleep?.nights ?? [];
  if (nights.length === 0) return "";
  const stages = card.sleep?.stagesPresent === true;
  const n = Math.max(nights.length, 1);
  const step = BAR_W / n;
  const width = Math.max(step - 3, 2);
  const totals = nights.map((x) => (stages ? x.deep + x.core + x.rem + x.unspecified : x.inBed));
  const max = Math.max(...totals, 1);
  const scale = (v: number): number => (v / max) * (BAR_H - 6);

  const bars = nights
    .map((night, i) => {
      const x = round(i * step + 1.5);
      const order: [string, number][] = stages
        ? [
            ["deep", night.deep],
            ["core", night.core],
            ["rem", night.rem],
            ["unspec", night.unspecified],
          ]
        : [["inbed", night.inBed]];
      let y = BAR_H;
      const parts = order
        .filter(([, v]) => v > 0)
        .map(([name, v]) => {
          const h = Math.max(scale(v), 1.5);
          y -= h;
          return `<rect class="bar bar-sleep-${name}" x="${x}" y="${round(y)}" width="${round(width)}" height="${round(h)}" rx="2"></rect>`;
        })
        .join("");
      return parts;
    })
    .join("");

  return (
    `<svg class="chart" viewBox="0 0 ${BAR_W} ${BAR_H}" role="img" ` +
    `aria-label="${escapeHtml(`${card.label} per night, last ${nights.length} nights`)}">` +
    `<title>${escapeHtml(`${card.label} per night, tallest ${max.toFixed(1)} h`)}</title>${bars}</svg>`
  );
}

function energyChart(card: MetricCard): string {
  const days = card.energy?.days ?? [];
  if (days.length === 0) return "";
  const n = Math.max(days.length, 1);
  const step = BAR_W / n;
  const width = Math.max(step - 3, 2);
  const max = Math.max(...days.map((d) => d.active + d.basal), 1);
  const scale = (v: number): number => (v / max) * (BAR_H - 6);
  const bars = days
    .map((d, i) => {
      const x = round(i * step + 1.5);
      const hb = scale(d.basal);
      const ha = scale(d.active);
      const yb = round(BAR_H - hb);
      const ya = round(BAR_H - hb - ha);
      return (
        (hb > 0 ? `<rect class="bar bar-basal" x="${x}" y="${yb}" width="${round(width)}" height="${round(hb)}" rx="2"></rect>` : "") +
        (ha > 0 ? `<rect class="bar bar-move" x="${x}" y="${ya}" width="${round(width)}" height="${round(ha)}" rx="2"></rect>` : "")
      );
    })
    .join("");
  return (
    `<svg class="chart" viewBox="0 0 ${BAR_W} ${BAR_H}" role="img" aria-label="Active and resting energy per day">` +
    `<title>Active energy stacked over resting energy, last ${days.length} days</title>${bars}</svg>`
  );
}

// --------------------------------------------------------------------------
// activity glyphs -- four hand-drawn paths, no icon font
// --------------------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  walking: "M9 3.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM7.6 4.6 5 7l1.4 1.4 1.8-1.5.9 2.6-2.8 4.9 1.7 1 3.2-5.3-1-3.1 1.9 1.5V15h2V7.6L9.9 4.6z",
  running: "M11 3.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM6 5.4 3 7.6l1.1 1.6 2.4-1.7 1.4 2.2-3.4 5 1.7 1.1 4-5.9-1.3-2.6 2.3 1.4 1.1 4 1.9-.5-1.3-4.9L8.6 4.6z",
  cycling: "M4 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm10 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM9.6 3.2a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM8 5 5.4 6.8l2.2 2.1.6 4.1h1.6l-.7-4.9L7.6 6.6 9.4 5.6 11 7.4h2.4v-1.6h-1.7L10 3.9z",
  other: "M8 1.2 9.9 6h4.9l-4 3.2 1.6 5L8 11.4 3.6 14.2l1.6-5-4-3.2h4.9z",
};

function glyph(name: string | null): string {
  const key = (name ?? "").toLowerCase();
  const path =
    key.includes("run") ? GLYPHS.running : key.includes("cycl") ? GLYPHS.cycling : key.includes("walk") ? GLYPHS.walking : GLYPHS.other;
  return `<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="${path as string}"></path></svg>`;
}

function titleCase(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// --------------------------------------------------------------------------
// cards
// --------------------------------------------------------------------------

function disclosure(alternatives: SourceTotal[], unit: string, decimals: number): string {
  if (alternatives.length === 0) return "";
  const parts = alternatives
    .map((a) => `${escapeHtml(a.label)} also recorded ${escapeHtml(fmt(a.value, decimals))} ${escapeHtml(unit)}`)
    .join("; ");
  return `${parts} today; showing the higher source rather than the sum.`;
}

function sourceChip(card: MetricCard): string {
  if (card.sourceLabel === null) return "";
  const extra = card.alternatives.length > 0 ? ` &middot; +${card.alternatives.length}` : "";
  return `<span class="chip" title="${escapeHtml(card.source ?? "")}">${escapeHtml(card.sourceLabel)}${extra}</span>`;
}

function workoutList(card: MetricCard): string {
  const list = card.workoutList ?? [];
  if (list.length === 0) return "";
  return (
    `<ul class="workouts">` +
    list
      .map((w) => {
        const bits = [
          w.durationSeconds === null ? null : formatDuration(w.durationSeconds),
          w.distanceMeters === null ? null : `${(w.distanceMeters / 1000).toFixed(1)} km`,
          w.energyKcal === null ? null : `${Math.round(w.energyKcal)} kcal`,
        ].filter((b): b is string => b !== null);
        return (
          `<li class="workout">${glyph(w.name)}` +
          `<span class="workout-name">${escapeHtml(titleCase(w.name ?? `Activity ${w.activityType ?? "?"}`))}</span>` +
          `<span class="workout-stats">${escapeHtml(bits.join(" · "))}</span>` +
          `<span class="workout-when">${escapeHtml(shortDay(w.startAt))}</span></li>`
        );
      })
      .join("") +
    `</ul>`
  );
}

function metricCard(card: MetricCard): string {
  const colour = CARD_COLOUR[card.key] ?? "generic";
  const value = card.headline.value;
  const headValue = value === null ? "&mdash;" : escapeHtml(fmt(value, card.decimals));

  const chart =
    card.kind === "heart"
      ? heartChart(card)
      : card.kind === "sleep"
        ? sleepChart(card)
        : card.kind === "energy"
          ? energyChart(card)
          : card.kind === "workouts"
            ? ""
            : card.kind === "line"
              ? lineChart(card.series, card.label, card.decimals, card.unit)
              : barChart(card.series, colour, card.goal, card.label, card.decimals);

  const captions: string[] = [];
  if (card.kind === "heart" && card.heart?.today != null) {
    const t = card.heart.today;
    captions.push(`Today ${Math.round(t.min)} &middot; ${Math.round(t.mean)} &middot; ${Math.round(t.max)} bpm`);
  }
  if (card.average7d !== null && card.averageLabel.length > 0) {
    captions.push(`${escapeHtml(card.averageLabel)} ${escapeHtml(fmt(card.average7d, card.decimals))}`);
  }
  if (card.daysWithoutData > 0) {
    captions.push(`${card.daysWithoutData} day(s) without data`);
  }
  if (card.state === "amber") {
    captions.push(`last reading ${escapeHtml(shortDay(card.lastSampleAt))}`);
  }
  if (card.note !== null) captions.push(escapeHtml(card.note));
  const disclosed = disclosure(card.alternatives, card.unit, card.decimals);
  if (disclosed.length > 0) captions.push(disclosed);

  return (
    `<article class="card metric metric-${escapeHtml(card.key)}${WIDE_CARDS.has(card.key) ? " metric-wide" : ""}">` +
    `<div class="card-head">` +
    `<span class="card-label"><span class="dot dot-${colour}${card.state === "amber" ? " dot-amber" : ""}"></span>` +
    `${escapeHtml(card.label)}</span>` +
    // When the value is today's, the head says nothing; otherwise it names
    // which day or span the number belongs to, top right, beside the source.
    (card.headline.label === "Today" && value !== null
      ? ""
      : `<span class="metric-when">${escapeHtml(card.headline.label)}</span>`) +
    `${sourceChip(card)}</div>` +
    `<p class="metric-value">${headValue}<span class="metric-unit">${escapeHtml(card.unit)}</span></p>` +
    chart +
    workoutList(card) +
    (captions.length === 0 ? "" : `<p class="caption">${captions.join(" &middot; ")}</p>`) +
    `</article>`
  );
}

// --------------------------------------------------------------------------
// the page
// --------------------------------------------------------------------------

function pill(model: Fitness, now: Date): string {
  const label =
    model.sync.state === "ok" ? `Synced ${relativeTime(model.strip.lastDeliveryAt, now)}` : model.sync.label;
  return (
    `<a class="pill pill-${model.sync.state}" href="/pipe" title="${escapeHtml(model.sync.detail)}">` +
    `<span class="pill-dot"></span>${escapeHtml(label)}<span class="pill-arrow">&rsaquo;</span></a>`
  );
}

function emptyBlock(): string {
  return (
    `<section class="card empty-block">` +
    `<h2>No data yet</h2>` +
    `<p>The receiver is up and reading an empty store. Nothing has arrived &mdash; not even a rejected request.</p>` +
    `<ol class="setup">` +
    `<li>In healthd, point the destination at <code>http://&lt;this-mac&gt;:4781/ingest</code>.</li>` +
    `<li>Set the credential header to the one <code>npm run token:mint</code> printed.</li>` +
    `<li>Tap <strong>Test connection</strong>, then Export.</li>` +
    `</ol>` +
    `<p class="footnote">The probe alone will light the pill above. ` +
    `<a href="/pipe">Delivery &amp; diagnostics &rarr;</a></p>` +
    `</section>`
  );
}

export function renderFitness(model: Fitness): string {
  const now = new Date(model.generatedAt);
  const refresh =
    model.autoRefreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${Math.round(model.autoRefreshSeconds)}">\n`
      : "";

  const banner =
    model.staleBanner === null ? "" : `<p class="banner banner-${model.sync.state}">${escapeHtml(model.staleBanner)}</p>`;

  const body = model.empty
    ? emptyBlock()
    : ringsBlock(model) +
      weekStrip(model) +
      `<div class="grid">${model.cards.map(metricCard).join("")}</div>` +
      (model.notExported.length === 0
        ? ""
        : `<p class="footnote not-exported">Not exported: ${escapeHtml(model.notExported.join(", "))}. ` +
          `These are healthd metric groups that are switched off, not failures.</p>`);

  const span =
    model.span.from === null
      ? "no samples yet"
      : `${escapeHtml(model.span.from.slice(0, 10))} &rarr; ${escapeHtml(model.span.to?.slice(0, 10) ?? "today")}`;

  const footer =
    `<footer class="foot">` +
    `<span>${formatNumber(model.samplesTotal)} samples &middot; ${model.sources.length} source(s) &middot; ` +
    `${span} &middot; store ${escapeHtml(formatBytes(model.dbBytes))}</span>` +
    `<a href="/pipe">Delivery &amp; diagnostics &rarr;</a>` +
    `</footer>`;

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    refresh +
    `<title>vitals &mdash; ${escapeHtml(model.title)}</title>\n` +
    `<link rel="stylesheet" href="/assets/app.css">\n` +
    `</head>\n<body>\n<main class="page">\n` +
    `<header class="head">` +
    `<div class="head-title"><p class="eyebrow">vitals</p><h1>${escapeHtml(model.title)}</h1>` +
    `<p class="date">${escapeHtml(model.dateLabel)}</p></div>` +
    pill(model, now) +
    `</header>\n` +
    banner +
    body +
    footer +
    `<p class="footnote rendered">Rendered ${escapeHtml(localStamp(model.generatedAt))} local &middot; read-only &middot; loopback` +
    (model.autoRefreshSeconds > 0 ? ` &middot; refreshes every ${Math.round(model.autoRefreshSeconds / 60)} min` : "") +
    `</p>\n` +
    `</main>\n</body>\n</html>\n`
  );
}

/**
 * The stylesheet. Light first, dark via prefers-color-scheme: the grey page
 * and white cards of the healthd site, and the black page with #1c1c1e cards
 * on a dark system. /pipe carries the same tokens.
 *
 * Ring circumferences are constants (2*pi*r for r = 92, 70, 48), which is what
 * lets the fill animation exist at all under `style-src 'self'`: the keyframe
 * names the empty state and the element's own presentation attribute is the
 * implicit end. The gradient and hatch references are presentation attributes
 * too (`stroke="url(#g-move)"`), so this constant names no url at all.
 */
export const FITNESS_CSS = `:root {
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
/* Data colours: the charts are the one place the page keeps colour beyond the accent. Light values were darkened until they measure on a white card; kept. */
:root {
  --move-b: #ff4d74; --exer-b: #7bd41f; --stand-b: #1ac3d0; --sleepring-a: #4744c7; --sleepring-b: #9b99ff;
  --move-track: rgba(215,0,56,.22); --exer-track: rgba(47,138,0,.22); --stand-track: rgba(0,124,136,.22); --sleepring-track: rgba(71,68,199,.22);
  --steps: #1e8e3e; --distance: #0a6ed1; --flights: #b35c00; --heart: #d60036; --heart-band: rgba(214,0,54,.16); --sleep: #4744c7; --generic: #6e6e73;
  --sleep-deep: #2a287e; --sleep-core: #4744c7; --sleep-rem: #0e7c94;
}
@media (prefers-color-scheme: dark) { :root {
  --move-b: #ff6a88; --exer-b: #c6ff4a; --stand-b: #5ff6ff; --sleepring-a: #5e5ce6; --sleepring-b: #9b99ff;
  --move-track: rgba(250,17,79,.22); --exer-track: rgba(122,232,42,.22); --stand-track: rgba(26,212,226,.22); --sleepring-track: rgba(94,92,230,.22);
  --steps: #30d158; --distance: #0a84ff; --flights: #ff9f0a; --heart: #ff375f; --heart-band: rgba(255,55,95,.18); --sleep: #5e5ce6; --generic: #8e8e93;
  --sleep-deep: #3634a3; --sleep-core: #5e5ce6; --sleep-rem: #64d2ff;
} }
/* Layout and SVG classes. Colours arrive through tokens, sizes through the type-scale block at the end. */
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
.page { max-width: var(--page-max); margin: 0 auto; padding: var(--page-pad); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: var(--gap); }
.head-title { flex: 1; min-width: 200px; }
.eyebrow { margin: 0 0 2px; color: var(--muted); }
h1 { margin: 0; letter-spacing: -.02em; }
.date { margin: 2px 0 0; color: var(--muted); }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: var(--surface); color: var(--ok); text-decoration: none; }
.pill-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.pill-warn { color: var(--warn); } .pill-warn .pill-dot { background: var(--warn); }
.pill-bad { color: var(--bad); } .pill-bad .pill-dot { background: var(--bad); }
.pill-empty { color: var(--ink); } .pill-empty .pill-dot { background: var(--muted); }
.pill-arrow { color: var(--muted); font-size: 16px; line-height: 1; }
.pill:hover { filter: brightness(.97); }
.banner { margin: 0 0 var(--gap); padding: 12px 16px; border-radius: 12px; background: var(--surface); color: var(--warn); font-weight: 600; }
.banner-bad { color: var(--bad); }
.card { background: var(--surface); border-radius: var(--radius); padding: var(--card-pad); }
.rings-card { margin-bottom: var(--gap); }
.rings-wrap { display: flex; align-items: center; justify-content: center; gap: 56px; flex-wrap: wrap; }
.rings { width: 220px; height: 220px; flex: none; }
.rings-rotate { transform: rotate(-90deg); transform-origin: 110px 110px; }
.ring-track { fill: none; stroke-width: 18; }
.ring-track-move { stroke: var(--move-track); } .ring-track-exer { stroke: var(--exer-track); } .ring-track-stand { stroke: var(--stand-track); } .ring-track-sleepring { stroke: var(--sleepring-track); }
.ring-ghost { stroke: var(--muted); stroke-dasharray: 3 11; stroke-width: 18; }
.ring-arc { fill: none; stroke-width: 18; stroke-linecap: round; }
.ring-lap { filter: drop-shadow(0 0 6px rgba(0,0,0,.55)); }
/* The fill: a keyframe with no \`to\`, so the end value is the element's own
   stroke-dashoffset attribute. One per radius, because the circumference is
   the only thing the stylesheet can know. */
@keyframes fill-92 { from { stroke-dashoffset: 578.05; } }
@keyframes fill-70 { from { stroke-dashoffset: 439.82; } }
@keyframes fill-48 { from { stroke-dashoffset: 301.59; } }
@media (prefers-reduced-motion: no-preference) {
  .ring-move .ring-arc { animation: fill-92 .9s cubic-bezier(.25,.8,.3,1); }
  .ring-exer .ring-arc { animation: fill-70 .9s cubic-bezier(.25,.8,.3,1); }
  .ring-stand .ring-arc, .ring-sleepring .ring-arc { animation: fill-48 .9s cubic-bezier(.25,.8,.3,1); }
}
.stop-move-a { stop-color: var(--move-a); } .stop-move-b { stop-color: var(--move-b); }
.stop-exer-a { stop-color: var(--exer-a); } .stop-exer-b { stop-color: var(--exer-b); }
.stop-stand-a { stop-color: var(--stand-a); } .stop-stand-b { stop-color: var(--stand-b); }
.stop-sleepring-a { stop-color: var(--sleepring-a); } .stop-sleepring-b { stop-color: var(--sleepring-b); }
.hatch-line { stroke: var(--line); stroke-width: 2; }
.readout { display: flex; flex-direction: column; gap: 14px; min-width: 200px; }
.readout-label { color: var(--muted); }
.readout-value { display: flex; align-items: baseline; gap: 6px; }
.readout-num-move { color: var(--move-a); } .readout-num-exer { color: var(--exer-a); } .readout-num-stand { color: var(--stand-a); } .readout-num-sleepring { color: var(--sleepring-a); }
.readout-goal { color: var(--muted); }
.readout-ghost .readout-label, .readout-ghost .readout-num { color: var(--muted); }
.rings-note { text-align: center; margin-top: 16px; }
.week { display: flex; justify-content: space-between; gap: 4px; margin-bottom: var(--gap); padding-top: 12px; padding-bottom: 12px; }
.week-day { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 6px; border-radius: 14px; flex: 1; }
.week-today { background: var(--inset); }
.mini { width: 48px; height: 48px; }
.rings-rotate-mini { transform: rotate(-90deg); transform-origin: 24px 24px; }
.mini-track { fill: none; stroke-width: 4; }
.mini-track-move { stroke: var(--move-track); } .mini-track-exer { stroke: var(--exer-track); } .mini-track-stand { stroke: var(--stand-track); } .mini-track-sleepring { stroke: var(--sleepring-track); }
.mini-dotted { stroke: var(--muted); stroke-width: 3; stroke-dasharray: 1.5 4; opacity: .7; }
.mini-arc { fill: none; stroke-width: 4; stroke-linecap: round; }
.mini-arc-move { stroke: var(--move-a); } .mini-arc-exer { stroke: var(--exer-a); } .mini-arc-stand { stroke: var(--stand-a); } .mini-arc-sleepring { stroke: var(--sleepring-a); }
.week-initial { color: var(--muted); }
.week-today .week-initial { color: var(--ink); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); grid-auto-flow: dense; }
.metric { display: flex; flex-direction: column; }
.metric-wide { grid-column: span 2; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-label { color: var(--muted); display: inline-flex; align-items: center; gap: 7px; margin-right: auto; }
.metric-when { color: var(--muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--generic); display: inline-block; flex: none; }
.dot-steps { background: var(--steps); } .dot-distance { background: var(--distance); } .dot-flights { background: var(--flights); } .dot-heart { background: var(--heart); } .dot-sleep { background: var(--sleep); } .dot-exer { background: var(--exer-a); } .dot-move { background: var(--move-a); } .dot-amber { background: var(--warn); }
.chip { color: var(--muted); background: var(--inset); border-radius: 999px; padding: 3px 9px; white-space: nowrap; }
.metric-value { margin: 10px 0 12px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; letter-spacing: -.02em; }
.metric-unit { color: var(--muted); letter-spacing: 0; }
.chart { display: block; width: 100%; height: auto; }
.chart-tall { min-height: 96px; }
.bar { fill: var(--generic); }
.bar-steps { fill: var(--steps); } .bar-distance { fill: var(--distance); } .bar-flights { fill: var(--flights); } .bar-heart { fill: var(--heart); } .bar-move { fill: var(--move-a); } .bar-basal { fill: var(--line); } .bar-exer { fill: var(--exer-a); }
.bar-sleep-deep { fill: var(--sleep-deep); } .bar-sleep-core { fill: var(--sleep-core); } .bar-sleep-rem { fill: var(--sleep-rem); } .bar-sleep-unspec { fill: var(--sleep); } .bar-sleep-inbed { fill: var(--line); }
.bar-partial { opacity: .55; }
.goal-line { stroke: var(--line); stroke-width: 1; stroke-dasharray: 3 4; }
.hr-band { fill: var(--heart-band); stroke: none; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line-generic { stroke: var(--generic); } .line-dot { fill: var(--generic); }
.hr-mean { fill: none; stroke: var(--heart); stroke-width: 1.6; stroke-linejoin: round; }
.workouts { list-style: none; margin: 4px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; }
.workout { display: grid; grid-template-columns: 16px 1fr auto; gap: 2px 10px; align-items: baseline; }
.glyph { width: 16px; height: 16px; fill: var(--exer-a); grid-row: span 2; align-self: start; }
.workout-name { font-weight: 600; }
.workout-stats { grid-column: 2 / span 2; color: var(--muted); }
.workout-when { grid-column: 3; grid-row: 1; color: var(--muted); white-space: nowrap; text-align: right; }
.caption { margin: 10px 0 0; color: var(--muted); }
.metric .caption { margin-top: auto; padding-top: 10px; }
.footnote { margin: 12px 0 0; color: var(--muted); }
.not-exported { margin-top: var(--gap); }
.empty-block h2 { margin: 0 0 8px; }
.setup { color: var(--muted); padding-left: 20px; }
.rendered { text-align: center; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; color: var(--ink); }
.foot span { overflow-wrap: anywhere; }
.foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); }
a { color: var(--accent); }
.foot a, .footnote a { text-decoration: none; } .foot a:hover, .footnote a:hover { text-decoration: underline; }
@media (max-width: 1023px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric-wide { grid-column: span 2; } }
@media (max-width: 719px) {
  .rings-wrap { flex-direction: column; align-items: center; gap: 20px; }
  .readout { width: 100%; max-width: 280px; }
  .grid { grid-template-columns: minmax(0, 1fr); } .metric-wide { grid-column: span 1; }
  .workouts { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 479px) {
  .week { padding: 10px 6px; } .week-day { padding: 4px 2px; } .mini { width: 38px; height: 38px; } .rings { width: 200px; height: 200px; }
  .metric-when { flex: none; }
}
@media (prefers-color-scheme: dark) { .card { border: 1px solid var(--line); } }
/* The 1 px lift is a light-scheme thing; on black the card carries the hairline above instead. */
/* Type scale and spacing: grey page, white 18 px cards (title 40/30, h2 21, body 17, small 15, eyebrow 13). */
:root { --page-max: 1080px; --page-pad: 24px 20px 48px; --gap: 16px; --card-pad: 24px; --radius: 18px; }
@media (prefers-color-scheme: light) { .card { box-shadow: 0 1px 2px rgba(0,0,0,.04); } }
h2 { font-size: 21px; font-weight: 600; line-height: 1.3; }
.eyebrow { font-size: 13px; font-weight: 600; line-height: 1.2; color: var(--accent); }
h1 { font-size: 40px; font-weight: 700; line-height: 1.1; }
.date, body { font-size: 17px; font-weight: 400; line-height: 1.55; }
.pill { font-size: 15px; font-weight: 600; line-height: 1.2; background: var(--surface); }
.readout-label, .card-label { font-size: 15px; font-weight: 600; line-height: 1.3; }
.readout-num { font-size: 30px; font-weight: 700; line-height: 1.1; }
.readout-goal, .metric-unit { font-size: 15px; font-weight: 600; line-height: 1.2; }
.metric-value { font-size: 34px; font-weight: 700; line-height: 1.1; }
.metric-when, .week-initial, .chip { font-size: 13px; font-weight: 600; line-height: 1.2; }
.workout, .workout-stats, .workout-when { font-size: 15px; line-height: 1.45; }
.caption, .footnote, .foot { font-size: 13px; font-weight: 400; line-height: 1.45; }
@media (max-width: 479px) {
  :root { --page-pad: 16px 14px 32px; --gap: 12px; --card-pad: 18px; }
  h1 { font-size: 30px; } .metric-value { font-size: 28px; } .readout-num { font-size: 28px; } body, .date { font-size: 16px; }
}
`;
