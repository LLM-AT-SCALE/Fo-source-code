/**
 * COLUMN BRIEF — the dictionary lookups, done in code, for one page.
 *
 * WHY THIS EXISTS
 *   Measured: a generation call at effort `medium` emits ~13,300 output tokens
 *   for a page whose JSON is ~5,900. The rest is thinking, and a large share of
 *   that thinking is LOOKUP: the model is handed a 29 KB dictionary and has to
 *   find, for every column, which row says what `Name` or `TrackInResource`
 *   resolves to. That is search, not judgement, and search is something code
 *   does faster and without forgetting a row.
 *
 *   So the lookups are done here and handed over as a table scoped to THIS
 *   page's columns. The model still decides everything that needs deciding -
 *   the type code where evidence conflicts (F-148), the link targets, the
 *   wiring - it simply stops re-deriving facts we already hold.
 *
 * WHAT IT IS NOT
 *   Not a new source of truth. Every row is transcribed from `DICTIONARY.md`,
 *   the same file `checkPaths` validates against, so the brief and the check
 *   cannot disagree. Nothing is inferred: a term the dictionary does not carry
 *   is reported as ABSENT, which is the signal to gap-report it rather than
 *   invent a path.
 *
 * WHERE IT GOES
 *   Into the USER message, never the cached prefix. It varies per page, and the
 *   single cache breakpoint sits on the package - anything volatile before it
 *   invalidates the cache for every request. Same rule, and same shape, as
 *   `selectorBrief` (A-53) and `actionIdBrief` (A-67).
 */
import { existsSync, readFileSync } from "node:fs";
import type { PageSpecType } from "../descriptor";

export interface DictEntry {
  /** the CMF data path, e.g. `Product.Id` */
  path: string;
  /** the scalar type the dictionary records, where it records one */
  type?: string;
  /** how many delivered files the entry was read from */
  files?: number;
}

/**
 * Parse the dictionary's "Field name → data path" table.
 *
 * Deliberately strict about the shape: a row is `| Term | \`path\` | Type | n file(s) |`.
 * A looser parse would pick up rows from the other tables in that document and
 * quietly offer the model a "path" that is really a message name.
 */
export function parseDictionary(text: string): Map<string, DictEntry> {
  const out = new Map<string, DictEntry>();
  // Only the section that maps names to paths; the file has several tables.
  const start = text.indexOf("## 1. Field name");
  if (start < 0) return out;
  const rest = text.slice(start);
  const end = rest.indexOf("\n## ", 3);
  const section = end > 0 ? rest.slice(0, end) : rest;

  for (const line of section.split("\n")) {
    const m = /^\|\s*([A-Za-z][\w ]*?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*(?:(\d+)\s*file)?/.exec(line);
    if (!m) continue;
    const [, term, path, type, files] = m;
    if (!term || !path) continue;
    const t = (type ?? "").trim();
    out.set(term, {
      path,
      ...(t && t !== "—" && t !== "-" ? { type: t } : {}),
      ...(files ? { files: Number(files) } : {}),
    });
  }
  return out;
}

/**
 * The candidate dictionary keys for one column name, best first.
 *
 * A descriptor is supposed to speak the STORY's language - `TrackInResource`,
 * not `$(CustomTrackInResourceColumnLabel)` - but runs do produce the message
 * name, and a brief that goes empty on those is a brief that helps only half the
 * time. So a label is also tried with its wrapper and suffix removed.
 *
 * This is a LOOKUP convenience, not a derivation: the path still comes from the
 * dictionary row. A normalisation that lands on nothing simply reports the term
 * absent, which is the safe direction to be wrong in.
 */
export function candidates(name: string): string[] {
  const out = [name];
  const inner = /^\$\((.+)\)$/.exec(name)?.[1];
  if (inner) {
    out.push(inner);
    // `CustomTrackInResourceColumnLabel` -> `TrackInResource`
    const stripped = inner
      .replace(/^Custom/, "")
      .replace(/(Column|Grid|Field)?Label$/, "")
      .replace(/Title$/, "");
    if (stripped && stripped !== inner) out.push(stripped);
  }
  return out;
}

/** Every term this page needs resolved: grid columns first, then form fields. */
export function termsOf(page: PageSpecType): Array<{ term: string; where: string }> {
  const seen = new Set<string>();
  const out: Array<{ term: string; where: string }> = [];
  const add = (term: string, where: string): void => {
    // A term used twice needs resolving once; the brief is a lookup table, not
    // a census. Keeping it short is the point.
    if (!term || seen.has(term)) return;
    seen.add(term);
    out.push({ term, where });
  };
  for (const g of page.grids ?? []) {
    for (const c of g.columns ?? []) add(c.name, `${g.entity} grid`);
  }
  for (const f of page.forms ?? []) {
    for (const x of f.fields ?? []) add(x.label, "form");
  }
  return out;
}

/**
 * The brief, or "" when the dictionary resolves nothing this page asks for.
 *
 * Returning "" rather than an empty table matters: an empty section reads as
 * "the dictionary was consulted and had nothing", which is a claim, and on a
 * misconfigured run it would be a false one.
 */
/**
 * One term, looked up through its candidate keys.
 *
 * Exported so the pre-validation report and the model's brief resolve terms the
 * SAME way. Two lookups written twice would eventually disagree, and the report
 * exists precisely to be trusted about what resolved.
 */
export function resolveTerm(
  dict: ReadonlyMap<string, DictEntry>, term: string,
): DictEntry | undefined {
  for (const key of candidates(term)) {
    const e = dict.get(key);
    if (e) return e;
  }
  return undefined;
}

export function columnBrief(dictPath: string | undefined, page: PageSpecType): string {
  if (!dictPath || !existsSync(dictPath)) return "";
  const dict = parseDictionary(readFileSync(dictPath, "utf-8"));
  if (dict.size === 0) return "";

  // Resolve each term through its candidate keys, keeping the name the
  // descriptor actually used so the model can match the row to its column.
  const resolved = termsOf(page).map((t) => ({ ...t, entry: resolveTerm(dict, t.term) }));
  const known = resolved.filter((t) => t.entry);
  const absent = resolved.filter((t) => !t.entry);
  if (known.length === 0) return "";

  const rows = known.map(({ term, where, entry }) =>
    `| ${term} | \`${entry!.path}\` | ${entry!.type ?? "—"} | ${where} |`);

  const out = [
    "## Data paths already resolved for this page",
    "",
    "Read from `DICTIONARY.md` for exactly the terms below, so you do not have to",
    "search it. These are transcriptions of delivered artifacts, not suggestions:",
    "**use the path in this table**. The scalar type is what the dictionary",
    "records; the UI type CODE is still yours to decide, and where an artifact",
    "contradicts the schema the artifact wins.",
    "",
    "| Term | CMF path | Scalar type | Used by |",
    "|---|---|---|---|",
    ...rows,
  ];

  if (absent.length) {
    out.push(
      "",
      `**Not in the dictionary — ${absent.length} term(s):** ` +
      absent.map((a) => `\`${a.term}\``).join(", ") + ".",
      "These have no evidence behind them. Emit `UNKNOWN` and record each in the",
      "gap report rather than inventing a path.",
    );
  }
  return out.join("\n");
}
