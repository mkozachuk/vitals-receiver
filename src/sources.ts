/**
 * Source resolution: which device's number is the day's number.
 *
 * Two sources write the same cumulative types for the same wall-clock hours --
 * the phone in the pocket and the watch on the wrist counting one walk. Summing
 * them double-counts, silently, and a dashboard that shows 15 825 steps for a
 * 9 245-step day is lying with a straight face. This module is the one place
 * that decides whose number wins, so both the fitness page and the ops page
 * give the same answer.
 */

export interface SourceTotal {
  source: string;
  label: string;
  value: number;
  samples: number;
}

export interface DayPoint {
  day: string;
  /** The resolved value: one source's total, never a sum across sources. */
  value: number;
  samples: number;
  /** Any data at all that day. "Zero" and "no data" are different readings. */
  present: boolean;
  /** Today is not over. Every average excludes it; every bar is hatched. */
  partial: boolean;
  source: string | null;
  sourceLabel: string | null;
  /** The sources that lost the day, kept rather than discarded. */
  alternatives: SourceTotal[];
}

export interface SourceDayRow {
  day: string;
  source: string;
  total: number;
  n: number;
}

/**
 * Friendly source names. The full bundle id never appears on the face of the
 * page -- it goes in a title attribute, where it is available and not shouted.
 */
export function sourceLabel(id: string, overrides: Record<string, string> = {}): string {
  for (const [prefix, name] of Object.entries(overrides)) {
    if (id.startsWith(prefix)) return name;
  }
  if (/^com\.apple\.health/i.test(id)) return "iPhone";
  if (/miwatch/i.test(id)) return "Mi Watch";
  const segment = id.split(".").filter((s) => s.length > 0).at(-1) ?? id;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * Per local day, per type, each source is totalled separately and exactly one
 * wins the day. VITALS_SOURCE_PRIORITY names winners by prefix; otherwise the
 * highest total takes it, tie broken on the lowest source id so the answer is
 * deterministic. Highest-per-day rather than a fixed device because a wrist
 * tracker beats a pocket phone on the days you left the phone, and the phone
 * beats a watch you forgot to charge -- picking per day follows whichever
 * device was actually on the body.
 *
 * The losers are kept. They are what the disclosure line on the card says.
 */
export function resolveDays(
  rows: SourceDayRow[],
  axis: string[],
  today: string,
  priority: string[] = [],
  sourceNames: Record<string, string> = {},
): DayPoint[] {
  const byDay = new Map<string, SourceDayRow[]>();
  for (const row of rows) {
    const list = byDay.get(row.day);
    if (list === undefined) byDay.set(row.day, [row]);
    else list.push(row);
  }

  return axis.map((day) => {
    const candidates = (byDay.get(day) ?? []).filter((c) => c.n > 0);
    const base: DayPoint = {
      day,
      value: 0,
      samples: 0,
      present: false,
      partial: day === today,
      source: null,
      sourceLabel: null,
      alternatives: [],
    };
    if (candidates.length === 0) return base;

    const ordered = [...candidates].sort((a, b) => b.total - a.total || (a.source < b.source ? -1 : 1));
    let winner = ordered[0] as SourceDayRow;
    for (const prefix of priority) {
      const hit = ordered.find((c) => c.source.startsWith(prefix));
      if (hit !== undefined) {
        winner = hit;
        break;
      }
    }

    return {
      ...base,
      value: winner.total,
      samples: winner.n,
      present: true,
      source: winner.source,
      sourceLabel: sourceLabel(winner.source, sourceNames),
      alternatives: ordered
        .filter((c) => c.source !== winner.source)
        .map((c) => ({ source: c.source, label: sourceLabel(c.source, sourceNames), value: c.total, samples: c.n })),
    };
  });
}
