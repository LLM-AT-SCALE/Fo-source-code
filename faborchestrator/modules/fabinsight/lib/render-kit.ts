/**
 * Presentation kit for the curated dashboards.
 *
 * Every primitive here is modelled directly on the Athena FabOrchestrator deck
 * (slides 3–9): colour-ruled cards whose VALUE takes the rule's colour, panels
 * with their own top rule, gradient vertical bars carrying value labels and a
 * dotted trend overlay, donut + legend table, two-column bar lists, dark-header
 * tables with pill badges, and tinted callouts.
 *
 * Each dashboard picks its own `Theme`, because the deck deliberately gives
 * every slide a different palette rather than one house style.
 */

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function n(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const x = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(x) ? x : 0;
}

export function s(v: unknown, fallback = '—'): string {
  if (v === null || v === undefined || v === '') return fallback;
  const t = String(v).trim();
  return t === '' || t === '-' ? fallback : t;
}

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmt(v: number, digits = 0): string {
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Number.isInteger(v)) return fmt(v);
  // Small fractional values need a second decimal or a ranked list collapses
  // into visually identical labels — risk scores of 0.33, 0.33 and 0.31 all
  // rendered as "0.3" while their bars were visibly different lengths.
  return a < 10 ? v.toFixed(2) : v.toFixed(1);
}

export function pct(v: unknown, digits = 1): string {
  return `${n(v).toFixed(digits)}%`;
}

export function dur(sec: number): string {
  if (sec >= 86400) return `${(sec / 86400).toFixed(2)} d`;
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} h`;
  if (sec >= 60) return `${(sec / 60).toFixed(1)} min`;
  return `${sec.toFixed(1)} s`;
}

export function day(v: unknown): string {
  const t = s(v, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) return t.slice(0, 10);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[Number(m[2]) - 1]} ${m[3]}`;
}

export function clock(v: unknown): string {
  const t = s(v, '');
  return t === '—' ? '—' : t.replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Themes — one per slide, matching the deck's per-dashboard palettes
// ---------------------------------------------------------------------------

export type Theme = {
  /** Page background tint. */
  bg: string;
  /** Eyebrow / section-label colour. */
  accent: string;
  /** Ordered accent ramp used for card rules, bars and series. */
  ramp: string[];
  /** Heading ink. */
  ink: string;
};

export const THEMES: Record<string, Theme> = {
  // Slide 3 — cool blue-grey plane, teal/blue/magenta accents
  'factory-operations': {
    bg: '#eef2f8',
    accent: '#0f9d8f',
    ramp: ['#0f9d8f', '#2f6fed', '#d43fb0', '#f08c1a', '#0ea5b7', '#6d4bd8'],
    ink: '#132038',
  },
  // Slide 4 — gradient hero, blue → teal
  'lot-history': {
    bg: '#f2f6fb',
    accent: '#1c86d4',
    ramp: ['#1c86d4', '#12a897', '#7c3aed', '#e0a80c', '#e0484c', '#0f9d8f'],
    ink: '#132038',
  },
  // Slide 5 — teal with pink trend accent
  'process-analytics': {
    bg: '#eaf1f2',
    accent: '#0f8f80',
    ramp: ['#0f8f80', '#e63b7a', '#2f6fed', '#f0a01a', '#33bcd8', '#6d4bd8'],
    ink: '#123',
  },
  // Slide 6 — maintenance: amber / slate
  'maintenance-prediction': {
    bg: '#f4f2ec',
    accent: '#c47f10',
    ramp: ['#c47f10', '#0f9d8f', '#2f6fed', '#d0393b', '#6d4bd8', '#0ea5b7'],
    ink: '#241d10',
  },
  // Slide 7 — bottleneck: red / crimson urgency
  'bottleneck-prediction': {
    bg: '#f7f0f1',
    accent: '#c0203c',
    ramp: ['#c0203c', '#f0921a', '#2f6fed', '#0f9d8f', '#6d4bd8', '#0ea5b7'],
    ink: '#2a1116',
  },
  // Slide 8 — analytics: violet / teal mix
  'analytics-dashboard': {
    bg: '#f1f0f8',
    accent: '#5b3fd0',
    ramp: ['#5b3fd0', '#0f9d8f', '#e0484c', '#f0921a', '#2f6fed', '#d43fb0'],
    ink: '#1a1636',
  },
  // Slide 9 — executive: mint plane, green/blue/amber
  'executive-overview': {
    bg: '#e9f6f1',
    accent: '#0d8f74',
    ramp: ['#0d8f74', '#2f6fed', '#159e56', '#e0a80c', '#c0203c', '#6d4bd8'],
    ink: '#0f2c3f',
  },
};

export const OK = '#159e56';
export const WARN = '#e0a80c';
export const BAD = '#d0393b';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export function sectionLabel(text: string, t: Theme): string {
  return `<p class="sec" style="color:${t.accent}">${esc(text)}</p>`;
}

/** Gradient hero banner — the Lot History slide's signature header. */
export function hero(
  title: string,
  subtitle: string,
  pillLabel: string,
  pillValue: string,
  from: string,
  to: string,
): string {
  return `<div class="hero" style="background:linear-gradient(100deg,${from},${to})">
    <h2>${esc(title)}</h2>
    <p>${esc(subtitle)}</p>
    ${pillValue ? `<span class="hero-pill">${esc(pillLabel)}&nbsp;&nbsp;<b>${esc(pillValue)}</b></span>` : ''}
  </div>`;
}

export type Stat = {
  label: string;
  value: string;
  desc?: string;
  color?: string;
  /** Tinted variant, used in the deck for holds / rejects. */
  tint?: 'amber' | 'red' | 'green';
};

/** Uppercase label + large coloured value. Slide 4's tile row. */
export function statTiles(items: Stat[], t: Theme): string {
  return `<div class="tiles">${items
    .map((k, i) => {
      const c = k.color ?? t.ramp[i % t.ramp.length];
      return `<div class="tile${k.tint ? ` t-${k.tint}` : ''}" style="--d:${(i * 0.05).toFixed(2)}s">
        <p class="tile-label">${esc(k.label)}</p>
        <p class="tile-value" style="color:${c}">${k.value}</p>
        ${k.desc ? `<p class="tile-desc">${esc(k.desc)}</p>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

/** Colour-ruled KPI card whose value takes the rule colour — the deck's staple. */
export function kpiCards(items: Stat[], t: Theme): string {
  return `<div class="kpis">${items
    .map((k, i) => {
      const c = k.color ?? t.ramp[i % t.ramp.length];
      return `<div class="kpi" style="--d:${(i * 0.06).toFixed(2)}s"><span class="rule" style="background:${c}"></span>
        <p class="kpi-label">${esc(k.label)}</p>
        <p class="kpi-value" style="color:${c}">${k.value}</p>
        ${k.desc ? `<p class="kpi-desc">${esc(k.desc)}</p>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

export function panel(
  title: string,
  note: string,
  inner: string,
  color: string,
  wide = false,
): string {
  return `<section class="panel${wide ? ' wide' : ''}"><span class="rule" style="background:${color}"></span>
    <header><h3>${esc(title)}</h3>${note ? `<span class="note">${esc(note)}</span>` : ''}</header>
    ${inner}
  </section>`;
}

export function callout(lead: string, text: string, tone: 'red' | 'amber' | 'blue'): string {
  return `<p class="callout c-${tone}"><b>${esc(lead)}</b> ${esc(text)}</p>`;
}

export function empty(msg: string): string {
  return `<p class="empty">${esc(msg)}</p>`;
}

export type Bar = { label: string; value: number; right?: string; color?: string };

/** Horizontal bars: bold label left, value right, full-width rounded track. */
export function barList(items: Bar[], unit: string, t: Theme, multicolour = false): string {
  if (!items.length) return empty('No data recorded for this measure.');
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return `<ul class="bars">${items
    .map((it, i) => {
      const w = Math.max((Math.abs(it.value) / max) * 100, it.value === 0 ? 0 : 1.2);
      const c = it.color ?? (multicolour ? t.ramp[i % t.ramp.length] : t.ramp[0]);
      return `<li>
        <div class="brow"><span class="blabel">${esc(it.label)}</span>
        <span class="bval" style="color:${c}">${compact(it.value)}${unit ? ` ${unit}` : ''}${
          it.right ? ` <em>${esc(it.right)}</em>` : ''
        }</span></div>
        <div class="track"><span style="width:${w}%;background:${c};--d:${(i * 0.045).toFixed(
          2,
        )}s"></span></div>
      </li>`;
    })
    .join('')}</ul>`;
}

/** Slide 9's two-column layout: label | inline bar | value. */
export function barTable(items: Bar[], unit: string, t: Theme): string {
  if (!items.length) return empty('No data recorded for this measure.');
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const cell = (it: Bar, i: number) => {
    const w = Math.max((Math.abs(it.value) / max) * 100, it.value === 0 ? 0 : 1.2);
    const c = it.color ?? t.ramp[0];
    return `<div class="bt-row">
      <span class="bt-label">${esc(it.label)}</span>
      <span class="bt-track"><i style="width:${w}%;background:${c};--d:${(i * 0.04).toFixed(
        2,
      )}s"></i></span>
      <span class="bt-val">${compact(it.value)}${unit ? ` ${unit}` : ''}</span>
    </div>`;
  };
  const half = Math.ceil(items.length / 2);
  return `<div class="bt-cols"><div>${items.slice(0, half).map(cell).join('')}</div><div>${items
    .slice(half)
    .map(cell)
    .join('')}</div></div>`;
}

/**
 * Vertical gradient bars with a value label above each and a dotted trend line
 * across their tops — the Factory Throughput Trend chart on slide 9.
 */
export function columnChart(
  points: { x: string; y: number }[],
  color: string,
  unit = '',
): string {
  const pts = points.filter((p) => Number.isFinite(p.y));
  if (pts.length < 2) return empty('Not enough data points for a trend.');
  const W = 660;
  const H = 260;
  const L = 52;
  const R = 16;
  const T = 30;
  const B = 34;
  const pw = W - L - R;
  const ph = H - T - B;
  const max = Math.max(...pts.map((p) => p.y), 1);
  const slot = pw / pts.length;
  const bw = Math.min(slot * 0.52, 58);
  const yOf = (v: number) => T + ph - (v / max) * ph;

  const ticks = [0, max * 0.25, max * 0.5, max * 0.75, max];
  const grid = ticks
    .map(
      (v) =>
        `<text x="${L - 9}" y="${(yOf(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#8b93a7">${compact(
          v,
        )}</text>`,
    )
    .join('');

  const bars = pts
    .map((p, i) => {
      const cx = L + slot * i + slot / 2;
      const y = yOf(p.y);
      const d = (i * 0.06).toFixed(2);
      return `<rect class="col-bar" style="--d:${d}s" x="${(cx - bw / 2).toFixed(
        1,
      )}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(ph + T - y, 0).toFixed(
        1,
      )}" rx="3" fill="url(#colgrad)"><title>${esc(p.x)}: ${fmt(p.y)}${
        unit ? ` ${unit}` : ''
      }</title></rect>
      <text class="col-val" style="--d:${d}s" x="${cx.toFixed(1)}" y="${(y - 8).toFixed(
        1,
      )}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${color}">${compact(p.y)}</text>
      <text class="col-x" style="--d:${d}s" x="${cx.toFixed(1)}" y="${(H - 12).toFixed(
        1,
      )}" text-anchor="middle" font-size="9.5" fill="#8b93a7">${esc(p.x)}</text>`;
    })
    .join('');

  const trend = pts
    .map((p, i) => `${(L + slot * i + slot / 2).toFixed(1)},${yOf(p.y).toFixed(1)}`)
    .join(' ');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Column trend${
    unit ? ` in ${unit}` : ''
  }">
    <defs><linearGradient id="colgrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.55"/>
    </linearGradient></defs>
    <line x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}" stroke="#d9dee8"/>
    ${grid}${bars}
    <polyline class="trendline" points="${trend}" fill="none" stroke="#98a2b3" stroke-width="1.4" stroke-dasharray="4 4"/>
  </svg>`;
}

export type Series = { name: string; points: { x: string; y: number }[] };

/** Filled area / line chart. One y-axis only — never a second scale. */
export function areaChart(series: Series[], unit: string, ramp: string[]): string {
  const live = series.filter((x) => x.points.length > 1);
  if (!live.length) return empty('No trend data in this period.');
  const len = Math.max(...live.map((x) => x.points.length));
  const W = 660;
  const H = 250;
  const L = 48;
  const R = 16;
  const T = 16;
  const B = 30;
  const pw = W - L - R;
  const ph = H - T - B;
  const all = live.flatMap((x) => x.points.map((p) => p.y));
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const px = (i: number) => L + (i / (len - 1)) * pw;
  const py = (v: number) => T + ph - ((v - min) / span) * ph;

  const grid = [min, min + span / 2, max]
    .map(
      (v) =>
        `<line x1="${L}" x2="${W - R}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(
          1,
        )}" stroke="#e6eaf1"/><text x="${L - 8}" y="${(py(v) + 3.5).toFixed(
          1,
        )}" text-anchor="end" font-size="9.5" fill="#8b93a7">${compact(v)}</text>`,
    )
    .join('');

  const body = live
    .map((sr, si) => {
      const c = ramp[si % ramp.length];
      const line = sr.points.map((p, i) => `${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
      const fill =
        live.length === 1
          ? `<polygon points="${L},${py(min).toFixed(1)} ${line} ${px(sr.points.length - 1).toFixed(
              1,
            )},${py(min).toFixed(1)}" fill="${c}" opacity="0.13"/>`
          : '';
      const dots = sr.points
        .map(
          (p, i) =>
            `<circle cx="${px(i).toFixed(1)}" cy="${py(p.y).toFixed(
              1,
            )}" r="3.4" class="dot" style="--d:${(i * 0.03).toFixed(
              2,
            )}s" fill="${c}" stroke="#fff" stroke-width="1.8"><title>${esc(p.x)}: ${fmt(
              p.y,
              2,
            )}${unit ? ` ${unit}` : ''}</title></circle>`,
        )
        .join('');
      // Rough path length drives the draw-on animation; overestimating simply
      // starts the stroke fully hidden, which is the desired effect anyway.
      const len = Math.ceil(pw * 1.6 + ph);
      return `${fill}<polyline class="spark" style="--len:${len}" stroke-dasharray="${len}" points="${line}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
    })
    .join('');

  const labels = live[0].points;
  // A legend is mandatory for >= 2 series; a single series is named by the panel.
  const legend =
    live.length > 1
      ? `<div class="legend">${live
          .map((sr, si) => `<span><i style="background:${ramp[si % ramp.length]}"></i>${esc(sr.name)}</span>`)
          .join('')}</div>`
      : '';

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}${body}
    <text x="${L}" y="${H - 8}" font-size="9.5" fill="#8b93a7">${esc(labels[0].x)}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="9.5" fill="#8b93a7">${esc(
      labels[labels.length - 1].x,
    )}</text>
  </svg>${legend}`;
}

/** Donut plus the deck's legend TABLE (label, colour dot, value, total row). */
export function donutWithLegend(
  items: { label: string; value: number }[],
  totalLabel: string,
  ramp: string[],
): string {
  const rows = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (!rows.length) return empty('No distribution to show.');
  const total = rows.reduce((a, b) => a + b.value, 0);
  const R = 56;
  const CIRC = 2 * Math.PI * R;
  let off = 0;
  const arcs = rows
    .map((r, i) => {
      const frac = r.value / total;
      const len = Math.max(frac * CIRC - 2, 0); // 2px surface gap between fills
      // `stroke-dashoffset` is this slice's POSITION on the ring, so the
      // entrance animation must not touch it — it grows the dash instead.
      // (A `draw` animation ending at offset 0 stacked every slice at 12
      // o'clock once it finished, collapsing the ring into one fan.)
      const el = `<circle class="arc" style="--circ:${CIRC.toFixed(1)};--seg:${len.toFixed(
        2,
      )};--rest:${(CIRC - len).toFixed(2)};animation-delay:${(i * 0.12).toFixed(
        2,
      )}s" r="${R}" fill="none" stroke="${ramp[i % ramp.length]}" stroke-width="30"
        stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(
          2,
        )}"><title>${esc(r.label)}: ${fmt(r.value)}</title></circle>`;
      off += frac * CIRC;
      return el;
    })
    .join('');
  return `<div class="donut">
    <svg viewBox="0 0 150 150" class="dchart" role="img"><g transform="translate(75,75) rotate(-90)">${arcs}</g></svg>
    <table class="legend-table"><tbody>${rows
      .map(
        (r, i) =>
          `<tr><td><i style="background:${ramp[i % ramp.length]}"></i>${esc(r.label)}</td><td>${fmt(
            r.value,
          )}</td></tr>`,
      )
      .join('')}
      <tr class="total"><td><i style="background:#132038"></i>${esc(totalLabel)}</td><td>${fmt(
        total,
      )}</td></tr>
    </tbody></table>
  </div>`;
}

/** Pareto: descending bars with a running cumulative percentage. */
export function pareto(items: { label: string; value: number }[], unit: string, color: string): string {
  const rows = items.filter((i) => i.value > 0);
  if (!rows.length) return empty('No losses recorded in this period.');
  const total = rows.reduce((a, b) => a + b.value, 0);
  let run = 0;
  return `<ul class="bars">${rows
    .map((it, i) => {
      run += it.value;
      const cum = (run / total) * 100;
      return `<li>
        <div class="brow"><span class="blabel">${i + 1}. ${esc(it.label)}</span>
        <span class="bval" style="color:${color}">${compact(it.value)}${unit ? ` ${unit}` : ''} <em>${cum.toFixed(
          0,
        )}% cum.</em></span></div>
        <div class="track"><span style="width:${((it.value / total) * 100).toFixed(
          1,
        )}%;background:${color};--d:${(i * 0.05).toFixed(2)}s"></span></div>
      </li>`;
    })
    .join('')}</ul>`;
}

export function heatMap(
  xLabels: string[],
  yLabels: string[],
  cells: { x: number; y: number; v: number }[],
  base: string,
): string {
  if (!cells.length) return empty('Not enough coverage to build a heat map.');
  const max = Math.max(...cells.map((c) => c.v), 1);
  const grid = new Map(cells.map((c) => [`${c.x}:${c.y}`, c.v]));
  return `<div class="scroll"><table class="heat">
    <thead><tr><th></th>${xLabels.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead>
    <tbody>${yLabels
      .map(
        (y, yi) =>
          `<tr><th>${esc(y)}</th>${xLabels
            .map((x, xi) => {
              const v = grid.get(`${xi}:${yi}`) ?? 0;
              const ratio = v / max;
              // Single hue, light → dark: opacity carries magnitude. The value is
              // printed in every cell so colour is never the only signal.
              return `<td style="background:${
                v > 0 ? base : '#f3f5f9'
              };opacity:${v > 0 ? (0.16 + ratio * 0.84).toFixed(2) : 1};color:${
                ratio > 0.5 ? '#fff' : '#3c4763'
              }" title="${esc(y)} · ${esc(x)}: ${fmt(v)}">${v > 0 ? compact(v) : ''}</td>`;
            })
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

export type Col = { key: string; label: string; right?: boolean };
export type Row = Record<string, string | number> & {
  /** Marks the deck's highlighted first row (e.g. the active bottleneck). */
  _flag?: 'bad' | 'warn';
};

/** Table with the deck's dark navy header and optional highlighted rows. */
export function table(cols: Col[], rows: Row[], dark = false): string {
  if (!rows.length) return empty('No matching records.');
  return `<div class="scroll"><table class="grid${dark ? ' dark' : ''}">
    <thead><tr>${cols
      .map((c) => `<th${c.right ? ' class="r"' : ''}>${esc(c.label)}</th>`)
      .join('')}</tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr${r._flag ? ` class="hl-${r._flag}"` : ''}>${cols
            .map((c) => `<td${c.right ? ' class="r"' : ''}>${r[c.key] ?? '—'}</td>`)
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

/** Pill badge used inside table cells (Track In / Track Out / Hold …). */
export function badge(text: string, color: string): string {
  return `<span class="badge-pill" style="background:${color}">${esc(text)}</span>`;
}

export function chip(text: string): string {
  return `<span class="chip">${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Document shell
// ---------------------------------------------------------------------------

export function shell(opts: {
  title: string;
  eyebrow: string;
  lede: string;
  stamp: string;
  pills: string[];
  notes: string[];
  theme: Theme;
  body: string;
}): string {
  const { theme: t } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Questrial&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after,button,input,select,textarea,svg text{font-family:'Century Gothic','CenturyGothic','URW Gothic','Avant Garde','Questrial',sans-serif !important;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:${t.bg};color:${t.ink};padding:22px 20px 34px;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:1200px;margin:0 auto;}
  .top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;}
  .eyebrow{font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${t.accent};}
  h1{font-size:31px;font-weight:800;letter-spacing:-0.7px;line-height:1.12;margin-top:4px;color:${t.ink};}
  .lede{font-size:12.5px;color:#5b6478;margin-top:6px;max-width:96ch;line-height:1.5;}
  .pills{display:flex;gap:7px;align-items:center;flex-shrink:0;padding-top:4px;flex-wrap:wrap;}
  .pill{font-size:10.5px;font-weight:700;border-radius:999px;padding:5px 11px;background:#fff;color:#4c566e;border:1px solid rgba(19,32,56,.08);}
  .pill.live{background:#e6f7ee;color:#0b7a4b;display:inline-flex;align-items:center;gap:6px;}
  .pill.live i{width:6px;height:6px;border-radius:50%;background:#16a35a;display:inline-block;}
  .sec{font-size:10.5px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;margin:22px 0 9px;}
  .notes{display:grid;gap:7px;margin-top:12px;}
  .callout{font-size:12.5px;line-height:1.5;border-radius:11px;padding:11px 14px;border:1px solid;}
  .callout b{font-weight:800;}
  .c-red{background:#fdeff0;border-color:#f6cdd1;color:#8d2733;}
  .c-amber{background:#fdf6e3;border-color:#f0e0b4;color:#7a5a12;}
  .c-blue{background:#eef4fd;border-color:#cfe0f7;color:#22508f;}
  .hero{border-radius:16px;padding:22px 24px;color:#fff;margin-bottom:14px;}
  .hero h2{font-size:26px;font-weight:800;letter-spacing:-0.5px;}
  .hero p{font-size:13px;opacity:.92;margin-top:5px;}
  .hero-pill{display:inline-block;margin-top:13px;background:rgba(255,255,255,.22);border:1px solid rgba(255,255,255,.3);border-radius:9px;padding:8px 14px;font-size:13.5px;}
  .tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));}
  .tile{background:#fff;border:1px solid rgba(19,32,56,.07);border-radius:13px;padding:14px 15px;}
  .tile.t-amber{background:#fdf6e3;border-color:#f0e2b8;}
  .tile.t-red{background:#fdeff0;border-color:#f6d2d6;}
  .tile.t-green{background:#e9f8f0;border-color:#c6ecd8;}
  .tile-label{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:#8b93a7;}
  .tile-value{font-size:25px;font-weight:800;letter-spacing:-.6px;margin-top:6px;line-height:1.15;}
  .tile-desc{font-size:11.5px;color:#7b8398;margin-top:4px;line-height:1.4;}
  .kpis{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));}
  .kpi{position:relative;overflow:hidden;background:#fff;border:1px solid rgba(19,32,56,.07);border-radius:13px;padding:16px 16px 14px;}
  .rule{position:absolute;inset:0 0 auto 0;height:4px;display:block;}
  .kpi-label{font-size:12.5px;font-weight:700;color:#3c4763;}
  .kpi-value{font-size:33px;font-weight:800;letter-spacing:-1.1px;line-height:1.06;margin:8px 0 5px;}
  .kpi-desc{font-size:11.5px;color:#7b8398;line-height:1.4;}
  .grid-2{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start;}
  .panel{position:relative;overflow:hidden;background:#fff;border:1px solid rgba(19,32,56,.07);border-radius:13px;padding:16px;}
  .panel.wide{grid-column:1/-1;}
  .panel header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;}
  .panel h3{font-size:14px;font-weight:800;letter-spacing:-.2px;}
  .panel .note{font-size:10.5px;color:#98a0b3;text-align:right;flex-shrink:0;}
  .bars{list-style:none;display:grid;gap:10px;}
  .brow{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:4px;}
  .blabel{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bval{font-size:12px;font-weight:800;flex-shrink:0;font-variant-numeric:tabular-nums;}
  .bval em{font-style:normal;font-weight:600;color:#98a0b3;margin-left:5px;}
  .track{height:9px;border-radius:99px;background:#eef1f6;overflow:hidden;}
  .track span{display:block;height:100%;border-radius:99px;}
  .bt-cols{display:grid;gap:0 26px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));}
  .bt-row{display:grid;grid-template-columns:minmax(96px,1.15fr) 1.5fr auto;align-items:center;gap:10px;padding:5px 0;}
  .bt-label{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bt-track{height:8px;border-radius:99px;background:#eef1f6;overflow:hidden;}
  .bt-track i{display:block;height:100%;border-radius:99px;}
  .bt-val{font-size:11.5px;font-weight:700;color:#5b6478;font-variant-numeric:tabular-nums;}
  .chart{width:100%;height:auto;display:block;}
  .dchart{width:150px;height:150px;flex-shrink:0;}
  .legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;}
  .legend span{font-size:11.5px;font-weight:700;color:#4c566e;display:inline-flex;align-items:center;gap:6px;}
  .legend i{width:9px;height:9px;border-radius:50%;display:inline-block;}
  .donut{display:flex;flex-wrap:wrap;gap:22px;align-items:center;}
  .legend-table{flex:1;min-width:190px;border-collapse:collapse;font-size:12px;}
  .legend-table td{padding:6px 4px;border-bottom:1px solid #eef1f6;}
  .legend-table td:last-child{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;}
  .legend-table i{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:8px;}
  .legend-table tr.total td{border-bottom:0;border-top:1.5px solid #dfe4ec;font-weight:800;}
  .scroll{overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:12.5px;}
  .grid th{text-align:left;font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:#8b93a7;padding:0 10px 8px;white-space:nowrap;border-bottom:1px solid #e9edf3;}
  .grid.dark thead th{background:#152238;color:#c3cbdc;padding:11px 10px;border:0;}
  .grid.dark thead tr th:first-child{border-radius:8px 0 0 8px;}
  .grid.dark thead tr th:last-child{border-radius:0 8px 8px 0;}
  .grid td{padding:9px 10px;border-bottom:1px solid #f1f4f8;white-space:nowrap;}
  .grid tr:last-child td{border-bottom:0;}
  .grid .r{text-align:right;font-variant-numeric:tabular-nums;}
  .grid tr.hl-bad td{background:#fdeff0;font-weight:700;}
  .grid tr.hl-warn td{background:#fdf6e3;font-weight:700;}
  .badge-pill{display:inline-block;color:#fff;font-size:10.5px;font-weight:700;border-radius:999px;padding:3px 10px;}
  .chip{display:inline-block;background:#eaf1fb;color:#2a5fa8;font-size:11px;font-weight:600;border-radius:6px;padding:2px 8px;}
  .heat{border-collapse:separate;border-spacing:3px;}
  .heat th{font-size:9.5px;font-weight:700;color:#8b93a7;padding:2px 5px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .heat tbody th{text-align:right;color:${t.ink};font-weight:700;font-size:10.5px;}
  .heat td{height:29px;min-width:56px;text-align:center;border-radius:6px;font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;}
  .empty{font-size:12.5px;color:#98a0b3;background:#f7f9fc;border:1px dashed #dde3ec;border-radius:11px;padding:16px;text-align:center;}
  footer{margin-top:22px;font-size:10.5px;color:#a3abbd;text-align:center;}

  /* ---- Entrance animation ------------------------------------------------
     Cards and panels rise in, bars grow from zero, lines draw themselves and
     donut arcs sweep round. Staggered by an inline --d custom property so the
     dashboard assembles rather than snapping into place. */
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes growX{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  @keyframes growY{from{transform:scaleY(0)}to{transform:scaleY(1)}}
  @keyframes draw{from{stroke-dashoffset:var(--len,1200)}to{stroke-dashoffset:0}}
  /* Donut slices sweep by growing the dash, never by moving the offset — the
     offset is what places each slice on the ring. Dash + gap sums to --circ at
     every frame, so the pattern never repeats mid-sweep. */
  @keyframes sweep{from{stroke-dasharray:0 var(--circ)}to{stroke-dasharray:var(--seg) var(--rest)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  .kpi,.tile,.panel,.hero{animation:rise .5s cubic-bezier(.22,.61,.36,1) both;animation-delay:var(--d,0s);}
  .track span,.bt-track i{transform-origin:left center;animation:growX .85s cubic-bezier(.22,.61,.36,1) both;animation-delay:var(--d,0s);}
  .col-bar{transform-origin:bottom;transform-box:fill-box;animation:growY .8s cubic-bezier(.22,.61,.36,1) both;animation-delay:var(--d,0s);}
  .col-val,.col-x{animation:fadeIn .5s ease both;animation-delay:calc(var(--d,0s) + .35s);}
  .spark{stroke-dasharray:var(--len,1200);animation:draw 1.1s ease-out both;animation-delay:.25s;}
  .dot{animation:fadeIn .4s ease both;animation-delay:calc(var(--d,0s) + .5s);}
  .arc{animation:sweep .9s cubic-bezier(.22,.61,.36,1) both;}
  .trendline{animation:fadeIn .6s ease both;animation-delay:.9s;}

  /* ---- Interactivity ---------------------------------------------------- */
  .bars li{transition:transform .16s ease;}
  .bars li:hover{transform:translateX(2px);}
  .bars li:hover .track span{filter:brightness(1.08);}
  .track span,.bt-track i{transition:filter .16s ease;}
  .bt-row{border-radius:7px;transition:background .16s ease;}
  .bt-row:hover{background:#f5f7fb;}
  .kpi,.tile{transition:box-shadow .18s ease,transform .18s ease;}
  .kpi:hover,.tile:hover{transform:translateY(-2px);box-shadow:0 8px 20px -10px rgba(19,32,56,.28);}
  .grid tbody tr{transition:background .14s ease;}
  .grid tbody tr:hover td{background:#f5f7fb;}
  .grid tr.hl-bad:hover td{background:#fbe4e6;}
  .heat td{transition:transform .14s ease;cursor:default;}
  .heat td:hover{transform:scale(1.06);}
  .dot{transition:r .14s ease;cursor:pointer;}
  .dot:hover{r:6;}
  .col-bar{transition:opacity .14s ease;cursor:pointer;}
  .col-bar:hover{opacity:.82;}
  .legend-table tr:hover td{background:#f5f7fb;}

  @media (prefers-reduced-motion:reduce){
    *{animation-duration:.001ms !important;animation-delay:0s !important;transition-duration:.001ms !important;}
  }
</style>
</head>
<body><div class="wrap">
  <div class="top">
    <div><p class="eyebrow">${esc(opts.eyebrow)}</p><h1>${esc(opts.title)}</h1></div>
    <div class="pills"><span class="pill live"><i></i>Live</span>${opts.pills
      .map((p) => `<span class="pill">${esc(p)}</span>`)
      .join('')}<span class="pill">${esc(opts.stamp)}</span></div>
  </div>
  <p class="lede">${esc(opts.lede)}</p>
  ${
    opts.notes.length
      ? `<div class="notes">${opts.notes.map((x) => callout('Note.', x, 'amber')).join('')}</div>`
      : ''
  }
  ${opts.body}
  <footer>Athena FabOrchestrator.AI · queried live from the manufacturing warehouse</footer>
</div></body></html>`;
}
