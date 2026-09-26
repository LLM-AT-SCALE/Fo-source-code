/**
 * Lean object-specific template generator (Option B).
 *
 * Produces a master-data .xlsx that contains ONLY:
 *   - the 6 physical meta sheets (Index, Config, Formats, Assumptions,
 *     WorksheetNameMapping, Enums), copied from `KSP_DL_AI.xlsx` WITH their
 *     cell styling (fills, fonts), column widths and the Index autofilter, and
 *   - the requested object's sheet(s) (parent + any sub-sheets).
 *
 * The Index is TRIMMED to the 7 default rows (Index, Config, Formats,
 * Assumptions, Entities, WorksheetNameMapping, Enums) + one row per emitted
 * object sheet — matching the client's requirement that the Index list only the
 * default rows plus what was asked for, NOT all ~170 objects. The default/object
 * rows keep their original highlight fills + red tab-name font.
 *
 * Why from-scratch instead of pruning KSP_DL:
 *   - Pruning the Index while keeping the other ~205 sheets hidden made CMF
 *     throw `key 'N' not present in the dictionary` (see DANISH_CHANGES Change 7).
 *   - Physically deleting sheets from KSP_DL leaves dangling OOXML refs →
 *     `Sequence contains no matching element` (Change 6).
 *   - Building fresh with ONLY the needed sheets means the Index, the
 *     WorksheetNameMapping and the physical sheet set are self-consistent by
 *     construction. Verified live in CMF (Config/Site/Document/Step/StateModel,
 *     result=0). Styling is copied from the source so the file still LOOKS like
 *     the client's template.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";
import { getComposition } from "@/modules/master-data-load/lib/validation/composition";
import { isObjectRemoved } from "@/modules/master-data-load/lib/validation/removal-policy";

const RESERVED = new Set(["$order", "$ambiguous"]);
type Entry = { raw: string; columns: string[] };
const SCHEMA = templateSchema as unknown as Record<string, Entry>;
const SCHEMA_BY_LOWER = new Map(
  Object.entries(SCHEMA)
    .filter(([k]) => !RESERVED.has(k))
    .map(([k, v]) => [k.toLowerCase(), { objectType: k, ...v }]),
);

const EXCEL_TAB_LIMIT = 31;
const KSP_DL_PATH = path.resolve(process.cwd(), "templates/KSP_DL_AI.xlsx");

/** Physical meta sheets we copy (in this order). */
const META_ORDER = ["Config", "Formats", "Assumptions", "WorksheetNameMapping", "Enums"] as const;

/** A styled cell: value plus the bits of formatting we reproduce. */
type Cell = { v: string; fill?: string; fontColor?: string; bold?: boolean; underline?: boolean; wrap?: boolean };

/**
 * The client's Index colour scheme (from their reference template — the look
 * that shipped with `client_final`, NOT present in the raw `KSP_DL_AI` Index).
 * Applied deterministically so the trimmed Index matches the client's file:
 * Only the 7 DEFAULT rows are highlighted: Index = orange, Config = salmon
 * (Accent2 +40%), the other defaults = yellow. Object rows are left PLAIN
 * (no fill) — matching the raw KSP_DL_AI source and the client's request.
 * Header = bold; tab-name text stays plain black (no red, no underline).
 */
const IDX_ORANGE = "FFFFC000";
const IDX_SALMON = "FFF4B183";
const IDX_YELLOW = "FFFFFF00";
function indexRowFill(label: string): string {
  const l = label.trim().toLowerCase();
  if (l === "index") return IDX_ORANGE;
  if (l === "config") return IDX_SALMON;
  return IDX_YELLOW; // formats, assumptions, entities, worksheetnamemapping, enums
}
/** Build one Index data row: value cells + an optional fill highlight (black text). */
function indexRow(values: string[], fill?: string): Cell[] {
  return values.map((v) => ({ v, ...(fill ? { fill } : {}) }));
}
type ColW = { min: number; max: number; width: number };
type SheetData = { rows: Cell[][]; cols: ColW[] };
type MetaContent = { index: SheetData; sheets: Record<string, SheetData> };

let metaCache: MetaContent | null = null;

// ---- lightweight OOXML reader (ExcelJS OOMs on the 3MB KSP_DL_AI) ----
function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, "\n").replace(/&#13;/g, "\r");
}
function colOf(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref)!;
  let n = 0;
  for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

/** Parsed style tables from xl/styles.xml — enough to reproduce fills + fonts. */
type Styles = {
  fillFg: (string | undefined)[]; // fillId -> solid fgColor argb
  fontColor: (string | undefined)[]; // fontId -> color argb
  fontBold: boolean[]; // fontId -> bold
  xf: { fillId: number; fontId: number }[]; // cellXfs index -> ids
};

function parseStyles(xml: string): Styles {
  // fills
  const fillsBlock = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? "";
  const fillFg: (string | undefined)[] = [];
  for (const fm of fillsBlock.matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)) {
    const pf = /<patternFill\b([^>]*)>([\s\S]*?)<\/patternFill>/.exec(fm[1]) ?? /<patternFill\b([^>]*)\/>/.exec(fm[1]);
    let fg: string | undefined;
    if (pf && /patternType="solid"/.test(pf[1])) {
      const rgb = /<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{8})"/.exec(pf[2] ?? "");
      if (rgb) fg = rgb[1].toUpperCase();
    }
    fillFg.push(fg);
  }
  // fonts
  const fontsBlock = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)?.[1] ?? "";
  const fontColor: (string | undefined)[] = [];
  const fontBold: boolean[] = [];
  for (const fm of fontsBlock.matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>|<font\b[^>]*\/>/g)) {
    const inner = fm[1] ?? "";
    const rgb = /<color\b[^>]*\brgb="([0-9A-Fa-f]{8})"/.exec(inner);
    fontColor.push(rgb ? rgb[1].toUpperCase() : undefined);
    fontBold.push(/<b\/>|<b\s*\/>/.test(inner));
  }
  // cellXfs
  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const xf: { fillId: number; fontId: number }[] = [];
  for (const xm of xfsBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const at = xm[1];
    xf.push({
      fillId: Number(/\bfillId="(\d+)"/.exec(at)?.[1] ?? "0"),
      fontId: Number(/\bfontId="(\d+)"/.exec(at)?.[1] ?? "0"),
    });
  }
  return { fillFg, fontColor, fontBold, xf };
}

let kspBytesCache: Buffer | null = null;
async function kspBytes(): Promise<Buffer> {
  if (!kspBytesCache) kspBytesCache = await readFile(KSP_DL_PATH);
  return kspBytesCache;
}

/** Per-object-sheet formatting we copy from the source: header/row-2 cell styles
 * (by 1-based column), column widths, and header-cell comments. */
type CellStyle = { fill?: string; fontColor?: string; bold?: boolean };
type ObjectRich = {
  header: Record<number, CellStyle>;
  row2: Record<number, CellStyle>;
  cols: ColW[];
  comments: { col: number; text: string }[];
};

/** Read the header/row-2 styles, column widths and header comments for the given
 * source object sheets (by raw tab name) directly from KSP_DL_AI. */
async function loadObjectRich(rawNames: string[]): Promise<Map<string, ObjectRich>> {
  const out = new Map<string, ObjectRich>();
  if (rawNames.length === 0) return out;
  const zip = await JSZip.loadAsync(await kspBytes());
  const styles = parseStyles((await zip.file("xl/styles.xml")?.async("string")) ?? "");
  const styleOf = (c: string): CellStyle => {
    const s = /\bs="(\d+)"/.exec(c);
    if (!s) return {};
    const xf = styles.xf[Number(s[1])];
    if (!xf) return {};
    return { fill: xf.fillId ? styles.fillFg[xf.fillId] : undefined, fontColor: styles.fontColor[xf.fontId], bold: styles.fontBold[xf.fontId] || undefined };
  };
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const ridTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) ridTarget.set(m[1], m[2]);
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const nameToPath = new Map<string, string>();
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const nm = decodeXml(m[1]); const t = ridTarget.get(m[2]); if (t) nameToPath.set(nm, t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  }
  for (const raw of rawNames) {
    const p = nameToPath.get(raw);
    if (!p) continue;
    const xml = await zip.file(p)!.async("string");
    const cols: ColW[] = [];
    const colsBlock = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1] ?? "";
    for (const cm of colsBlock.matchAll(/<col\b([^>]*)\/>/g)) {
      const w = /\bwidth="([\d.]+)"/.exec(cm[1]); if (!w) continue;
      cols.push({ min: Number(/\bmin="(\d+)"/.exec(cm[1])?.[1] ?? "1"), max: Number(/\bmax="(\d+)"/.exec(cm[1])?.[1] ?? "1"), width: Number(w[1]) });
    }
    const rowStyles = (rn: string): Record<number, CellStyle> => {
      const rm = new RegExp(`<row\\b[^>]*\\br="${rn}"[^>]*>([\\s\\S]*?)<\\/row>`).exec(xml);
      const map: Record<number, CellStyle> = {};
      if (rm) for (const cm of rm[1].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)) map[colOf(cm[1])] = styleOf(cm[0]);
      return map;
    };
    // header comments (row 1) from the sheet's comment part
    const comments: { col: number; text: string }[] = [];
    const relPath = p.replace(/worksheets\/(sheet\d+)\.xml$/, "worksheets/_rels/$1.xml.rels");
    const relF = zip.file(relPath);
    if (relF) {
      const rl = await relF.async("string");
      const cm = /Target="([^"]*comments\d+\.xml)"/.exec(rl);
      if (cm) {
        const cp = ("xl/" + cm[1].replace(/^\.\.\//, "")).replace("xl/xl/", "xl/");
        const cx = await zip.file(cp)?.async("string");
        if (cx) for (const m of cx.matchAll(/<comment ref="([A-Z]+)(\d+)"[^>]*>([\s\S]*?)<\/comment>/g)) {
          if (m[2] !== "1") continue; // header-row comments only
          comments.push({ col: colOf(m[1]), text: decodeXml([...m[3].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")).trim() });
        }
      }
    }
    out.set(raw, { header: rowStyles("1"), row2: rowStyles("2"), cols, comments });
  }
  return out;
}

async function loadMeta(): Promise<MetaContent> {
  if (metaCache) return metaCache;
  const zip = await JSZip.loadAsync(await kspBytes());

  const shared: string[] = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ss = await ssFile.async("string");
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
    }
  }
  const styles = parseStyles((await zip.file("xl/styles.xml")?.async("string")) ?? "");

  const cellVal = (c: string): string => {
    const t = /\bt="([^"]+)"/.exec(c)?.[1];
    const is = /<is>([\s\S]*?)<\/is>/.exec(c);
    if (is) return decodeXml([...is[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
    const v = /<v>([\s\S]*?)<\/v>/.exec(c);
    if (!v) return "";
    if (t === "s") return shared[Number(v[1])] ?? "";
    return decodeXml(v[1]);
  };
  const cellStyle = (c: string): Pick<Cell, "fill" | "fontColor" | "bold"> => {
    const s = /\bs="(\d+)"/.exec(c);
    if (!s) return {};
    const xf = styles.xf[Number(s[1])];
    if (!xf) return {};
    return {
      fill: xf.fillId ? styles.fillFg[xf.fillId] : undefined,
      fontColor: styles.fontColor[xf.fontId],
      bold: styles.fontBold[xf.fontId] || undefined,
    };
  };

  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const ridTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) ridTarget.set(m[1], m[2]);
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const nameToPath = new Map<string, string>();
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const nm = decodeXml(m[1]);
    const t = ridTarget.get(m[2]);
    if (t) nameToPath.set(nm, t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  }

  const sheetOf = async (sheetName: string): Promise<SheetData> => {
    const p = nameToPath.get(sheetName);
    if (!p) return { rows: [], cols: [] };
    const xml = await zip.file(p)!.async("string");
    // column widths
    const cols: ColW[] = [];
    const colsBlock = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1] ?? "";
    for (const cm of colsBlock.matchAll(/<col\b([^>]*)\/>/g)) {
      const w = /\bwidth="([\d.]+)"/.exec(cm[1]);
      if (!w) continue;
      cols.push({
        min: Number(/\bmin="(\d+)"/.exec(cm[1])?.[1] ?? "1"),
        max: Number(/\bmax="(\d+)"/.exec(cm[1])?.[1] ?? "1"),
        width: Number(w[1]),
      });
    }
    // rows/cells
    const rows: Cell[][] = [];
    let maxCol = 0;
    for (const rm of xml.matchAll(/<row\b[^>]*r="\d+"[^>]*>([\s\S]*?)<\/row>/g)) {
      const arr: Cell[] = [];
      for (const cm of rm[1].matchAll(/<c\b[^>]*r="([A-Z]+\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)) {
        const ci = colOf(cm[1]);
        const v = cellVal(cm[0]);
        const st = cellStyle(cm[0]);
        arr[ci - 1] = { v, ...st, wrap: v.includes("\n") || undefined };
        maxCol = Math.max(maxCol, ci);
      }
      for (let i = 0; i < maxCol; i++) if (arr[i] == null) arr[i] = { v: "" };
      rows.push(arr);
    }
    return { rows, cols };
  };

  const sheets: Record<string, SheetData> = {};
  for (const name of META_ORDER) sheets[name] = await sheetOf(name);
  metaCache = { index: await sheetOf("Index"), sheets };
  return metaCache;
}

/** Apply a styled cell into an ExcelJS cell. */
function applyCell(cell: ExcelJS.Cell, c: Cell): void {
  cell.value = c.v === "" ? null : c.v;
  if (c.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.fill } };
  if (c.fontColor || c.bold || c.underline) {
    cell.font = {
      ...(c.fontColor ? { color: { argb: c.fontColor } } : {}),
      ...(c.bold ? { bold: true } : {}),
      ...(c.underline ? { underline: true } : {}),
    };
  }
  if (c.wrap) cell.alignment = { ...(cell.alignment ?? {}), wrapText: true, vertical: "top" };
}

/** Write a styled row into a worksheet and return the added row. */
function addStyledRow(ws: ExcelJS.Worksheet, cells: Cell[]): void {
  const row = ws.addRow(cells.map((c) => (c.v === "" ? null : c.v)));
  cells.forEach((c, i) => applyCell(row.getCell(i + 1), c));
}

function applyCols(ws: ExcelJS.Worksheet, cols: ColW[]): void {
  for (const cw of cols) for (let i = cw.min; i <= cw.max; i++) ws.getColumn(i).width = cw.width;
}

/** Truncate a raw tab name to Excel's 31-char limit; flag if a WNM entry is needed. */
function resolveSheetName(objectType: string, raw: string): { tab: string; needsMapping: boolean } {
  const truncated = raw.length > EXCEL_TAB_LIMIT;
  const tab = truncated ? raw.slice(0, EXCEL_TAB_LIMIT) : raw;
  const stripped = raw.replace(/^<[^>]+>/, "").trim();
  const needsMapping = truncated || stripped.toLowerCase() !== objectType.toLowerCase();
  return { tab, needsMapping };
}

type LeanSheet = { objectType: string; raw: string; columns: string[]; tab: string };
export type GenerateLeanResult = {
  bytes: Buffer;
  /** Emitted object sheets (parent first, then sub-sheets). */
  objectSheets: LeanSheet[];
  /** Full sheet list in file order (meta + object). */
  allSheets: string[];
};

/**
 * Build a lean template (or data workbook) for `objectType`.
 * @param rowsByType Optional data rows keyed by canonical object type. Omit for a
 *   blank (header-only) template. Sub-sheets with no rows are header-only.
 */
type KeptSheet = { objectType: string; raw: string; columns: string[] };

/** The object sheets for one object type. When `expand` (the default), a
 *  multi-sheet parent yields its parent sheet PLUS its composition sub-sheets;
 *  when false it yields only its own single sheet (used for DEPENDENCY objects,
 *  which ride along as a single referenceable sheet, not deep-expanded). */
function sheetsForType(objectType: string, expand = true): KeptSheet[] {
  const tpl = SCHEMA_BY_LOWER.get(objectType.toLowerCase());
  if (!tpl || isObjectRemoved(tpl.objectType)) return [];
  const single = [{ objectType: tpl.objectType, raw: tpl.raw, columns: tpl.columns }];
  if (!expand) return single;
  const comp = getComposition(tpl.objectType);
  return comp
    ? [
        { objectType: comp.parent, raw: comp.parentRaw, columns: comp.parentColumns },
        ...comp.subSheets.map((s) => ({ objectType: s.objectType, raw: s.raw, columns: s.columns })),
      ]
    : single;
}

/** Union of the object sheets for many types, deduped, in the given order. Any
 *  extra `alsoInclude` type (e.g. a rowsByType key not covered by a composition)
 *  is appended so no data is dropped. When `rootType` is given, ONLY that type
 *  expands its composition; every other type is a single sheet (dependency
 *  objects don't drag in their own sub-sheets). Without it, all types expand
 *  (single-object template generation). */
function keptFor(objectTypes: string[], alsoInclude: string[] = [], rootType?: string): KeptSheet[] {
  const seen = new Set<string>();
  const kept: KeptSheet[] = [];
  const add = (s: KeptSheet) => {
    const k = s.objectType.toLowerCase();
    if (!seen.has(k)) { seen.add(k); kept.push(s); }
  };
  const rl = rootType?.toLowerCase();
  for (const ot of objectTypes) {
    const expand = rl == null || ot.toLowerCase() === rl;
    for (const s of sheetsForType(ot, expand)) add(s);
  }
  for (const ot of alsoInclude) {
    if (seen.has(ot.toLowerCase())) continue;
    const tpl = SCHEMA_BY_LOWER.get(ot.toLowerCase());
    if (tpl && !isObjectRemoved(tpl.objectType)) add({ objectType: tpl.objectType, raw: tpl.raw, columns: tpl.columns });
  }
  return kept;
}

export async function generateLeanTemplate(
  objectType: string,
  rowsByType?: Record<string, Record<string, string>[]>,
): Promise<GenerateLeanResult> {
  const tplLower = SCHEMA_BY_LOWER.get(objectType.toLowerCase());
  if (!tplLower) throw new Error(`Unknown object type "${objectType}".`);
  if (isObjectRemoved(tplLower.objectType)) {
    throw new Error(`Object type "${tplLower.objectType}" has been removed from the client's template.`);
  }
  return buildLeanWorkbook(keptFor([objectType]), rowsByType);
}

/**
 * Multi-object lean workbook — an export of several object types (root +
 * dependencies + their sub-sheets) into ONE file with a TRIMMED Index listing
 * ONLY the involved sheets, built from scratch so it stays CMF-valid. `types`
 * is the ordered list (execution order); any extra `rowsByType` key gets a sheet
 * so no data is dropped.
 */
export async function generateLeanMulti(
  types: string[],
  rowsByType?: Record<string, Record<string, string>[]>,
  rootType?: string,
): Promise<GenerateLeanResult> {
  const kept = keptFor(types, Object.keys(rowsByType ?? {}), rootType);
  if (!kept.length) throw new Error("No valid object types to export.");
  return buildLeanWorkbook(kept, rowsByType);
}

async function buildLeanWorkbook(
  kept: KeptSheet[],
  rowsByType?: Record<string, Record<string, string>[]>,
): Promise<GenerateLeanResult> {
  const meta = await loadMeta();
  const wb = new ExcelJS.Workbook();

  // ---- Index: header + 7 default rows + one row per kept object sheet ----
  // Values come from the source Index; styling is the client's deterministic
  // colour scheme (see indexRowFill / indexRow) so the trimmed Index matches
  // the client's reference look (highlight fills + red underlined tab names).
  const idxRows = meta.index.rows;
  const vals = (r: Cell[] | undefined, n: number): string[] =>
    Array.from({ length: n }, (_, i) => r?.[i]?.v ?? "");
  const idxHeaderVals = vals(idxRows[0], 4).some((v) => v)
    ? vals(idxRows[0], 4)
    : ["Tab Name", "Object Type", "Description", "Execution Order"];
  const default7 = idxRows.slice(1, 8); // Index, Config, Formats, Assumptions, Entities, WNM, Enums
  const srcIndexByRaw = new Map<string, string[]>();
  for (const r of idxRows) if (r[0]?.v) srcIndexByRaw.set(String(r[0].v).trim(), vals(r, 4));

  const idxWs = wb.addWorksheet("Index");
  addStyledRow(idxWs, idxHeaderVals.map((v) => ({ v, bold: true }))); // bold header
  // Execution Order (col 4): the 7 meta rows are all 0 (template scaffolding,
  // not loadable objects). Then, matching the reference KSP_DL_AI.xlsx Index:
  // the counter increments ONCE PER PARENT object (prefixed <XX> sheet), and
  // every SUB-SHEET inherits its parent's number — e.g. <DM>Step and all of
  // StepReason/StepSamplingPlan/StepLogicalName/… share Execution Order 55.
  // A parent + its sub-sheets load together as one "wave", so they share one
  // number rather than each taking its own sequence value.
  let execSeq = 0;
  for (const r of default7) {
    const rv = vals(r, 4);
    rv[3] = "0";
    addStyledRow(idxWs, indexRow(rv, indexRowFill(rv[0])));
  }
  // Correct WorksheetNameMapping rows come from the TEMPLATE's own WNM, keyed by
  // col A — the abbreviated tab name CMF looks up AFTER stripping the leading
  // <TYPE> tag. Constructing the entry from our `raw` produced a wrong key (e.g.
  // "<LOOKUP>MaterialDCContext" instead of "MaterialDCContext"), so CMF's load
  // validation aborted with "<LOOKUP> name MaterialDCContext was not found in the
  // worksheet WorksheetNameMapping". Reuse the template's exact [colA, colB] rows.
  const tplWnmByColA = new Map<string, [string, string]>();
  for (const row of (meta.sheets["WorksheetNameMapping"]?.rows ?? []).slice(1)) {
    const a = (row[0]?.v ?? "").trim();
    if (a) tplWnmByColA.set(a.toLowerCase(), [a, (row[1]?.v ?? "").trim()]);
  }
  const wnmEntries: [string, string][] = [];
  for (const k of kept) {
    const { tab, needsMapping } = resolveSheetName(k.objectType, k.raw);
    const src = srcIndexByRaw.get(k.raw);
    // Keep the source Tab Name / Object Type / Description, but use the running
    // per-parent wave number for Execution Order.
    const rv = src ? [src[0] ?? k.raw, src[1] ?? "", src[2] ?? "", ""] : [k.raw, "", "", ""];
    const isParent = /^<[^>]+>/.test(k.raw); // parents carry a <SM>/<DM>/<ST>/… prefix; sub-sheets don't
    if (isParent) execSeq++;
    rv[3] = String(execSeq || 1); // sub-sheets inherit the current parent's number
    addStyledRow(idxWs, indexRow(rv)); // object rows PLAIN (no fill) — only the 7 defaults are highlighted
    if (needsMapping) {
      const stripped = k.raw.replace(/^<[^>]+>/, "").trim().toLowerCase();
      wnmEntries.push(tplWnmByColA.get(stripped) ?? [tab, k.raw]);
    }
  }
  applyCols(idxWs, meta.index.cols);
  // Header autofilter (the dropdowns the client's Index has).
  const lastCol = Math.max(idxHeaderVals.length, 4);
  idxWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: idxWs.rowCount, column: lastCol } };

  // ---- Config / Formats / Assumptions: verbatim copy (styled) ----
  for (const name of ["Config", "Formats", "Assumptions"] as const) {
    const ws = wb.addWorksheet(name);
    for (const r of meta.sheets[name].rows) addStyledRow(ws, r);
    applyCols(ws, meta.sheets[name].cols);
  }

  // ---- WorksheetNameMapping: styled header + only the emitted-sheet mappings ----
  const wnmSrc = meta.sheets["WorksheetNameMapping"];
  const wnmWs = wb.addWorksheet("WorksheetNameMapping");
  addStyledRow(wnmWs, wnmSrc.rows[0] ?? [{ v: "WorksheetName", bold: true }, { v: "Value", bold: true }]);
  for (const [tab, raw] of wnmEntries) wnmWs.addRow([tab, raw]);
  applyCols(wnmWs, wnmSrc.cols);

  // ---- Enums: verbatim copy (styled) ----
  const enumsWs = wb.addWorksheet("Enums");
  for (const r of meta.sheets["Enums"].rows) addStyledRow(enumsWs, r);
  applyCols(enumsWs, meta.sheets["Enums"].cols);

  // ---- object sheet(s): header (canonical columns) + optional data rows ----
  const valueFor = (row: Record<string, string>, col: string): string => {
    if (col in row) return row[col] ?? "";
    const lower = col.toLowerCase();
    for (const kk of Object.keys(row)) if (kk.toLowerCase() === lower) return row[kk] ?? "";
    return "";
  };
  // Source header styles + comments + column widths for the object sheets, so the
  // rebuilt sheet keeps the client's look (the x14 dropdowns can't be reproduced
  // from scratch — that needs the sheet-preservation path which breaks CMF).
  const richByRaw = await loadObjectRich(kept.map((k) => k.raw));
  const emitted: LeanSheet[] = [];
  for (const k of kept) {
    const { tab } = resolveSheetName(k.objectType, k.raw);
    const ws = wb.addWorksheet(tab);
    const rich = richByRaw.get(k.raw);
    const header = ws.addRow(k.columns);
    k.columns.forEach((_, i) => {
      const cell = header.getCell(i + 1);
      const hs = rich?.header[i + 1];
      if (hs?.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hs.fill } };
      cell.font = { bold: hs?.bold ?? true, ...(hs?.fontColor ? { color: { argb: hs.fontColor } } : {}) };
      const cmt = rich?.comments.find((c) => c.col === i + 1);
      if (cmt?.text) cell.note = cmt.text;
    });
    applyCols(ws, rich?.cols ?? []);
    const rows = rowsByType?.[k.objectType] ?? [];
    if (rows.length > 0) {
      for (const row of rows) ws.addRow(k.columns.map((c) => valueFor(row, c)));
    } else if (rich && Object.keys(rich.row2).length > 0) {
      // blank template: reproduce the source's styled example row 2 (empty + fills)
      const r2 = ws.addRow(k.columns.map(() => null));
      k.columns.forEach((_, i) => {
        const rs = rich.row2[i + 1];
        if (rs?.fill) r2.getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: rs.fill } };
      });
    }
    emitted.push({ objectType: k.objectType, raw: k.raw, columns: k.columns, tab });
  }

  const out = await wb.xlsx.writeBuffer();
  const bytes = Buffer.from(out as ArrayBuffer);
  return {
    bytes,
    objectSheets: emitted,
    allSheets: wb.worksheets.map((w) => w.name),
  };
}
