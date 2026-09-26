/**
 * Turn an MCP `tools/call` result into rows.
 *
 * The admin-built (on-the-fly) servers return `content[0].text` as JSON
 * `{ columns, rowCount, capped, rows }`. Other servers may return a bare JSON
 * array, a single object, or plain text — the last is an error for replay
 * purposes because nothing can be bound from it.
 */

import type { ResultRow } from './paths';

/** Structurally identical to `McpToolResult` in lib/mcp-client.ts (kept local so this module has no runtime imports). */
export type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

export type ParsedRows = { rows: ResultRow[]; columns: string[]; capped: boolean; note?: string };
export type ParsedError = { error: string; missingTool?: boolean };

/** Heuristic: the server said the tool does not exist (JSON-RPC -32601 family). */
export function isMissingToolMessage(text: string): boolean {
  return /not available|unlisted|unknown tool|method not found|-32601|no such tool|tool .* not found/i.test(text);
}

function textOf(r: ToolResult): string {
  return (r.content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

function isRow(v: unknown): v is ResultRow {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseToolResult(r: ToolResult): ParsedRows | ParsedError {
  const text = textOf(r);
  if (r.isError) {
    const msg = text.trim() || 'tool returned an error';
    return { error: msg.slice(0, 400), missingTool: isMissingToolMessage(msg) };
  }
  if (!text.trim()) return { rows: [], columns: [], capped: false, note: 'empty result' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some servers (e.g. the Python-based SEMI OPC server) return a Python
    // literal — single quotes, True/False/None — rather than JSON.
    parsed = parsePythonLiteral(text);
    if (parsed === undefined) return { error: `non-JSON result: ${text.trim().slice(0, 120)}` };
  }

  if (Array.isArray(parsed)) {
    const rows = parsed.filter(isRow);
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [], capped: false };
  }
  if (isRow(parsed)) {
    if (Array.isArray(parsed.rows)) {
      const columnNames = Array.isArray(parsed.columns) ? (parsed.columns as unknown[]).map(String) : null;
      // Rows may come as arrays positionally aligned with `columns` (SEMI OPC
      // server) or as objects (on-the-fly servers).
      const rows = (parsed.rows as unknown[])
        .map((row) => (Array.isArray(row) && columnNames ? Object.fromEntries(columnNames.map((c, i) => [c, row[i] ?? null])) : row))
        .filter(isRow);
      const columns = columnNames ?? (rows.length ? Object.keys(rows[0]) : []);
      return {
        rows,
        columns,
        capped: parsed.capped === true,
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
      };
    }
    // A single object: treat as one row (e.g. a scalar-returning tool).
    return { rows: [parsed], columns: Object.keys(parsed), capped: false };
  }
  return { error: `unsupported result type: ${typeof parsed}` };
}

// ── Python literal parser ────────────────────────────────────────────────────
// Minimal recursive-descent parser for the subset Python's repr() emits for
// JSON-like data: dict, list, tuple, str ('…' or "…" with backslash escapes),
// int/float, True/False/None. Returns undefined when the text is not a literal.

export function parsePythonLiteral(text: string): unknown {
  let i = 0;
  const src = text.trim();
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = (): never => {
    throw new SyntaxError('not a python literal');
  };
  const str = (): string => {
    const q = src[i++];
    let out = '';
    while (i < src.length) {
      const ch = src[i++];
      if (ch === '\\') {
        const n = src[i++];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'u' ? String.fromCharCode(parseInt(src.slice(i, (i += 4)), 16)) : n;
      } else if (ch === q) return out;
      else out += ch;
    }
    return fail();
  };
  const value = (): unknown => {
    ws();
    const ch = src[i];
    if (ch === '{') {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (src[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const k = value();
        ws();
        if (src[i++] !== ':') fail();
        o[String(k)] = value();
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === '}') {
          i++;
          return o;
        }
        fail();
      }
    }
    if (ch === '[' || ch === '(') {
      const close = ch === '[' ? ']' : ')';
      i++;
      const a: unknown[] = [];
      ws();
      if (src[i] === close) {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === close) {
            i++;
            return a;
          }
          continue;
        }
        if (src[i] === close) {
          i++;
          return a;
        }
        fail();
      }
    }
    if (ch === "'" || ch === '"') return str();
    if (src.startsWith('True', i)) {
      i += 4;
      return true;
    }
    if (src.startsWith('False', i)) {
      i += 5;
      return false;
    }
    if (src.startsWith('None', i)) {
      i += 4;
      return null;
    }
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    if (src.startsWith('Decimal(', i)) {
      // Decimal('12.5') → 12.5
      i += 8;
      const v = value();
      ws();
      if (src[i++] !== ')') fail();
      return Number(v);
    }
    return fail();
  };
  try {
    const v = value();
    ws();
    return i === src.length ? v : undefined;
  } catch {
    return undefined;
  }
}
