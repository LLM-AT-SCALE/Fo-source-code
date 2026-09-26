/**
 * On-the-Fly MCP — extract + parse an uploaded credentials document IN MEMORY.
 *
 * Accepts many formats and shapes:
 *   - JSON: { "host": "...", "user": "...", ... }
 *   - .env / plain text: key : value | key = value | key  value (whitespace only)
 *   - Markdown (.md): `**Host:** ...`, and pipe tables `| Host | 10.10.1.109 |`
 *   - Word (.docx) and Excel (.xlsx): text/tables extracted from the OOXML
 * Field labels are matched with aliases (Server IP → host, Pwd → password, Database
 * Name → database, …). For duplicate keys (e.g. an OS-login block then a SQL-login
 * block) the LAST value wins. Nothing is logged/persisted — this runs on the
 * dedicated intake endpoint, off the chat/LLM path.
 */
import AdmZip from 'adm-zip';

const KNOWN_FIELDS = new Set(['host', 'port', 'user', 'password', 'database', 'instance', 'ssl']);

// Normalized-key → canonical field (keys are lowercased, spaces/hyphens → "_").
const KEY_ALIASES: Record<string, string> = {
  hostname: 'host', server: 'host', server_name: 'host', server_ip: 'host',
  servername: 'host', serverip: 'host', ip: 'host', ip_address: 'host',
  ipaddress: 'host', endpoint: 'host', address: 'host', data_source: 'host', datasource: 'host',
  db: 'database', dbname: 'database', db_name: 'database', database_name: 'database',
  databasename: 'database', catalog: 'database', initial_catalog: 'database',
  databse: 'database', databse_name: 'database', // common typo
  username: 'user', user_name: 'user', user_id: 'user', userid: 'user', uid: 'user', login: 'user',
  pwd: 'password', pass: 'password', passwd: 'password', passphrase: 'password',
  instance_name: 'instance', instancename: 'instance', sql_instance: 'instance', named_instance: 'instance',
  encrypt: 'ssl', use_ssl: 'ssl',
};

function normalizeKey(k: string): string {
  const norm = k.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return KEY_ALIASES[norm] || norm;
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

/** Parse already-extracted text (JSON / .env / plain / markdown) into cred fields. */
export function parseCredsDocument(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  // 1) JSON
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const nk = normalizeKey(k);
        if (KNOWN_FIELDS.has(nk)) out[nk] = v;
      }
      return out;
    } catch { /* fall through */ }
  }

  // 2) line-based (markdown table / colon / equals / whitespace). Last value wins.
  const out: Record<string, unknown> = {};
  for (const raw0 of trimmed.split(/\r?\n/)) {
    const rawTrim = raw0.replace(/[*`]/g, '').trim(); // drop markdown emphasis/backticks
    if (!rawTrim || rawTrim.startsWith('#') || rawTrim.startsWith('//')) continue;

    let key: string | undefined;
    let value: string | undefined;

    // (a) markdown / pipe table row: | key | value |
    if (rawTrim.includes('|')) {
      const cells = rawTrim.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length >= 2 && !cells.every((c) => /^:?-+:?$/.test(c))) {
        key = cells[0];
        value = cells[1];
      }
    }

    if (key === undefined) {
      const line = rawTrim.replace(/^[\s>*\-•]+/, '').trim();
      // (b) explicit separator ":" or "=" — value may contain spaces
      const sep = line.match(/^([A-Za-z][A-Za-z0-9 _./-]*?)\s*[:=]\s*(.+)$/);
      if (sep) {
        key = sep[1];
        value = sep[2];
      } else {
        // (c) whitespace/tab separated — value is the LAST token (creds have no spaces)
        const ws = line.match(/^([A-Za-z][A-Za-z0-9 _./-]*?)[ \t]+(\S+)$/);
        if (ws) {
          key = ws[1];
          value = ws[2];
        }
      }
    }

    if (key === undefined || value === undefined) continue;
    const nk = normalizeKey(key);
    if (!KNOWN_FIELDS.has(nk)) continue; // ignore headers / unrelated lines
    out[nk] = stripQuotes(value);
  }

  return out;
}

// ── binary format extraction (Word / Excel) via OOXML unzip ──

/** Word .docx → text. Table rows become tab-separated lines; paragraphs are lines. */
function extractDocx(buf: Buffer): string {
  const zip = new AdmZip(buf);
  const xml = zip.readAsText('word/document.xml') || '';
  const lines: string[] = [];
  const cellText = (tc: string) => decodeEntities((tc.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((m) => m.replace(/<[^>]+>/g, '')).join('')).trim();

  // Table rows: join each row's cells with a tab.
  for (const row of xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []) {
    const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map(cellText).filter((c) => c.length > 0);
    if (cells.length) lines.push(cells.join('\t'));
  }
  // Non-table paragraphs (after removing tables so they aren't double-counted).
  const noTables = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, '');
  for (const p of noTables.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []) {
    const t = decodeEntities((p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((m) => m.replace(/<[^>]+>/g, '')).join('')).trim();
    if (t) lines.push(t);
  }
  return lines.join('\n');
}

/** Excel .xlsx → text. Each sheet row becomes a tab-separated line. */
function extractXlsx(buf: Buffer): string {
  const zip = new AdmZip(buf);
  // shared strings table
  const ssXml = zip.readAsText('xl/sharedStrings.xml') || '';
  const shared: string[] = (ssXml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
    decodeEntities((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((m) => m.replace(/<[^>]+>/g, '')).join('')),
  );
  const sheet = zip.getEntries().find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
  if (!sheet) return '';
  const sheetXml = zip.readAsText(sheet.entryName);
  const lines: string[] = [];
  for (const row of sheetXml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const cells: string[] = [];
    for (const c of row.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) {
      let val = '';
      if (/t="inlineStr"/.test(c)) {
        val = decodeEntities(((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '').replace(/<[^>]+>/g, ''));
      } else {
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) val = /t="s"/.test(c) ? (shared[Number(v)] ?? '') : v;
      }
      if (val.trim()) cells.push(val.trim());
    }
    if (cells.length) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

/**
 * Decode a text buffer to a string, honouring the byte-order mark or detecting
 * UTF-16 without one. Windows editors (Notepad "Unicode", some exports) save
 * .txt as UTF-16LE/BE; decoding those as UTF-8 yields NUL-interleaved garbage so
 * NOTHING parses ("missing host/user/password/database" on a well-formed file).
 * We handle UTF-8 (± BOM), UTF-16LE, and UTF-16BE, then strip any residual BOM.
 */
function decodeTextBuffer(buf: Buffer): string {
  let out: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    out = new TextDecoder('utf-16le').decode(buf.subarray(2)); // UTF-16LE BOM
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    out = new TextDecoder('utf-16be').decode(buf.subarray(2)); // UTF-16BE BOM
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    out = buf.subarray(3).toString('utf8'); // UTF-8 BOM
  } else {
    // No BOM: detect UTF-16 by the tell-tale NUL bytes on one parity. In ASCII
    // UTF-16LE every odd byte is 0x00; in UTF-16BE every even byte is 0x00.
    const n = Math.min(buf.length, 1024);
    let evenZeros = 0, oddZeros = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) { if (i % 2 === 0) evenZeros++; else oddZeros++; }
    }
    const zeroRatio = (evenZeros + oddZeros) / Math.max(1, n);
    if (n >= 4 && zeroRatio > 0.2) {
      out = new TextDecoder(oddZeros >= evenZeros ? 'utf-16le' : 'utf-16be').decode(buf);
    } else {
      out = buf.toString('utf8');
    }
  }
  return out.replace(/^﻿/, '');
}

/**
 * Extract raw text from an uploaded credentials file regardless of format
 * (.txt/.env/.json/.md/.yaml/.csv → as-is; .docx / .xlsx → OOXML text), then the
 * caller passes it to parseCredsDocument. Text files are decoded encoding-aware
 * (UTF-8 ± BOM, UTF-16LE/BE) so Windows "Unicode" saves parse correctly.
 */
export async function extractCredsText(file: Blob, filename: string): Promise<string> {
  const lower = (filename || '').toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  if (lower.endsWith('.docx')) return extractDocx(buf);
  if (lower.endsWith('.xlsx')) return extractXlsx(buf);
  // .txt, .md, .json, .env, .yaml, .yml, .cfg, .conf, .csv, etc. → decode as text
  return decodeTextBuffer(buf);
}
