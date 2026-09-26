/**
 * Pure matching of a dashboard request against the existing dashboards, by KPI
 * overlap (Jaccard) with a small title-similarity component. No I/O — the
 * `[id]/matches` route feeds it rows and the tests feed it fixtures.
 *
 * KPIs are stored as `[{label, key, source}]` on both `dashboard_requests.kpis`
 * and `dashboards.kpis`; `key` is the pre-normalised match key written by Fab
 * Orchestrator's extractor. When it is missing we normalise the label the same
 * way here.
 */

type KpiLike = string | { label?: string | null; key?: string | null; source?: string | null };

export type MatchInput = { title: string; kpis: KpiLike[] | unknown };
export type MatchCandidate = { id: string; title: string; kpis: KpiLike[] | unknown };

export type DashboardMatch = {
  dashboardId: string;
  title: string;
  /** 0..1 — 0.8 × KPI Jaccard + 0.2 × title-token Jaccard. */
  score: number;
  /** Percentage (0-100) of the request's KPIs the dashboard already covers. */
  overlapPct: number;
  /** Labels present in both (as written in the request). */
  sharedKpis: string[];
  /** Labels only the existing dashboard has. */
  extraKpis: string[];
  /** Labels the request has but the dashboard lacks. */
  missingKpis: string[];
};

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "by", "for", "in", "on", "to", "vs", "per", "with", "at", "from",
  "dashboard", "report", "overview", "summary", "view", "analysis", "analytics",
]);

/**
 * Normalise a KPI label into its match key: lower-case, parentheticals and
 * units removed, non-alphanumerics collapsed to single spaces.
 */
export function normalizeKpi(label: string): string {
  return String(label ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[%$€£#]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity of two sets (|A∩B| / |A∪B|); 0 when both are empty. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** `{key → label}` for a KPI list (first label wins per key; empty keys dropped). */
export function kpiKeyMap(kpis: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(kpis)) return out;
  for (const k of kpis as KpiLike[]) {
    let label = "";
    let key = "";
    if (typeof k === "string") {
      label = k;
      key = normalizeKpi(k);
    } else if (k && typeof k === "object") {
      label = typeof k.label === "string" ? k.label : "";
      key = typeof k.key === "string" && k.key.trim() ? normalizeKpi(k.key) : normalizeKpi(label);
    }
    if (!key || out.has(key)) continue;
    out.set(key, label || key);
  }
  return out;
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeKpi(title).split(" ").filter((t) => t && !TITLE_STOPWORDS.has(t)));
}

/**
 * Rank existing dashboards by similarity to a request. Returns at most `limit`
 * matches with a non-zero score, best first (ties broken by title).
 */
export function rankMatches(request: MatchInput, dashboards: MatchCandidate[], limit = 5): DashboardMatch[] {
  const reqKpis = kpiKeyMap(request.kpis);
  const reqTitle = titleTokens(request.title ?? "");
  const results: DashboardMatch[] = [];

  for (const d of dashboards) {
    const dKpis = kpiKeyMap(d.kpis);
    const kpiScore = jaccard(reqKpis.keys(), dKpis.keys());
    const titleScore = jaccard(reqTitle, titleTokens(d.title ?? ""));
    const score = 0.8 * kpiScore + 0.2 * titleScore;
    if (score <= 0) continue;

    const shared: string[] = [];
    const missing: string[] = [];
    for (const [key, label] of reqKpis) (dKpis.has(key) ? shared : missing).push(label);
    const extra: string[] = [];
    for (const [key, label] of dKpis) if (!reqKpis.has(key)) extra.push(label);

    results.push({
      dashboardId: d.id,
      title: d.title,
      score: Math.round(score * 1000) / 1000,
      overlapPct: reqKpis.size ? Math.round((shared.length / reqKpis.size) * 100) : 0,
      sharedKpis: shared,
      extraKpis: extra,
      missingKpis: missing,
    });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, Math.max(0, limit));
}
