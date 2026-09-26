/**
 * KSP_DL skeleton generator (Option D). Builds a CMF-uploadable blank
 * template by surgically pruning the real KSP_DL.xlsx via JSZip — we keep all
 * OOXML plumbing (defined names, docProps/custom.xml, named tables,
 * ContentTypeId, drawings, comments, the meta sheets) and just blank out
 * data rows + hide the data sheets the user didn't ask for.
 *
 * Why this exists: a workbook built from scratch with ExcelJS is rejected by
 * CMF's GetMasterDataPackageObjectTypes ('KeyNotFoundException: Value') because
 * it lacks ~70 named ranges, a SharePoint ContentTypeId GUID, named tables,
 * and other OOXML pieces CMF's C# code dictionaries-into. Starting from
 * KSP_DL (a CMF-accepted file) sidesteps every one of those gotchas.
 *
 * Public API:
 *   - generateSkeletonBlank({ keepObjectTypes }): returns bytes for a workbook
 *     where all data rows are removed from EVERY data sheet and any data sheet
 *     NOT in keepObjectTypes is set state="hidden".
 *
 * No CMF queries, no streaming-Excel parsing. Just zip + regex on workbook XML.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";
import { getComposition } from "@/modules/master-data-load/lib/validation/composition";
import { getRemovedColumns, isObjectRemoved } from "@/modules/master-data-load/lib/validation/removal-policy";

const RESERVED = new Set(["$order", "$ambiguous"]);
type Entry = { raw: string; columns: string[] };
const SCHEMA = templateSchema as unknown as Record<string, Entry>;

/** Reverse-lookup: raw sheet tab name → canonical object type. */
const OBJECT_TYPE_BY_RAW = new Map<string, string>();
for (const [k, v] of Object.entries(SCHEMA)) {
  if (RESERVED.has(k)) continue;
  if (v && typeof v === "object" && "raw" in v) OBJECT_TYPE_BY_RAW.set(v.raw, k);
}

/** A1, B1, … AA1, AB1, … */
function colRef(colIdx0: number, rowNum: number): string {
  let n = colIdx0;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${letters}${rowNum}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replace row r="1" of `sheetXml` with a fresh inline-string header row that
 * lists `headers` left-to-right starting at A1. Used to drop client-removed
 * columns: the schema knows the original order, we filter out the removed
 * names, and emit a clean header row referencing inline strings (no shared
 * strings index to manage). CMF accepts both shared and inline strings.
 */
function rewriteHeaderRow(sheetXml: string, headers: string[]): string {
  // An object can remain in the client template while every one of its columns
  // is removed by policy (CompatibleService is the current example). Excel
  // repairs `spans="1:0"` as corrupt cell information, so represent that case
  // as a valid empty row instead of emitting an impossible span.
  if (headers.length === 0) {
    return sheetXml.replace(
      /<row\b[^>]*\br="1"[^>]*(?:>[\s\S]*?<\/row>|\/>)/,
      '<row r="1"/>',
    );
  }
  const cells = headers
    .map(
      (name, i) =>
        `<c r="${colRef(i, 1)}" t="inlineStr"><is><t>${escapeXml(name)}</t></is></c>`,
    )
    .join("");
  const newRow = `<row r="1" spans="1:${headers.length}">${cells}</row>`;
  // Find the row with r="1" (regardless of other attributes) and replace its
  // entire tag, including children. Handles both <row …>…</row> and the rare
  // self-closing form. The regex matches `<row` then any attributes that
  // include `r="1"`, then up to and including </row> or a self-closing slash.
  return sheetXml.replace(
    /<row\b[^>]*\br="1"[^>]*(?:>[\s\S]*?<\/row>|\/>)/,
    () => newRow,
  );
}

/**
 * Resolved path to the canonical template — the skeleton source.
 *
 * Uses `templates/KSP_DL_AI.xlsx` — the pristine, CMF-valid full master-data
 * template. The previously-used `KSP_DL_client_final.xlsx` (KSP_DL with 28 object
 * sheets physically DELETED + 12 column removals, produced by
 * scripts/build-client-final-excel.ts) left broken OOXML references that make CMF
 * throw `Unk10000 — "Sequence contains no matching element"` at
 * `GetMasterDataPackageObjectTypes` on register. Verified 2026-08-03 against live
 * CMF: raw `client_final` FAILS that step; raw `KSP_DL_AI` registers cleanly
 * (151 object types). Every file the chat generated from `client_final` inherited
 * that break, so ALL generated templates (blank and object-specific) failed CMF.
 *
 * Client-removed objects/columns are still enforced at runtime via
 * `template-overrides.json` (isObjectRemoved / getRemovedColumns) — generation
 * refuses removed objects and never emits removed columns even though this source
 * still physically contains them.
 */
const KSP_DL_PATH = path.resolve(process.cwd(), "templates/KSP_DL_AI.xlsx");

/**
 * Cache the raw bytes once per server lifetime — the file is 3MB and the
 * skeleton generator is called on every `generateTemplate` request. JSZip's
 * loadAsync is cheap once we have the bytes in memory; the disk read is the
 * costly part.
 */
let kspBytesCache: Buffer | null = null;

async function loadKspBytes(): Promise<Buffer> {
  if (kspBytesCache) return kspBytesCache;
  kspBytesCache = await readFile(KSP_DL_PATH);
  return kspBytesCache;
}

/**
 * Strip every data row from a sheet's XML, leaving only row r="1" (header).
 * Tracks how many rows were removed for logging.
 */
function stripDataRows(sheetXml: string): { newXml: string; removed: number } {
  const sheetDataRe = /<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/;
  const m = sheetXml.match(sheetDataRe);
  if (!m) return { newXml: sheetXml, removed: 0 };
  const inner = m[1];

  let removed = 0;
  const keptRows: string[] = [];
  const rowRe = /<row(\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(inner))) {
    const attrs = rowMatch[1] ?? "";
    const rAttr = /\sr="(\d+)"/.exec(attrs);
    const rowNum = rAttr ? Number(rAttr[1]) : -1;
    if (rowNum === 1) keptRows.push(rowMatch[0]);
    else removed++;
  }
  const selfClosingRe = /<row(\s[^>]*)?\/>/g;
  let scMatch: RegExpExecArray | null;
  while ((scMatch = selfClosingRe.exec(inner))) {
    const attrs = scMatch[1] ?? "";
    const rAttr = /\sr="(\d+)"/.exec(attrs);
    const rowNum = rAttr ? Number(rAttr[1]) : -1;
    if (rowNum === 1) keptRows.push(scMatch[0]);
    else removed++;
  }
  const openTagMatch = /<sheetData(\s[^>]*)?>/.exec(sheetXml);
  const openTag = openTagMatch ? openTagMatch[0] : "<sheetData>";
  const newSheetData = `${openTag}${keptRows.join("")}</sheetData>`;
  const stripped = sheetXml.replace(sheetDataRe, () => newSheetData);
  // Only row 1 survives, so drop any merged-cell definition that reaches into a
  // deleted row (its cells no longer exist). Leaving them dangling is tolerated
  // by Excel but we clear them for a fully self-consistent workbook.
  return { newXml: dropMergeCellsBeyondRow(stripped, 1), removed };
}

/**
 * Remove `<mergeCell>` entries whose range reaches past `maxRow`, and fix the
 * `<mergeCells count>` (dropping the element entirely if none remain).
 */
function dropMergeCellsBeyondRow(sheetXml: string, maxRow: number): string {
  const blockRe = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/;
  const block = sheetXml.match(blockRe);
  if (!block) return sheetXml;
  const kept = [...block[1].matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"\s*\/>/g)].filter((c) =>
    [...c[1].matchAll(/[A-Za-z]+(\d+)/g)].every((r) => Number(r[1]) <= maxRow),
  );
  if (kept.length === 0) return sheetXml.replace(blockRe, "");
  return sheetXml.replace(
    blockRe,
    `<mergeCells count="${kept.length}">${kept.map((c) => c[0]).join("")}</mergeCells>`,
  );
}

/**
 * Parse xl/workbook.xml + xl/_rels/workbook.xml.rels to discover every sheet
 * tab name and the path to its underlying worksheets/sheetN.xml.
 */
export async function buildSheetIndex(zip: JSZip): Promise<{ name: string; path: string }[]> {
  const wbXml = await zip.file("xl/workbook.xml")!.async("text");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("text");

  const ridToTarget = new Map<string, string>();
  const relRe = /<Relationship[^>]*\sId="([^"]+)"[^>]*\sTarget="([^"]+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relsXml))) ridToTarget.set(rm[1], rm[2]);

  const out: { name: string; path: string }[] = [];
  const sheetRe = /<sheet[^>]*\sname="([^"]+)"[^>]*\sr:id="([^"]+)"/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(wbXml))) {
    const name = decodeXml(sm[1]);
    const rid = sm[2];
    const target = ridToTarget.get(rid);
    if (!target) continue;
    const p = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    out.push({ name, path: p });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function encodeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Update xl/workbook.xml so:
 *   - any `<sheet>` whose name is in `hideNames` becomes state="hidden"
 *   - any `<sheet>` whose name is in `showNames` becomes state="visible"
 *     (even if KSP_DL had it pre-hidden — and ~146 of KSP_DL's 213 sheets are)
 *
 * Why explicit show: Entegris's KSP_DL hides most data sheets by default
 * (the file is a giant load-everything template). Our blanks point the user
 * at exactly ONE object, so the sheets they need must be made visible.
 */
function setSheetStatesInWorkbookXml(
  wbXml: string,
  hideNames: Set<string>,
  showNames: Set<string>,
): string {
  if (hideNames.size === 0 && showNames.size === 0) return wbXml;
  return wbXml.replace(
    /<sheet\b([^>]*)\/>/g,
    (_full: string, attrs: string) => {
      const nameMatch = /\sname="([^"]+)"/.exec(attrs);
      if (!nameMatch) return _full;
      const name = decodeXml(nameMatch[1]);
      let desired: "hidden" | "visible" | null = null;
      if (hideNames.has(name)) desired = "hidden";
      else if (showNames.has(name)) desired = "visible";
      if (!desired) return _full;
      let next = attrs;
      if (/\sstate=/.test(next)) {
        next = next.replace(/\sstate="[^"]*"/, ` state="${desired}"`);
      } else {
        next = next.replace(/\sname="([^"]+)"/, ` name="$1" state="${desired}"`);
      }
      return `<sheet${next}/>`;
    },
  );
}

export type GenerateSkeletonInput = {
  /**
   * Object types (template keys) the user wants the workbook focused on.
   * Their sheets remain visible; every other prefixed data sheet is hidden
   * (when scope='narrow') or left visible (when scope='full').
   * Sub-sheets of multi-sheet objects are auto-included.
   */
  keepObjectTypes: string[];
  /**
   * 'narrow' (default): hide non-kept data sheets — matches the historical
   * blank-template behavior (user sees only what they asked for).
   * 'full': keep every one of the 175 data sheets visible — the same
   * layout the data-generation flow produces. Choose 'full' when the user
   * wants a complete workbook they can add multiple objects to later.
   */
  scope?: "full" | "narrow";
};

export type GenerateSkeletonResult = {
  bytes: Buffer;
  /** Sheets that remained visible (parent + sub-sheets the user asked for). */
  visibleSheets: string[];
  /** Sheets we marked hidden (every other prefixed data sheet in KSP_DL). */
  hiddenSheets: string[];
  /** Sheets we didn't touch (meta sheets + WorksheetNameMapping). */
  metaSheets: string[];
  /** Data rows we stripped (across all data sheets). */
  rowsStripped: number;
};

/**
 * Generate a CMF-uploadable blank template focused on `keepObjectTypes`.
 *
 *  - Loads KSP_DL.xlsx (cached after the first call).
 *  - Strips every data row from every prefixed (`<XX>...`) sheet — only the
 *    header row survives.
 *  - Hides every prefixed sheet NOT in the kept set (sub-sheets included).
 *  - Leaves meta sheets, defined names, custom.xml, named tables, etc.
 *    untouched. CMF accepts the file because every OOXML piece its
 *    GetMasterDataPackageObjectTypes endpoint dictionaries-into is intact.
 */
/**
 * The MIME types OPC needs declared for the part extensions we ship. Every part
 * in a package must have its content type resolvable via a `Default` (by
 * extension) or `Override` (by part name); an undeclared extension makes the
 * package non-conformant and Excel shows "We found a problem with some content …
 * try to recover" on open.
 *
 * Two extensions need this:
 *  - `json` — our own `xl/_kspSkeletonMarker.json` detection marker.
 *  - `vml`  — KSP_DL ships ~151 legacy VML drawing parts (comments/shapes) but
 *             its `[Content_Types].xml` never declared `vml`. Excel is lenient
 *             about VML alone, but combined with the json part it trips the
 *             repair prompt, so we declare both.
 */
const REQUIRED_DEFAULTS: Record<string, string> = {
  json: "application/json",
  vml: "application/vnd.openxmlformats-officedocument.vmlDrawing",
};

/**
 * Write the skeleton-detection marker part and ensure every extension present in
 * the package (json marker + any legacy vml) is declared in `[Content_Types].xml`,
 * so the workbook opens in Excel without a "problem with content" repair prompt.
 * The marker stays readable by `readSkeletonMarker`.
 */
async function stampSkeletonMarker(zip: JSZip, marker: unknown): Promise<void> {
  zip.file("xl/_kspSkeletonMarker.json", JSON.stringify(marker));
  const ctEntry = zip.file("[Content_Types].xml");
  if (!ctEntry) return;
  let ct = await ctEntry.async("text");
  let changed = false;
  for (const [ext, type] of Object.entries(REQUIRED_DEFAULTS)) {
    const present = ext === "json" || zip.file(new RegExp(`\\.${ext}$`, "i")).length > 0;
    if (present && !new RegExp(`Extension="${ext}"`, "i").test(ct)) {
      ct = ct.replace("</Types>", `<Default Extension="${ext}" ContentType="${type}"/></Types>`);
      changed = true;
    }
  }
  if (changed) zip.file("[Content_Types].xml", ct);
}

export async function generateSkeletonBlank(
  input: GenerateSkeletonInput,
): Promise<GenerateSkeletonResult> {
  // Refuse any object type the client has removed from the template.
  for (const t of input.keepObjectTypes) {
    if (isObjectRemoved(t)) {
      throw new Error(
        `Object type "${t}" has been removed from the client's template (template-overrides.json).`,
      );
    }
  }
  const bytes = await loadKspBytes();
  const zip = await JSZip.loadAsync(bytes);

  // Expand kept types to include each multi-sheet object's sub-sheets so the
  // user sees the parent + every sub-sheet visible (others hidden).
  const expanded = new Set<string>();
  for (const t of input.keepObjectTypes) {
    expanded.add(t);
    const comp = getComposition(t);
    if (comp) {
      for (const s of comp.subSheets) expanded.add(s.objectType);
    }
  }

  // Map kept object types → their raw sheet tab names from the schema.
  const keepRawNames = new Set<string>();
  for (const t of expanded) {
    const entry = SCHEMA[t];
    if (entry) keepRawNames.add(entry.raw);
  }

  const sheets = await buildSheetIndex(zip);

  // Pure meta sheets — never hide, never strip rows from.
  const META_SHEET_NAMES = new Set([
    "Index",
    "Formats",
    "Assumptions",
    "Enums",
    "Config",
    "WorksheetNameMapping",
  ]);

  const visible: string[] = [];
  const hidden: string[] = [];
  const meta: string[] = [];
  let totalStripped = 0;

  for (const { name, path: sheetPath } of sheets) {
    const isPrefixed = /^<[^>]+>/.test(name);
    const isPureMeta = META_SHEET_NAMES.has(name);

    // Strip data rows on every DATA sheet (prefixed parent OR no-prefix sub-sheet).
    // Pure meta sheets keep their content intact.
    if (!isPureMeta) {
      const entry = zip.file(sheetPath);
      if (entry) {
        const xml = await entry.async("text");
        const stripped = stripDataRows(xml);
        let next = stripped.newXml;
        totalStripped += stripped.removed;

        // If this sheet's object type has client-marked column removals, rewrite
        // the header row to omit those columns. Schema's column order matches
        // KSP_DL's emitted column order (schema was extracted from it), so we
        // filter the schema list and re-emit the row with A1, B1, C1, … refs.
        const objectType = OBJECT_TYPE_BY_RAW.get(name);
        if (objectType) {
          const removed = getRemovedColumns(objectType);
          const schemaCols = SCHEMA[objectType]?.columns ?? [];
          if (removed.size > 0 && schemaCols.length > 0) {
            const filtered = schemaCols.filter((c) => !removed.has(c.toLowerCase()));
            if (filtered.length !== schemaCols.length) {
              next = rewriteHeaderRow(next, filtered);
            }
          }
        }

        if (next !== xml) zip.file(sheetPath, next);
      }
    }

    if (isPureMeta) {
      meta.push(name);
    } else if (keepRawNames.has(name)) {
      visible.push(name);
    } else if (isPrefixed) {
      // scope='full' keeps every prefixed data sheet visible; 'narrow'
      // (the default, kept for backward compat) hides them.
      if (input.scope === "full") visible.push(name);
      else hidden.push(name);
    } else {
      // No-prefix sub-sheet belonging to ANOTHER parent. (The requested
      // object's own sub-sheets are already in keepRawNames and went to
      // `visible` above.) In 'full' scope keep the whole layout visible; in
      // 'narrow' HIDE it — otherwise "<Object> template only" leaks ~50
      // unrelated sub-sheets and looks like the full template.
      if (input.scope === "full") visible.push(name);
      else hidden.push(name);
    }
  }

  // Hide non-kept data sheets AND explicitly show every sheet we want
  // visible — including meta sheets and no-prefix sub-sheets. KSP_DL ships
  // with ~146 of 213 sheets pre-hidden by Entegris (they only un-hide what
  // they need per load), so we have to force visible on every kept sheet,
  // not just rely on KSP_DL's defaults.
  const hideSet = new Set(hidden);
  const showSet = new Set<string>([...visible, ...meta]);
  const wbXml = await zip.file("xl/workbook.xml")!.async("text");
  zip.file(
    "xl/workbook.xml",
    setSheetStatesInWorkbookXml(wbXml, hideSet, showSet),
  );

  // NOTE: the Index tab is intentionally left INTACT (lists every object). We
  // HIDE non-kept sheets rather than remove them, so all sheets the Index lists
  // are physically present — the file is self-consistent and CMF accepts it.
  // Pruning the Index (renumbering its table rows) made CMF's package reader
  // throw "The given key 'N' was not present in the dictionary" for some objects
  // (verified 2026-08-03 against live CMF), so it is deliberately NOT done.

  // Drop a small marker so `validateTemplate` can detect this is a
  // skeleton-built workbook (and skip the expensive ExcelJS re-parse path,
  // which hangs on the rich KSP_DL content even after row stripping).
  await stampSkeletonMarker(zip, {
    skeleton: true,
    visibleSheets: visible,
    rowsStripped: totalStripped,
  });

  const outBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return {
    bytes: Buffer.from(outBytes),
    visibleSheets: visible,
    hiddenSheets: hidden,
    metaSheets: meta,
    rowsStripped: totalStripped,
  };
}

export type GenerateFromSkeletonInput = {
  /** Rows to append, keyed by canonical object type. */
  rowsByType: Record<string, Record<string, string>[]>;
  /**
   * Optional base workbook bytes. When present, we start from these bytes
   * instead of `KSP_DL_client_final.xlsx` — this is the "user uploaded a file
   * and wants to add more rows to it" flow. Existing data in the base file is
   * preserved byte-for-byte; new rows are appended AFTER the last existing
   * row in each targeted sheet.
   */
  baseFileBytes?: Buffer;
  /**
   * 'full' (default): every one of the 175 data sheets stays visible — the
   * output matches the client's master-template layout.
   * 'narrow': hide every prefixed data sheet EXCEPT the ones the user is
   * appending rows to (plus meta sheets). Use when the user only wants
   * the sheet(s) relevant to the objects they're loading.
   */
  scope?: "full" | "narrow";
};

export type GenerateFromSkeletonResult = {
  bytes: Buffer;
  sheetsWritten: { objectType: string; sheetName: string; rowsAppended: number; startedFromRow: number }[];
  skipped: { objectType: string; reason: string }[];
};

/**
 * Full-workbook data generator. Starts from the finalized master template
 * (or from a user-uploaded workbook if `baseFileBytes` is provided), then
 * appends the user's rows to the requested object types' sheets.
 *
 * Contract:
 *   - Every one of the 175 sheets stays visible — output matches the master
 *     template layout, no sheets are removed or hidden per-request.
 *   - Client-removed object types are refused (skipped with a reason).
 *   - Client-removed columns are NEVER emitted, even if the user supplied
 *     values for them — the value is dropped silently.
 *   - Existing rows in the base file are preserved. New rows are appended
 *     after the last existing row (row 2 if the sheet was empty).
 *   - Header rows are NOT touched — the base file already has them correct
 *     (either KSP_DL_client_final which was header-rewritten at build time,
 *     or a user upload which has whatever headers it had).
 */
export async function generateFromSkeleton(
  input: GenerateFromSkeletonInput,
): Promise<GenerateFromSkeletonResult> {
  const bytes = input.baseFileBytes ?? (await loadKspBytes());
  const zip = await JSZip.loadAsync(bytes);
  const sheets = await buildSheetIndex(zip);
  const sheetByRawName = new Map(sheets.map((s) => [s.name, s]));

  const written: GenerateFromSkeletonResult["sheetsWritten"] = [];
  const skipped: GenerateFromSkeletonResult["skipped"] = [];

  for (const [objectType, rows] of Object.entries(input.rowsByType)) {
    if (rows.length === 0) continue;
    if (isObjectRemoved(objectType)) {
      skipped.push({ objectType, reason: "removed by client policy" });
      continue;
    }
    const entry = SCHEMA[objectType];
    if (!entry) {
      skipped.push({ objectType, reason: "unknown object type" });
      continue;
    }
    const sheet = sheetByRawName.get(entry.raw);
    if (!sheet) {
      skipped.push({ objectType, reason: `sheet ${entry.raw} not in base workbook` });
      continue;
    }

    // Effective columns after client removals — this is the exact column set
    // sitting in the file's header row. Rows we emit must line up with these.
    const removed = getRemovedColumns(objectType);
    const kept = entry.columns.filter((c) => !removed.has(c.toLowerCase()));

    // Read the sheet, find highest existing row, plan append offset.
    const entryFile = zip.file(sheet.path);
    if (!entryFile) {
      skipped.push({ objectType, reason: "sheet part missing in zip" });
      continue;
    }
    const sheetXml = await entryFile.async("text");
    const dataMatch = sheetXml.match(/<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/);
    if (!dataMatch) {
      skipped.push({ objectType, reason: "sheetData block not found" });
      continue;
    }
    const inner = dataMatch[1];
    // Parse existing rows. KSP sheets ship with HUNDREDS of blank styled rows
    // (Product ~975); appending after the last row would bury the data far down
    // and make the sheet look empty. So we place data right after the last row
    // that actually HAS content (the header, or the last existing data row),
    // OVERWRITING the blank rows in that range. No rows are removed — the tail
    // blanks keep their numbers, so the sheet dimension + dataValidations stay
    // intact (CMF-safe). This makes exported/filled data visible at the top, and
    // appends new rows contiguously after existing data.
    const existing: { n: number; xml: string }[] = [];
    let maxContentRow = 1; // header always counts as content
    const hasContent = (xml: string) => /<c\b[^>]*>(?:<is>|<v>)/.test(xml);
    const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(inner))) {
      const n = Number(rm[1]);
      existing.push({ n, xml: rm[0] });
      if (n > 1 && hasContent(rm[0]) && n > maxContentRow) maxContentRow = n;
    }
    const startRow = maxContentRow + 1;

    // Emit new rows.
    let rowNum = startRow;
    const newRowsXml = rows
      .map((row) => {
        // Resolve each row's keys case/space-insensitively. The rows come from
        // an LLM extracting free-text ("description Plant A"), so a key may
        // arrive as "description" or "Display Order" rather than the exact
        // template header. An exact-match lookup would silently drop the cell.
        const rowByLoose = new Map<string, string>();
        for (const [k, v] of Object.entries(row)) {
          rowByLoose.set(k.toLowerCase().replace(/[\s_]+/g, ""), v as string);
        }
        const cells = kept
          .map((colName, idx) => {
            const raw =
              row[colName] ?? rowByLoose.get(colName.toLowerCase().replace(/[\s_]+/g, ""));
            if (raw == null || raw === "") return null;
            return `<c r="${colRef(idx, rowNum)}" t="inlineStr"><is><t>${escapeXml(String(raw))}</t></is></c>`;
          })
          .filter(Boolean)
          .join("");
        const rowXml = `<row r="${rowNum}" spans="1:${kept.length}">${cells}</row>`;
        rowNum++;
        return rowXml;
      })
      .join("");

    // Keep existing rows up to the last content row (header + any existing
    // data), write the new rows next (overwriting blank rows in that range),
    // then keep the trailing blank rows below — no rows removed.
    const lastNewRow = startRow + rows.length - 1;
    const headAndData = existing.filter((r) => r.n <= maxContentRow).map((r) => r.xml).join("");
    const tail = existing.filter((r) => r.n > lastNewRow).map((r) => r.xml).join("");
    const newInner = headAndData + newRowsXml + tail;
    const updated = sheetXml.replace(
      /(<sheetData(?:\s[^>]*)?>)[\s\S]*?(<\/sheetData>)/,
      (_full, open, close) => `${open}${newInner}${close}`,
    );
    zip.file(sheet.path, updated);

    written.push({
      objectType,
      sheetName: entry.raw,
      rowsAppended: rows.length,
      startedFromRow: startRow,
    });
  }

  // Apply scope:
  //   'full' (default): every sheet in the workbook is set state="visible" —
  //     the user sees the whole master-template layout. This unhides sheets
  //     the base file (or Entegris's KSP_DL) had pre-hidden by default.
  //   'narrow': hide every prefixed data sheet EXCEPT the ones we just
  //     appended rows to (plus their sub-sheets and meta sheets).
  const hideSet = new Set<string>();
  const showSet = new Set<string>();
  if (input.scope === "narrow") {
    const keepSet = new Set<string>();
    for (const w of written) {
      keepSet.add(w.sheetName);
      const comp = getComposition(w.objectType);
      if (comp) for (const s of comp.subSheets) keepSet.add(s.raw);
    }

    // When extending a user-uploaded workbook, never hide a sheet the user
    // could already see — otherwise 'narrow' would make the rows they brought
    // with them vanish (e.g. upload a file holding Material data, add Site
    // rows, and Material would silently disappear). We read the base file's
    // existing visibility from the (tiny) workbook.xml rather than
    // decompressing all ~175 sheets, which is far too slow.
    if (input.baseFileBytes) {
      const baseWbXml = await zip.file("xl/workbook.xml")!.async("text");
      const sheetTagRe = /<sheet\b[^>]*>/g;
      let stm: RegExpExecArray | null;
      while ((stm = sheetTagRe.exec(baseWbXml))) {
        const tag = stm[0];
        const nameMatch = tag.match(/\bname="([^"]*)"/);
        if (!nameMatch) continue;
        if (!/state="hidden"/i.test(tag)) keepSet.add(decodeXml(nameMatch[1]));
      }
    }

    // Pure meta sheets stay visible; everything else must be explicitly kept
    // (a written object, its sub-sheets, or a sheet the base file already
    // showed). A bare `!isPrefixed` here used to leak EVERY no-prefix sub-sheet
    // of every other object, so "<Object> template only" showed ~50 unrelated
    // sheets and looked like the full template.
    const metaSheets = new Set([
      "Index", "Formats", "Assumptions", "Enums", "Config", "WorksheetNameMapping",
    ]);
    for (const name of sheetByRawName.keys()) {
      if (keepSet.has(name) || metaSheets.has(name)) showSet.add(name);
      else hideSet.add(name);
    }
  } else {
    for (const name of sheetByRawName.keys()) showSet.add(name);
  }
  const wbXml = await zip.file("xl/workbook.xml")!.async("text");
  zip.file(
    "xl/workbook.xml",
    setSheetStatesInWorkbookXml(wbXml, hideSet, showSet),
  );

  // Index tab left intact (see the note in generateSkeletonBlank): non-kept
  // sheets are hidden, not removed, so the full Index stays consistent and CMF
  // accepts it — pruning the Index broke CMF's reader for some objects.

  const visibleForMarker = [...showSet];

  // Stamp the skeleton marker so `validateTemplate` takes the fast path.
  // The base workbook (KSP_DL_client_final.xlsx or a prior generated file)
  // preserves the KSP_DL structure byte-for-byte; we only append <row>
  // elements. That makes the output loader-conformant by construction —
  // the same guarantee blank templates carry.
  await stampSkeletonMarker(zip, {
    skeleton: true,
    visibleSheets: visibleForMarker,
    rowsStripped: 0,
  });

  const out = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { bytes: Buffer.from(out), sheetsWritten: written, skipped };
}

/**
 * Inspect a workbook's bytes for our skeleton marker. Returns the marker
 * payload if present, or null. Used by `validateTemplate` to detect skeleton
 * files and skip the heavy ExcelJS re-parse (which would hang).
 */
export async function readSkeletonMarker(
  bytes: Buffer,
): Promise<{ skeleton: true; visibleSheets: string[]; rowsStripped: number } | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file("xl/_kspSkeletonMarker.json");
    if (!entry) return null;
    const text = await entry.async("text");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Silence unused-var warning when bundlers tree-shake; encodeXmlAttr is kept
// available for future name-mutation needs.
void encodeXmlAttr;
