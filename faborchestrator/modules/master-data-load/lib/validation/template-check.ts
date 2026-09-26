import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";
import { parseWorkbook, stripPrefix } from "@/modules/master-data-load/lib/validation/xlsx";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { isSystemManaged } from "@/modules/master-data-load/lib/validation/system-columns";
import requiredFieldsData from "@/modules/master-data-load/lib/validation/required-fields.json";

/**
 * Precomputed required user-fillable fields per object type (CMF-mandatory minus
 * system-managed, template columns only). Built from CMF SQL metadata by
 * scripts/_buildreq. When an object isn't listed here the validator falls back
 * to a LIVE CMF metadata lookup, then to Name — so this file is a fast/offline
 * cache, never the sole source of truth.
 */
const REQUIRED_BY_LOWER = new Map<string, string[]>(
  Object.entries(requiredFieldsData as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith("$") && Array.isArray(v))
    .map(([k, v]) => [k.toLowerCase(), (v as string[]).slice()]),
);
import type { ParsedSheet, ValidationError, ValidationResult } from "@/modules/master-data-load/lib/validation/types";

/**
 * Master-data "template check" — a Name-only MANDATORY-field gate.
 *
 * The reference template (templates/KSP_DL_AI.xlsx, precomputed into
 * template-schema.json) marks exactly one field mandatory for every object —
 * its `Name` (Assumptions sheet: "Name Field is Mandatory"). This check enforces
 * only that, offline, before any CMF call:
 *   • a recognized object whose template defines a Name column must supply a
 *     Name column and fill it on every data row;
 *   • an unrecognized sheet is NOT rejected (leniency lets valid newer objects
 *     reach CMF) — we only require Name if the sheet happens to carry one.
 *
 * Everything else — unknown sheets, extra/missing non-key columns, sheet and
 * column order, parent/child referential — is deliberately NOT checked here;
 * CMF's own dry-run validation (op=1) is the authority on those.
 *
 * The workbook is read with ExcelJS in STREAMING mode (which only emits rows
 * that actually exist) — never `wb.xlsx.load` + getRow, which materializes every
 * row index up to a sheet's (often inflated) rowCount and is pathologically slow
 * on the 200+ sheet master-data files.
 */

// template-schema.json holds per-type column definitions (built from the
// reference template) plus reserved keys. For the Name-only check we only need
// each type's column list — to know whether a recognized object is expected to
// carry a (mandatory) Name field.
type TemplateEntry = { raw: string; columns: string[] };
const RAW = templateSchema as Record<string, unknown>;
const RESERVED = new Set(["$order", "$ambiguous"]);
const SCHEMA_BY_LOWER = new Map(
  Object.entries(RAW)
    .filter(([k]) => !RESERVED.has(k))
    .map(([k, v]) => [k.toLowerCase(), v as TemplateEntry]),
);

/** True when the type is a recognized template object at all. */
function isKnownType(objectType: string): boolean {
  return SCHEMA_BY_LOWER.has(objectType.toLowerCase());
}

/** True when the reference template defines a `Name` column for this type. */
function templateHasName(objectType: string): boolean {
  const e = SCHEMA_BY_LOWER.get(objectType.toLowerCase());
  return !!e && e.columns.some((c) => c.toLowerCase() === "name");
}

const META = new Set([
  "cover", "index", "config", "formats", "assumptions", "worksheetnamemapping", "enums",
]);
function cellStr(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("text" in o) return String(o.text ?? "").trim();
    if ("result" in o) return String(o.result ?? "").trim();
    if (Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("").trim();
    }
  }
  return String(v).trim();
}

const XML_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITY[e.toLowerCase()] ?? m;
  });
}

/**
 * Sheet names keyed by worksheet FILE number ("1" for xl/worksheets/sheet1.xml),
 * read straight from xl/workbook.xml and its rels.
 *
 * ExcelJS's streaming reader names a sheet only when its rel Target is exactly
 * `worksheets/sheetN.xml`. Workbooks written by openpyxl / pandas (and some
 * exporters) use the absolute form `/xl/worksheets/sheetN.xml` and carry no
 * sharedStrings part, and on those the reader returns the FIRST sheet only,
 * named "Sheet1": the object type was lost, the Name-only check passed (an
 * unknown type is not rejected), every other sheet vanished, and CMF was
 * handed a workbook it could not map. Excel's own files were never affected,
 * which is why it went unnoticed. This list is what the streamed result is
 * checked against; when it does not match, the full parser reads the file.
 * Best-effort: any failure here disables the check.
 */
async function sheetNamesFromWorkbookXml(buf: Buffer): Promise<Map<string, string>> {
  const byFileNo = new Map<string, string>();
  try {
    const zip = await JSZip.loadAsync(buf);
    const wbXml = await zip.file("xl/workbook.xml")?.async("string");
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (!wbXml || !relsXml) return byFileNo;
    const relToFileNo = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      const id = /\bId="([^"]+)"/.exec(tag)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      const fileNo = target ? /worksheets\/sheet(\d+)\.xml$/i.exec(target)?.[1] : undefined;
      if (id && fileNo) relToFileNo.set(id, fileNo);
    }
    for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
      const tag = m[0];
      const name = /\bname="([^"]*)"/.exec(tag)?.[1];
      const rId = /\b[\w.]*:?id="([^"]+)"/.exec(tag)?.[1];
      const fileNo = rId ? relToFileNo.get(rId) : undefined;
      if (name && fileNo) byFileNo.set(fileNo, decodeXml(name));
    }
  } catch {
    /* fall through — ExcelJS's own names are used */
  }
  return byFileNo;
}

/**
 * Stream the workbook into ParsedSheet[] (object type + ordered headers + data
 * rows). Streaming only yields populated rows, so this is fast even on files
 * with hundreds of sheets and inflated row counts.
 */
async function readSheetsStreaming(bytes: ArrayBuffer | Buffer): Promise<ParsedSheet[]> {
  const tmp = join(tmpdir(), `mdv-${randomUUID()}.xlsx`);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes));
  await writeFile(tmp, buf);
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(tmp, {
      worksheets: "emit",
      sharedStrings: "cache",
      entries: "emit",
    });
    const nameMap = new Map<string, string>();
    // Resolve object types AFTER the pass: WorksheetNameMapping may stream after
    // the data sheets, so collect raw sheets first then map names.
    const raw: { rawName: string; headers: string[]; rows: Record<string, string>[] }[] = [];

    // The workbook's own sheet list (see sheetNamesFromWorkbookXml): the
    // streamed result must account for every sheet, under its real name.
    const expected = await sheetNamesFromWorkbookXml(buf);
    const realNames = new Set(expected.values());
    let yielded = 0;
    let unnamed: string | null = null;

    for await (const ws of reader) {
      const name = (ws as { name?: string }).name ?? "";
      yielded += 1;
      if (/^Sheet\d+$/.test(name) && expected.size > 0 && !realNames.has(name)) unnamed = name;
      if (name.toLowerCase() === "worksheetnamemapping") {
        for await (const row of ws) {
          if (row.number === 1) continue;
          const cells: string[] = [];
          row.eachCell({ includeEmpty: false }, (c) => cells.push(cellStr(c.value)));
          if (cells.length >= 2 && cells[0] && cells[1]) {
            nameMap.set(cells[0].toLowerCase(), cells[1]);
            nameMap.set(stripPrefix(cells[0]).toLowerCase(), cells[1]);
          }
        }
        continue;
      }
      if (!name || name.startsWith("_xlnm") || META.has(name.toLowerCase())) continue;

      // header name -> 1-based column number (positional, so blank gaps don't shift)
      const headerCols = new Map<number, string>();
      const headers: string[] = [];
      const rows: Record<string, string>[] = [];
      for await (const row of ws) {
        if (row.number === 1) {
          row.eachCell({ includeEmpty: false }, (c, col) => {
            const s = cellStr(c.value);
            if (s) {
              headerCols.set(col, s);
              headers.push(s);
            }
          });
          continue;
        }
        if (headerCols.size === 0) break; // no headers — nothing to map rows onto
        const obj: Record<string, string> = {};
        let hasValue = false;
        for (const [col, h] of headerCols) {
          const s = cellStr(row.getCell(col).value);
          if (s) hasValue = true;
          obj[h] = s;
        }
        if (hasValue) rows.push(obj);
      }
      if (headers.length === 0) continue;
      raw.push({ rawName: name, headers, rows });
    }

    // Incomplete or unnamed → let readUpload fall back to the full parser,
    // which reads these workbooks correctly (verified on openpyxl output).
    if (expected.size > 0 && (yielded < expected.size || unnamed)) {
      throw new Error(
        unnamed
          ? `streaming reader could not resolve sheet names (got "${unnamed}")`
          : `streaming reader returned ${yielded} of ${expected.size} sheets`,
      );
    }

    return raw.map((r) => {
      const mapped =
        nameMap.get(r.rawName.toLowerCase()) ?? nameMap.get(stripPrefix(r.rawName).toLowerCase());
      return { objectType: stripPrefix(mapped ?? r.rawName), headers: r.headers, rows: r.rows };
    });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function readUpload(bytes: ArrayBuffer | Buffer): Promise<ParsedSheet[]> {
  try {
    return await readSheetsStreaming(bytes);
  } catch (err) {
    // Robust (slower) fallback for unusual workbooks the streaming reader chokes on.
    console.warn("[template-check] streaming read failed; falling back to full parse", err);
    return parseWorkbook(bytes);
  }
}

/**
 * Comprehensive required-field check — ONE pass that collects EVERY issue (every
 * sheet, every required field, every row) so the user sees all problems at once
 * instead of fixing them one at a time. For each sheet with data it loads the
 * object's CMF field metadata to learn ALL mandatory fields; when metadata is
 * unavailable it falls back to the Name field. Messages name the exact column,
 * sheet and row, e.g. `"Name" is required and cannot be empty (row 2).`
 */
async function checkRequiredFields(sheets: ParsedSheet[]): Promise<ValidationError[]> {
  const out: ValidationError[] = [];
  for (const s of sheets) {
    if (s.rows.length === 0) continue;

    // The required fields for this object. Prefer the precomputed cache (fast,
    // offline); else look them up LIVE from CMF metadata; else fall back to Name.
    let mandatory: string[] = [];
    const precomputed = REQUIRED_BY_LOWER.get(s.objectType.toLowerCase());
    if (precomputed) {
      mandatory = precomputed;
    } else {
      let ruleset: Awaited<ReturnType<typeof loadRuleset>> = null;
      try {
        ruleset = await loadRuleset(s.objectType);
      } catch {
        ruleset = null;
      }
      if (ruleset) {
        // Only require fields that are (a) mandatory, (b) NOT system-managed
        // (CreatedBy/Id/Version/UniversalState/… — CMF auto-fills these; humans
        // never do), and (c) actually part of this object's template columns.
        const schemaCols = SCHEMA_BY_LOWER.get(s.objectType.toLowerCase())?.columns;
        const inTemplate = schemaCols ? new Set(schemaCols.map((c) => c.toLowerCase())) : null;
        mandatory = ruleset.properties
          .filter((p) => p.mandatory && !isSystemManaged(p.name) && (!inTemplate || inTemplate.has(p.name.toLowerCase())))
          .map((p) => p.name);
      } else if (isKnownType(s.objectType) && templateHasName(s.objectType)) {
        mandatory = ["Name"];
      }
    }
    if (mandatory.length === 0) continue;

    const headerByLower = new Map(s.headers.map((h) => [h.toLowerCase(), h] as const));
    for (const field of mandatory) {
      const header = headerByLower.get(field.toLowerCase());
      // Required column entirely absent → one error for the sheet.
      if (!header) {
        out.push({
          objectType: s.objectType,
          row: null,
          column: field,
          severity: "error",
          message: `The "${field}" column is required but is missing from the ${s.objectType} sheet.`,
        });
        continue;
      }
      // Column present → flag every row where the required value is blank.
      const emptyRows: number[] = [];
      s.rows.forEach((row, i) => {
        if (!(row[header] ?? "").trim()) emptyRows.push(i + 1);
      });
      if (emptyRows.length === 0) continue;
      if (emptyRows.length === s.rows.length) {
        out.push({
          objectType: s.objectType,
          row: null,
          column: field,
          severity: "error",
          message: `"${field}" is required and cannot be empty — it is blank in every row. Please fill it in.`,
        });
      } else {
        for (const r of emptyRows) {
          out.push({
            objectType: s.objectType,
            row: r,
            column: field,
            severity: "error",
            message: `"${field}" is required and cannot be empty (row ${r}).`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Run every conformance check over already-parsed sheets in ONE pass and return
 * all findings together: empty-file, no-data, and required-field (all fields /
 * rows). Shared by validateAgainstTemplate and the loader's validate route so a
 * caller that already read the workbook doesn't parse it twice.
 */
export async function validateSheetsComprehensive(sheets: ParsedSheet[]): Promise<ValidationResult> {
  const errorsByType: Record<string, ValidationError[]> = {};
  const add = (e: ValidationError) => (errorsByType[e.objectType] ??= []).push(e);

  if (sheets.length === 0) {
    add({ objectType: "File", row: null, column: null, severity: "error", message: "The file has no data sheets to validate." });
  }
  const totalDataRows = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (sheets.length > 0 && totalDataRows === 0) {
    add({ objectType: "File", row: null, column: null, severity: "error", message: "This file has no data rows to load. Fill in at least one row before loading." });
  } else {
    for (const e of await checkRequiredFields(sheets)) add(e);
  }

  const errorCount = Object.values(errorsByType).reduce((n, l) => n + l.length, 0);
  return { ok: errorCount === 0, errorsByType, errorCount, warningCount: 0, infoCount: 0 };
}

export async function validateAgainstTemplate(
  bytes: ArrayBuffer | Buffer,
): Promise<ValidationResult> {
  let sheets: ParsedSheet[];
  try {
    sheets = await readUpload(bytes);
  } catch (err) {
    console.error("[template-check] failed to read workbook", err);
    return {
      ok: false,
      errorsByType: {
        File: [
          {
            objectType: "File",
            row: null,
            column: null,
            severity: "error",
            message: "The file could not be read as an Excel workbook. Re-export it and try again.",
          },
        ],
      },
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
    };
  }
  return validateSheetsComprehensive(sheets);
}

/** Read an uploaded workbook into sheets using the fast streaming path. */
export function readUploadSheets(bytes: ArrayBuffer | Buffer): Promise<ParsedSheet[]> {
  return readUpload(bytes);
}

/**
 * Conformance + structure checks over already-read sheets. Exposed so a caller
 * that has read the workbook (e.g. to also generate LLM explanations) doesn't
 * have to read it twice.
 */
export function validateParsedSheets(sheets: ParsedSheet[]): ValidationResult {
  const errorsByType: Record<string, ValidationError[]> = {};
  const add = (e: ValidationError) => {
    (errorsByType[e.objectType] ??= []).push(e);
  };

  if (sheets.length === 0) {
    add({
      objectType: "File",
      row: null,
      column: null,
      severity: "error",
      message: "The file has no data sheets to validate.",
    });
  }

  for (const s of sheets) {
    // Empty sheets (headers only) load nothing — a master-data package routinely
    // ships 200+ blank template tabs. Nothing mandatory to check on them.
    if (s.rows.length === 0) continue;

    const nameHeader = s.headers.find((h) => h.toLowerCase() === "name");
    const expectsName = isKnownType(s.objectType) && templateHasName(s.objectType);

    // A recognized object that HAS data but omitted its mandatory Name column.
    if (expectsName && !nameHeader) {
      add({
        objectType: s.objectType,
        row: null,
        column: "Name",
        severity: "error",
        message: `"${s.objectType}" requires a mandatory "Name" column, which is missing from this sheet.`,
      });
      continue;
    }

    // No Name column present and none expected (e.g. a sub-sheet keyed
    // differently, or a newer object we don't recognize) → nothing mandatory
    // to check here.
    if (!nameHeader) continue;

    // Every data row must fill Name.
    s.rows.forEach((row, i) => {
      const v = (row[nameHeader] ?? "").trim();
      if (!v) {
        add({
          objectType: s.objectType,
          row: i + 1,
          column: nameHeader,
          severity: "error",
          message: `Row ${i + 1} is missing the mandatory "Name" value.`,
        });
      }
    });
  }

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const list of Object.values(errorsByType)) {
    for (const e of list) {
      if (e.severity === "error") errorCount++;
      else if (e.severity === "warning") warningCount++;
      else infoCount++;
    }
  }

  return { ok: errorCount === 0, errorsByType, errorCount, warningCount, infoCount };
}
