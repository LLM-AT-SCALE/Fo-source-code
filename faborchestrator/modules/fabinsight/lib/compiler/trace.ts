/**
 * Trace compaction for the compiler prompt.
 *
 * A pin request stores every MCP call the model made (modules/fabinsight/lib/pin/trace.ts)
 * with its RAW result. The compiler only needs the shape of each result —
 * columns, row count and a few sample rows — so the prompt stays small and the
 * model cannot copy captured numbers into the program.
 *
 * Stored results come in three shapes:
 *   1. the MCP result object `{ content: [{ type:'text', text: '<json>' }], isError? }`
 *      (possibly still wrapped as `{ result: <that>, _mcp }` by the tool closure);
 *   2. an already-parsed `{ columns, rowCount, rows, capped }` / bare array / object;
 *   3. the capped form `{ truncated: true, head: '<first 200 KB of JSON>' }`.
 */

import type { TraceStep } from '@/modules/fabinsight/lib/pin/trace';
import { parseToolResult, type ToolResult } from '@/modules/fabinsight/lib/replay/mcp-result';
import type { ResultRow } from '@/modules/fabinsight/lib/replay/paths';

export type CompactCall = {
  id: string;
  seq: number;
  registryId: string | null;
  serverUrl: string | null;
  toolName: string;
  args: Record<string, unknown>;
  columns: string[];
  rowCount: number;
  sample: ResultRow[];
  capped?: boolean;
  truncated?: boolean;
  error?: string;
};

const SAMPLE_ROWS = 5;

function isRow(v: unknown): v is ResultRow {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function looksLikeToolResult(v: unknown): v is ToolResult {
  return isRow(v) && Array.isArray((v as { content?: unknown }).content);
}

/** Parse a truncated JSON head as far as it goes: recover rows from `"rows":[{…},{…}` prefix. */
function rowsFromHead(head: string): { columns: string[]; rows: ResultRow[]; rowCount: number | null } {
  const colsM = /"columns"\s*:\s*(\[[^\]]*\])/.exec(head);
  let columns: string[] = [];
  if (colsM) {
    try {
      columns = (JSON.parse(colsM[1]) as unknown[]).map(String);
    } catch {
      columns = [];
    }
  }
  const countM = /"rowCount"\s*:\s*(\d+)/.exec(head);
  const rowCount = countM ? Number(countM[1]) : null;
  const rows: ResultRow[] = [];
  const start = head.indexOf('"rows"');
  if (start >= 0) {
    const arr = head.indexOf('[', start);
    let i = arr + 1;
    while (i < head.length && rows.length < SAMPLE_ROWS) {
      const objStart = head.indexOf('{', i);
      if (objStart < 0) break;
      let depth = 0;
      let j = objStart;
      let inStr = false;
      for (; j < head.length; j++) {
        const ch = head[j];
        if (inStr) {
          if (ch === '\\') j++;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= head.length) break;
      try {
        const obj = JSON.parse(head.slice(objStart, j + 1));
        if (isRow(obj)) rows.push(obj);
      } catch {
        break;
      }
      i = j + 1;
    }
  }
  if (!columns.length && rows.length) columns = Object.keys(rows[0]);
  return { columns, rows, rowCount };
}

/** Normalise one stored result into columns / rows / count. */
export function summarizeStoredResult(result: unknown): {
  columns: string[];
  rowCount: number;
  sample: ResultRow[];
  capped?: boolean;
  truncated?: boolean;
  error?: string;
} {
  let value = result;
  // Tool-closure wrapper `{ result, _mcp }`.
  if (isRow(value) && 'result' in value && !('content' in value) && !('rows' in value)) {
    value = (value as { result: unknown }).result;
  }
  if (isRow(value) && '_mcp' in value) {
    const { _mcp: _ignored, ...rest } = value as Record<string, unknown>;
    void _ignored;
    value = rest;
  }

  // Capped-at-capture form.
  if (isRow(value) && value.truncated === true && typeof value.head === 'string') {
    const r = rowsFromHead(value.head);
    return { columns: r.columns, rowCount: r.rowCount ?? r.rows.length, sample: r.rows.slice(0, SAMPLE_ROWS), truncated: true };
  }

  // Raw MCP result object.
  if (looksLikeToolResult(value)) {
    const parsed = parseToolResult(value);
    if ('error' in parsed) return { columns: [], rowCount: 0, sample: [], error: parsed.error };
    return { columns: parsed.columns, rowCount: parsed.rows.length, sample: parsed.rows.slice(0, SAMPLE_ROWS), capped: parsed.capped || undefined };
  }

  // Already-parsed shapes.
  if (typeof value === 'string') {
    const parsed = parseToolResult({ content: [{ type: 'text', text: value }] });
    if ('error' in parsed) return { columns: [], rowCount: 0, sample: [], error: parsed.error };
    return { columns: parsed.columns, rowCount: parsed.rows.length, sample: parsed.rows.slice(0, SAMPLE_ROWS), capped: parsed.capped || undefined };
  }
  if (Array.isArray(value)) {
    const rows = value.filter(isRow);
    return { columns: rows.length ? Object.keys(rows[0]) : [], rowCount: rows.length, sample: rows.slice(0, SAMPLE_ROWS) };
  }
  if (isRow(value)) {
    if (Array.isArray(value.rows)) {
      const rows = (value.rows as unknown[]).filter(isRow);
      const columns = Array.isArray(value.columns) ? (value.columns as unknown[]).map(String) : rows.length ? Object.keys(rows[0]) : [];
      const rowCount = typeof value.rowCount === 'number' ? value.rowCount : rows.length;
      return { columns, rowCount, sample: rows.slice(0, SAMPLE_ROWS), capped: value.capped === true || undefined };
    }
    return { columns: Object.keys(value), rowCount: 1, sample: [value] };
  }
  return { columns: [], rowCount: 0, sample: [], error: value === null || value === undefined ? 'no result' : `unsupported result type: ${typeof value}` };
}

/** Compact a trace for the prompt. Call ids are `call<seq>`. */
export function compactTrace(trace: TraceStep[]): CompactCall[] {
  return trace.map((t) => {
    const s = summarizeStoredResult(t.result);
    return {
      id: `call${t.seq}`,
      seq: t.seq,
      registryId: t.registryId,
      serverUrl: t.serverUrl,
      toolName: t.toolName,
      args: t.args ?? {},
      columns: s.columns,
      rowCount: s.rowCount,
      sample: s.sample,
      ...(s.capped ? { capped: true } : {}),
      ...(s.truncated || t.resultTruncated ? { truncated: true } : {}),
      ...(t.error ?? s.error ? { error: t.error ?? s.error } : {}),
    };
  });
}
