/**
 * KPI extraction from a dashboard artifact's HTML.
 *
 * A pin request stores the KPIs a dashboard shows so the admin app can (a) show
 * them on the approval card and (b) rank existing dashboards by overlap. The
 * model-authored HTML has no fixed schema, so we harvest the labels that
 * conventionally name a metric: KPI-card labels (render-kit `kpi-label` /
 * `tile-label` and generic stat/kpi/card blocks), table headers, and section
 * headings. Pure string work — no DOM library — and deliberately tolerant.
 */

type ExtractedKpi = {
  /** Display label as written in the HTML. */
  label: string;
  /** Lower-cased, punctuation-stripped form for matching. */
  key: string;
  /** Where it was found. */
  source: 'kpi' | 'column' | 'heading';
};

export type ExtractedDashboard = {
  title: string;
  kpis: ExtractedKpi[];
  headings: string[];
  columns: string[];
};

const MAX_KPIS = 60;
const MAX_LABEL = 80;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Strip tags, collapse whitespace, decode entities. */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised matching key: lower-case, units/parentheticals removed, alnum + spaces only. */
export function kpiKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[%$€£]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeLabel(t: string): boolean {
  if (!t || t.length > MAX_LABEL) return false;
  // A bare number / percentage / date is a value, not a label.
  if (/^[\d.,\s%+-]+$/.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false;
  return /[a-z]/i.test(t);
}

function collect(re: RegExp, html: string, out: string[]): void {
  for (const m of html.matchAll(re)) {
    const t = textOf(m[1] ?? '');
    if (looksLikeLabel(t)) out.push(t);
  }
}

/**
 * Extract the dashboard title, KPI labels, table column headers and section
 * headings from an HTML document.
 */
export function extractKpis(html: string): ExtractedDashboard {
  const src = html ?? '';

  // Title: <title>, else first <h1>.
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src);
  const title = titleM ? textOf(titleM[1]).slice(0, 120) : '';

  const kpiLabels: string[] = [];
  // render-kit KPI cards / tiles.
  collect(/<p[^>]*class="[^"]*\b(?:kpi-label|tile-label|blabel|bt-label)\b[^"]*"[^>]*>([^<]*)<\/p>/gi, src, kpiLabels);
  // Generic model-authored cards: any element whose class mentions kpi/stat/metric/label
  // and whose text is short. Matches <div class="stat-label">, <span class="kpi-title">, <dt>…
  collect(
    /<(?:div|span|p|h[2-6]|dt|small|label)[^>]*class="[^"]*\b(?:kpi|stat|metric|tag)[-_a-z]*(?:label|title|name|caption)?\b[^"]*"[^>]*>([^<]*)<\/(?:div|span|p|h[2-6]|dt|small|label)>/gi,
    src,
    kpiLabels,
  );
  // Tailwind-style cards often put the label in a <p class="text-sm text-gray-500"> above a big number.
  // Catch "<p …text-(xs|sm)…>Label</p>\s*<p …text-(2xl|3xl|4xl)…>Value</p>" pairs.
  for (const m of src.matchAll(
    /<(p|span|div)[^>]*class="[^"]*\btext-(?:xs|sm)\b[^"]*"[^>]*>([^<]*)<\/\1>\s*<(?:p|span|div)[^>]*class="[^"]*\btext-(?:xl|2xl|3xl|4xl|5xl)\b[^"]*"[^>]*>/gi,
  )) {
    const t = textOf(m[2] ?? '');
    if (looksLikeLabel(t)) kpiLabels.push(t);
  }
  collect(/<dt[^>]*>([\s\S]*?)<\/dt>/gi, src, kpiLabels);

  const columns: string[] = [];
  collect(/<th[^>]*>([\s\S]*?)<\/th>/gi, src, columns);

  const headings: string[] = [];
  collect(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi, src, headings);

  const seen = new Set<string>();
  const kpis: ExtractedKpi[] = [];
  const push = (label: string, source: ExtractedKpi['source']) => {
    const key = kpiKey(label);
    if (!key || seen.has(key) || kpis.length >= MAX_KPIS) return;
    seen.add(key);
    kpis.push({ label, key, source });
  };
  kpiLabels.forEach((l) => push(l, 'kpi'));
  columns.forEach((l) => push(l, 'column'));
  headings.forEach((l) => push(l, 'heading'));

  return {
    title,
    kpis,
    headings: [...new Set(headings)].slice(0, 30),
    columns: [...new Set(columns)].slice(0, 60),
  };
}
