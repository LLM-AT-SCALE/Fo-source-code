/**
 * Read the human reason out of an MCP tool result that reports failure INSIDE
 * a successful response.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The MCP spec lets a server flag a failed call with `isError: true`, but many
 * servers answer a broken call with a perfectly ordinary JSON-RPC *result*
 * whose text is an error payload. Real examples from the connectors this
 * product talks to:
 *
 *   {'error': 'Table [dbo].[X] not found in SemiDemoOLTP2504'}
 *
 *   {'error': "Invalid database 'Y'. Must be one of: ['Z']",
 *    'columns': [], 'rows': [], 'row_count': 0}
 *
 * Nothing in the transport says anything went wrong, so these were treated as
 * DATA and handed to the model, which turned a precise database error into
 * "I couldn't retrieve that information."
 *
 * The second example is why this is a parser rather than a regex: the reason
 * sits beside bookkeeping keys (`columns`, `rows`, `row_count`) that are noise
 * to a reader, and it is a double-quoted string containing single quotes — so
 * naive quote-swapping corrupts it.
 *
 * Detection is by SHAPE, never by message text, so servers and failures nobody
 * here has seen still work.
 */

/**
 * Keys that carry the human reason, in the order we prefer them.
 *
 * `detail` and `reason` are also ordinary metadata names, so they only count
 * when the payload carries no data (see DATA_KEYS) — otherwise a successful
 * result with, say, a top-level `reason` note would be read as a failure.
 */
const ERROR_KEYS = ['error', 'Error', 'error_message', 'errorMessage'];
const WEAK_ERROR_KEYS = ['detail', 'reason'];
/** Keys that mean "this payload carries data" — a success, whatever else it says. */
const DATA_KEYS = ['rows', 'data', 'result', 'results', 'items', 'records'];

const BACKSLASH = String.fromCharCode(92);

/**
 * Read a quoted string starting at `i` (which must point at the opening quote).
 * Handles either quote style and backslash escapes. Returns the decoded value
 * and the index just past the closing quote, or null if unterminated.
 */
function readQuoted(text: string, i: number): { value: string; next: number } | null {
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  let out = '';
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === BACKSLASH) {
      const esc = text[j + 1];
      // Keep it simple: the escapes that actually appear in these payloads.
      if (esc === 'n') out += '\n';
      else if (esc === 't') out += '\t';
      else if (esc === 'r') out += '\r';
      else out += esc ?? '';
      j += 2;
      continue;
    }
    if (ch === quote) return { value: out, next: j + 1 };
    out += ch;
    j += 1;
  }
  return null;
}

/**
 * The keys of the OUTERMOST object only, each with the index just past its
 * colon. Nested objects/arrays and string contents are skipped, so a column
 * named "reason" inside `rows` — a hold reason, a scrap reason — is data, not
 * a failure. (Searching the whole text used to flag exactly those results.)
 */
function topLevelKeys(text: string): Map<string, number> {
  const keys = new Map<string, number>();
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const q = readQuoted(text, i);
      if (!q) break;
      if (depth === 1) {
        let k = q.next;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        if (text[k] === ':' && !keys.has(q.value)) keys.set(q.value, k + 1);
      }
      i = q.next;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return keys;
}

/** Read the value starting at `v`: a message, or null when it means "no error". */
function reasonAt(text: string, v: number): string | null {
  while (v < text.length && /\s/.test(text[v])) v += 1;

  const quoted = readQuoted(text, v);
  if (quoted) {
    const value = quoted.value.trim();
    return value ? value : null; // present but empty -> not a failure
  }

  const rest = text.slice(v);
  // Falsy scalars are a success marker: 'error': None / null / false / 0.
  if (/^(null|None|false|False|0)\b/.test(rest)) return null;

  // An error OBJECT: prefer its message field over raw JSON.
  if (rest.startsWith('{')) {
    const inner = topLevelKeys(rest);
    for (const k of ['message', 'Message', 'error', 'detail', 'reason', 'text']) {
      const at = inner.get(k);
      if (at !== undefined) {
        const r = reasonAt(rest, at);
        if (r) return r;
      }
    }
    return rest.slice(0, 300);
  }

  // true / a code / anything else: surface it up to the next delimiter.
  const end = rest.search(/[,}]/);
  const raw = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (/^(true|True)$/.test(raw)) return 'The server reported an error without a message.';
  return raw || null;
}

/**
 * The reason an MCP result represents a failure, or null when it does not.
 *
 * Returns null for a payload whose error field is empty/None — several servers
 * include `'error': None` on SUCCESS, and treating that as a failure would
 * flag every healthy call.
 */
export function readErrorPayload(text: string | undefined | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;

  const keys = topLevelKeys(trimmed);
  for (const key of ERROR_KEYS) {
    const at = keys.get(key);
    if (at === undefined) continue;
    return reasonAt(trimmed, at);
  }
  // Weak keys only when the payload carries no data at all.
  if (!DATA_KEYS.some((k) => keys.has(k))) {
    for (const key of WEAK_ERROR_KEYS) {
      const at = keys.get(key);
      if (at === undefined) continue;
      const r = reasonAt(trimmed, at);
      if (r) return r;
    }
  }
  return null;
}

/**
 * True when the payload carries a TOP-LEVEL error key at all — used to decide
 * whether an unparseable payload should still be treated as a failure rather
 * than silently passed to the model as data.
 */
export function looksLikeErrorPayload(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  const keys = topLevelKeys(trimmed);
  return ERROR_KEYS.some((k) => keys.has(k));
}
