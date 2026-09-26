import ExcelJS from "exceljs";
import type { ParsedSheet } from "@/modules/master-data-load/lib/validation/types";

/**
 * Parse a master-data .xlsx into per-object-type sheets. Handles two CMF
 * conventions:
 *  - sheet-name prefixes like `<ST>`, `<DM>`, `<LOOKUP>` (stripped), and
 *  - the `WorksheetNameMapping` sheet, which maps (often truncated, ≤31-char)
 *    worksheet names to their real object type — Excel truncates long names.
 * Config/meta sheets are skipped.
 */

const META_SHEETS = new Set([
  "index", "config", "formats", "assumptions", "worksheetnamemapping", "enums",
]);

export function stripPrefix(name: string): string {
  return name.replace(/^<[^>]+>/, "").trim();
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("text" in v) return String(v.text ?? "").trim();
    if ("result" in v) return String(v.result ?? "").trim();
    if ("richText" in v && Array.isArray(v.richText)) {
      return v.richText.map((rt: { text?: string }) => rt.text ?? "").join("").trim();
    }
    if ("hyperlink" in v && "text" in v) return String(v.text ?? "").trim();
  }
  return String(value).trim();
}

function buildNameMapping(ws: ExcelJS.Worksheet): Map<string, string> {
  // First two non-empty columns per row: worksheet name -> object type.
  const map = new Map<string, string>();
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (c) => cells.push(cellToString(c.value)));
    if (cells.length >= 2 && cells[0] && cells[1]) {
      map.set(cells[0].toLowerCase(), cells[1]);
      map.set(stripPrefix(cells[0]).toLowerCase(), cells[1]);
    }
  });
  return map;
}

export async function parseWorkbook(bytes: ArrayBuffer | Buffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const mappingWs = wb.worksheets.find(
    (w) => w.name.toLowerCase() === "worksheetnamemapping",
  );
  const nameMap = mappingWs ? buildNameMapping(mappingWs) : new Map<string, string>();

  const sheets: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const raw = ws.name;
    if (raw.startsWith("_xlnm") || META_SHEETS.has(raw.toLowerCase())) continue;

    const stripped = stripPrefix(raw);
    const mapped =
      nameMap.get(raw.toLowerCase()) ?? nameMap.get(stripped.toLowerCase());
    // The mapping value may itself carry a `<XX>` prefix — strip it too.
    const objectType = stripPrefix(mapped ?? stripped);
    if (!objectType) continue;

    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: false }, (c) => headers.push(cellToString(c.value)));
    if (headers.length === 0) continue;

    const rows: Record<string, string>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const excelRow = ws.getRow(r);
      const obj: Record<string, string> = {};
      let hasValue = false;
      headers.forEach((h, idx) => {
        if (!h) return;
        const s = cellToString(excelRow.getCell(idx + 1).value);
        if (s) hasValue = true;
        obj[h] = s;
      });
      if (hasValue) rows.push(obj);
    }

    sheets.push({ objectType, headers, rows });
  }
  return sheets;
}
