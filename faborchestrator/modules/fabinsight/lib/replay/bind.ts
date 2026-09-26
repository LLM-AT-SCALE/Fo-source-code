/**
 * Fill a captured HTML template with replay results.
 *
 * The compiler leaves markers in the approved HTML; this module is the only
 * thing that touches the markup, and it only touches elements that carry one:
 *
 *   data-fab-bind="call1.rows[0].Yield" data-fab-format="pct"   inner text ← value
 *   data-fab-repeat="call2.rows" data-fab-limit="50"            element cloned per row,
 *                                                                {{Col|fmt}} inside
 *   data-fab-json="call3.rows"                                  <script> body ← JSON
 *   data-fab-chart='{"chart":"column","x":"Day","y":"Moves"}'    inner ← render-kit chart,
 *     + data-fab-bind="call4.rows"                               rows from the bind path
 *   data-fab-summary                                            inner text ← summary
 *
 * A small hand-rolled tokenizer (no HTML parser dependency) finds each marked
 * element and its matching close tag (depth-counted, void-tag aware). Values
 * always go through `esc()`. A path that does not resolve is DRIFT: the slot
 * renders "—" with `data-fab-drift="<path>"` and the path is reported so the
 * caller can mark the set stale instead of silently blanking a KPI.
 */

import {
  THEMES,
  areaChart,
  barList,
  columnChart,
  compact,
  day,
  clock,
  donutWithLegend,
  dur,
  esc,
  fmt,
  type Theme,
} from '@/modules/fabinsight/lib/render-kit';
import { PROGRAM_VERSION } from './program';
import { resolvePath, toNumber, type ResultRow, type Results } from './paths';

export type BindOptions = {
  now?: Date;
  summary?: string;
  theme?: Theme;
};

export type BindResult = { html: string; drift: string[] };

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const MARKER_ATTR_RE = /\sdata-fab-(bind|repeat|json|chart|summary)\b/;
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
export const PLACEHOLDER_RE = /\{\{\s*([^}|]+?)\s*(?:\|\s*([A-Za-z0-9]+)\s*)?\}\}/g;

type Attrs = Record<string, string>;

function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

/** Index just after the close tag matching an open tag that ends at `from`. -1 when unbalanced. */
function findClose(html: string, tag: string, from: number): { innerEnd: number; end: number } | null {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return { innerEnd: m.index, end: m.index + m[0].length };
    } else if (m[2] !== '/') {
      depth++;
    }
  }
  return null;
}

// ── Value formatting ─────────────────────────────────────────────────────────

export function formatValue(v: unknown, format?: string): string {
  if (v === undefined) return '—';
  const f = (format ?? '').toLowerCase();
  if (f === 'raw') return esc(v ?? '');
  if (v === null || v === '') return '—';
  const num = toNumber(v);
  switch (f) {
    case 'int':
      return num === null ? esc(v) : fmt(Math.round(num));
    case '1dp':
      return num === null ? esc(v) : fmt(num, 1);
    case '2dp':
      return num === null ? esc(v) : fmt(num, 2);
    case 'pct':
      return num === null ? esc(v) : `${fmt(num, 0)}%`;
    case 'pct1':
      return num === null ? esc(v) : `${fmt(num, 1)}%`;
    case 'compact':
      return num === null ? esc(v) : compact(num);
    case 'date':
      return esc(day(v instanceof Date ? v.toISOString() : v));
    case 'datetime':
      return esc(clock(v instanceof Date ? v.toISOString() : v));
    case 'dur':
      return num === null ? esc(v) : dur(num);
  }
  if (Array.isArray(v)) return esc(v.map((x) => (x === null || x === undefined ? '' : String(x))).join(', '));
  if (typeof v === 'object' && !(v instanceof Date)) return esc(JSON.stringify(v));
  if (v instanceof Date) return esc(v.toISOString());
  if (typeof v === 'number') return Number.isInteger(v) ? fmt(v) : fmt(v, Math.abs(v) < 10 ? 2 : 1);
  return esc(v);
}

function aggregateValue(v: unknown, agg: string | undefined): unknown {
  if (!agg || !Array.isArray(v)) return v;
  const nums = v.map(toNumber).filter((x): x is number => x !== null);
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'count':
      return v.length;
    case 'first':
      return v[0];
    case 'last':
      return v[v.length - 1];
  }
  return v;
}

// ── Charts ───────────────────────────────────────────────────────────────────

type ChartSpec = { chart: 'column' | 'area' | 'donut' | 'bars'; x: string; y: string | string[]; unit?: string; total?: string };

function renderChart(spec: ChartSpec, rows: ResultRow[], theme: Theme): string {
  const ys = Array.isArray(spec.y) ? spec.y : [spec.y];
  const unit = spec.unit ?? '';
  const pts = (y: string) =>
    rows
      .map((r) => ({ x: String(r[spec.x] ?? ''), y: toNumber(r[y]) }))
      .filter((p): p is { x: string; y: number } => p.y !== null);
  switch (spec.chart) {
    case 'column':
      return columnChart(pts(ys[0]), theme.ramp[0], unit);
    case 'area':
      return areaChart(
        ys.map((y) => ({ name: y, points: pts(y) })),
        unit,
        theme.ramp,
      );
    case 'donut':
      return donutWithLegend(
        pts(ys[0]).map((p) => ({ label: p.x, value: p.y })),
        spec.total ?? 'Total',
        theme.ramp,
      );
    case 'bars':
      return barList(
        pts(ys[0]).map((p) => ({ label: p.x, value: p.y })),
        unit,
        theme,
        true,
      );
  }
  return '';
}

// ── Main ─────────────────────────────────────────────────────────────────────

function stripAttr(openTag: string, attr: string): string {
  return openTag.replace(new RegExp(`\\s${attr}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?`, 'i'), '');
}

function withDrift(openTag: string, path: string): string {
  return openTag.replace(/\s*\/?>$/, (m) => ` data-fab-drift="${esc(path)}"${m.trimStart()}`);
}

function fillPlaceholders(
  inner: string,
  row: ResultRow,
  index: number,
  drift: Set<string>,
  callPath: string,
  extras: ResultRow,
): string {
  return inner.replace(PLACEHOLDER_RE, (_m, name: string, format?: string) => {
    const key = name.trim();
    if (key === '_index') return String(index + 1);
    if (Object.prototype.hasOwnProperty.call(row, key)) return formatValue(row[key], format);
    // `server` is only a column in multi-server runs; fall back to the set's server label.
    if (Object.prototype.hasOwnProperty.call(extras, key)) return formatValue(extras[key], format);
    drift.add(`${callPath}[*].${key}`);
    return '—';
  });
}

function setFor(results: Results, path: string) {
  const id = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(path)?.[1];
  if (!id) return undefined;
  return results instanceof Map ? results.get(id) : results[id];
}

function jsonForScript(v: unknown): string {
  return JSON.stringify(v ?? null).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * Bind results into the template. Returns the filled HTML and the list of
 * paths that did not resolve (drift). Never throws on bad markup: an
 * unbalanced marked element is left untouched.
 */
export function bindTemplate(template: string, results: Results, opts: BindOptions = {}): BindResult {
  const drift = new Set<string>();
  const theme = opts.theme ?? THEMES['factory-operations'] ?? Object.values(THEMES)[0];
  let out = '';
  let pos = 0;

  OPEN_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG_RE.exec(template))) {
    const [full, rawTag, attrText, selfClose] = m;
    if (!MARKER_ATTR_RE.test(` ${attrText}`)) continue;
    const tag = rawTag.toLowerCase();
    const start = m.index;
    const openEnd = start + full.length;
    if (selfClose === '/' || VOID_TAGS.has(tag)) continue; // nothing to fill inside

    const close = findClose(template, rawTag, openEnd);
    if (!close) continue;
    const attrs = parseAttrs(attrText);
    const inner = template.slice(openEnd, close.innerEnd);
    const closeTag = template.slice(close.innerEnd, close.end);
    let openTag = full;
    let replacement: string | null = null;

    if (attrs['data-fab-repeat'] !== undefined) {
      const path = attrs['data-fab-repeat'];
      const rows = resolvePath(path, results);
      if (!Array.isArray(rows)) {
        drift.add(path);
        replacement = withDrift(openTag, path) + inner + closeTag;
      } else {
        const limit = Math.max(0, parseInt(attrs['data-fab-limit'] ?? '', 10) || rows.length);
        const proto = stripAttr(stripAttr(openTag, 'data-fab-repeat'), 'data-fab-limit');
        const callPath = path.replace(/\.rows.*$/, '.rows');
        const srv = setFor(results, path)?.server;
        const extras: ResultRow = srv ? { server: srv } : {};
        replacement = rows
          .slice(0, limit)
          .map((r, i) => proto + fillPlaceholders(inner, (r ?? {}) as ResultRow, i, drift, callPath, extras) + closeTag)
          .join('');
      }
    } else if (attrs['data-fab-json'] !== undefined) {
      const path = attrs['data-fab-json'];
      const v = resolvePath(path, results);
      if (v === undefined) {
        drift.add(path);
        replacement = withDrift(openTag, path) + inner + closeTag;
      } else {
        replacement = openTag + jsonForScript(v) + closeTag;
      }
    } else if (attrs['data-fab-chart'] !== undefined) {
      const path = attrs['data-fab-bind'] ?? '';
      let spec: ChartSpec | null = null;
      try {
        spec = JSON.parse(attrs['data-fab-chart'] || '{}') as ChartSpec;
      } catch {
        spec = null;
      }
      const rows = path ? resolvePath(path, results) : undefined;
      if (!spec || !spec.chart || !spec.x || !spec.y || !Array.isArray(rows)) {
        drift.add(path || '(chart without data-fab-bind)');
        replacement = withDrift(openTag, path || 'chart') + inner + closeTag;
      } else {
        replacement = openTag + renderChart(spec, rows as ResultRow[], theme) + closeTag;
      }
    } else if (attrs['data-fab-summary'] !== undefined) {
      replacement = openTag + (opts.summary !== undefined ? esc(opts.summary) : inner) + closeTag;
    } else if (attrs['data-fab-bind'] !== undefined) {
      const path = attrs['data-fab-bind'];
      const v = aggregateValue(resolvePath(path, results), attrs['data-fab-aggregate']);
      if (v === undefined) {
        drift.add(path);
        openTag = withDrift(openTag, path);
        replacement = openTag + '—' + closeTag;
      } else {
        replacement = openTag + formatValue(v, attrs['data-fab-format']) + closeTag;
      }
    }

    if (replacement === null) continue;
    out += template.slice(pos, start) + replacement;
    pos = close.end;
    OPEN_TAG_RE.lastIndex = close.end;
  }
  out += template.slice(pos);

  return { html: stampMeta(out, opts.now ?? new Date()), drift: [...drift] };
}

/** Replace any fab-recipe meta with a fab-dashboard meta carrying the render time. */
export function stampMeta(html: string, now: Date): string {
  const cleaned = html.replace(/<meta\s+name=["']fab-recipe["'][^>]*>\s*/gi, '').replace(/<meta\s+name=["']fab-dashboard["'][^>]*>\s*/gi, '');
  const meta = `<meta name="fab-dashboard" content='${esc(JSON.stringify({ renderedAt: now.toISOString(), programVersion: PROGRAM_VERSION })).replace(/'/g, '&#39;')}'>`;
  const head = /<head\b[^>]*>/i.exec(cleaned);
  if (head) return cleaned.slice(0, head.index + head[0].length) + meta + cleaned.slice(head.index + head[0].length);
  return meta + cleaned;
}
