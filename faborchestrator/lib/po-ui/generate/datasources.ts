/**
 * DATA SOURCE COMPLETION — a grid that shows nothing is not a grid  (T-45)
 *
 * WHY THIS EXISTS
 *   Athena imported our Production Order page and reported: "On initial page
 *   load, the Production Orders are not displayed in the grid." Everything about
 *   the page was right — the query was bound, the link from the data source to
 *   the grid existed, the columns resolved. The data source simply never fetched,
 *   because `fetchOnLoad` was `false`.
 *
 *   Nothing in the requirement document says "fetch on load". Nobody writes that
 *   down, because a grid that is empty until you touch a filter is not a screen
 *   anybody would specify. It is a fact about how their pages behave, and it is
 *   in their artifacts.
 *
 * MEASURED, not assumed
 *   Across the 39 UI pages in the evidence roots there are 113 QueryDataSources:
 *   51 fetch on load and 62 do not, so `fetchOnLoad` is genuinely a decision and
 *   a blanket default would be wrong.
 *
 *   But restrict it to the sources that FEED A WIDGET — whose `dataChange` is
 *   linked to some widget's `data` input — and the split disappears:
 *
 *       fetchOnLoad true   10
 *       fetchOnLoad false   0
 *
 *   Ten of ten, no exceptions. A source that fills a grid fetches on load; the
 *   62 that do not are the ones feeding something else. That is a rule about
 *   wiring, which is exactly the kind of thing code can see and the model
 *   routinely cannot: whether a link elsewhere in the page reads this source is
 *   not local to the object being written.
 *
 * NEVER AN OVERRIDE, WITH ONE HONEST EXCEPTION
 *   Everywhere else in this pipeline a value the model set is left alone. Here it
 *   is not: `fetchOnLoad: false` on a grid-feeding source is CORRECTED, and the
 *   correction is reported. The reason is that the evidence is unanimous and the
 *   failure is silent — the page imports, renders, and shows an empty grid, which
 *   reads to a reviewer as "no data" rather than "wrong artifact". A decision
 *   nobody can see is not a decision worth preserving.
 */
import { basePort } from "../platform";
import type { PageSettings } from "../types";

export interface DataSourceCompletion {
  /** sources switched to fetch on load, with the widget that reads them */
  fetching: Array<{ source: string; reader: string; was: "false" | "absent" }>;
  /** grid-feeding sources that were already correct */
  untouched: number;
  /** sources that feed no widget, and so were left exactly as the model set them */
  unread: number;
}

interface Link {
  source?: { id?: unknown };
  target?: { id?: unknown };
  output?: unknown;
  input?: unknown;
}

/**
 * Which data sources feed a widget's `data` input, and what reads them.
 *
 * Keyed on the LINK rather than on the widget kind: a source is "feeding a grid"
 * because something reads its rows, and `dataChange -> data` is how that is said
 * in every delivered page. Reading the widget type instead would miss the case
 * where a non-grid widget renders the rows.
 */
function readersOfSources(settings: PageSettings): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of (settings as { links?: Link[] }).links ?? []) {
    /* A Filter widget hosting a grid exposes `inner$data`; same port. */
    if (basePort(String(l?.output ?? "")) !== "dataChange"
      || basePort(String(l?.input ?? "")) !== "data") continue;
    const from = l.source?.id;
    const to = l.target?.id;
    if (typeof from !== "string" || !from) continue;
    if (!out.has(from)) out.set(from, typeof to === "string" ? to : "(a widget)");
  }
  return out;
}

/**
 * Make every data source that fills a widget fetch when the page opens.
 *
 * Returns a deep copy; the caller's object is untouched, matching how the button
 * and template post-processors behave so the three compose predictably.
 */
export function completeDataSources(
  settings: PageSettings,
): { settings: PageSettings; completion: DataSourceCompletion } {
  const j = JSON.parse(JSON.stringify(settings)) as PageSettings;
  const completion: DataSourceCompletion = { fetching: [], untouched: 0, unread: 0 };

  const readers = readersOfSources(j);

  for (const ds of (j as { dataSources?: Array<Record<string, unknown>> }).dataSources ?? []) {
    const id = String(ds?.["id"] ?? "");
    const st = (ds["settings"] ??= {}) as Record<string, unknown>;
    const reader = readers.get(id);

    if (!reader) { completion.unread += 1; continue; }

    if (st["fetchOnLoad"] === true) { completion.untouched += 1; continue; }

    completion.fetching.push({
      source: String(st["name"] ?? id),
      reader,
      was: "fetchOnLoad" in st ? "false" : "absent",
    });
    st["fetchOnLoad"] = true;
  }

  return { settings: j, completion };
}

/** One line per correction for the run log, or nothing when there was nothing to do. */
export function formatDataSourceCompletion(c: DataSourceCompletion): string[] {
  if (c.fetching.length === 0) return [];
  const lines: string[] = [];
  for (const f of c.fetching) {
    lines.push(`  data source "${f.source}": fetchOnLoad ${f.was} -> true — ` +
      `it fills ${f.reader}, and a source that fills a widget fetches on load on ` +
      `10 of 10 of your delivered pages. Left as it was, the grid opens empty.`);
  }
  if (c.untouched) lines.push(`    - ${c.untouched} already fetched on load`);
  if (c.unread) lines.push(`    - ${c.unread} feed no widget and were left alone`);
  return lines;
}
