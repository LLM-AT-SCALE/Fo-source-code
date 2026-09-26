/**
 * The one-paragraph text summary stored as `cached_summary` (shift-summary
 * emails read it). Either the program's `{{Label|fmt}}` template or an
 * automatic "Label: value" list.
 */

import { PLACEHOLDER_RE, type Program } from './program';
import { formatValue } from './bind';

export type KpiValue = { label: string; value: number | string | null; unit?: string; server?: string };

function plain(v: string): string {
  // formatValue escapes for HTML; the summary is plain text.
  return v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

export function buildSummary(program: Pick<Program, 'title' | 'summary' | 'kpis'>, kpis: KpiValue[]): string {
  const byLabel = new Map<string, KpiValue[]>();
  for (const k of kpis) {
    const list = byLabel.get(k.label) ?? [];
    list.push(k);
    byLabel.set(k.label, list);
  }
  const render = (k: KpiValue, format?: string) => {
    const v = plain(formatValue(k.value, format));
    return k.unit && v !== '—' && !/%$/.test(v) ? `${v} ${k.unit}` : v;
  };
  const one = (label: string, format?: string): string => {
    const list = byLabel.get(label);
    if (!list || !list.length) return '—';
    if (list.length === 1 || !list[0].server) return render(list[0], format);
    return list.map((k) => `${k.server}: ${render(k, format)}`).join(', ');
  };

  if (program.summary.kind === 'template') {
    return program.summary.text.replace(PLACEHOLDER_RE, (_m, label: string, format?: string) => one(label.trim(), format));
  }
  // Auto mode: a short line of the numeric, single-valued KPIs only. Result
  // sets ("Active Lots by Step") and unresolved values add nothing to a sentence.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const k of program.kpis) {
    if (!k.numeric || seen.has(k.label)) continue;
    const list = byLabel.get(k.label);
    if (!list?.length || list.every((x) => x.value === null || x.value === undefined)) continue;
    seen.add(k.label);
    parts.push(`${k.label}: ${one(k.label)}`);
    if (parts.length >= 8) break;
  }
  return parts.length ? `${program.title} — ${parts.join(' · ')}` : program.title;
}
