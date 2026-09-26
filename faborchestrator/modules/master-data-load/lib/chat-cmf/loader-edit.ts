import JSZip from "jszip";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";
import { canonicalType } from "@/modules/master-data-load/lib/chat-cmf/dependency-resolver";
import { buildSheetIndex } from "@/modules/master-data-load/lib/validation/ksp-skeleton";
import { getRemovedColumns } from "@/modules/master-data-load/lib/validation/removal-policy";
import { createStagedUpload, getStagedUpload } from "@/modules/master-data-load/lib/repo-cmf/validation";

/**
 * Scope 3 (remove) — take an object type (or specific named rows) OUT of the
 * loader currently staged in this session.
 *
 * We edit ONLY the target sheet's <sheetData> in place (JSZip), leaving every
 * other part of the workbook byte-for-byte. This is the exact inverse of the
 * append that generateFromSkeleton does — CMF accepts appended files, so
 * removing rows the same way is equally safe, and it avoids two traps:
 *   - ExcelJS OOMs when it tries to load a full ~175-sheet KSP workbook, so we
 *     never parse the whole file (validateTemplate has the same constraint);
 *   - structural OOXML surgery (removing sheets / Index rows) reliably breaks
 *     CMF — we touch nothing structural, only data rows inside one sheet.
 * Cells are written by the generator as inline strings (t="inlineStr"), so we
 * can read the row's Name without the shared-strings table. The skeleton marker
 * is preserved, so validateTemplate's fast path still applies.
 *
 * (Adding an object uses generateExcel with startFromStagingId — no new tool.)
 */

const RESERVED = new Set(["$order", "$ambiguous"]);
const SCHEMA = templateSchema as unknown as Record<string, { raw: string; columns: string[] }>;

export type RemoveFromLoaderResult = {
  stagingId?: string;
  filename?: string;
  objectType: string;
  removedRows: number;
  remainingRows: number;
  error?: string;
};

function colLetters(idx0: number): string {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const decodeXml = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Inline-string (or <v>) text of the cell at column letter `col` in a <row>. */
function cellText(rowXml: string, col: string): string {
  const re = new RegExp(
    `<c\\s+r="${col}\\d+"[^>]*>(?:<is><t[^>]*>([\\s\\S]*?)</t></is>|<v>([\\s\\S]*?)</v>)</c>`,
  );
  const m = re.exec(rowXml);
  if (!m) return "";
  return decodeXml((m[1] ?? m[2] ?? "").trim());
}

/** Renumber a <row> (and its cells' refs) from `oldNum` to `newNum`. */
function renumberRow(rowXml: string, oldNum: number, newNum: number): string {
  if (oldNum === newNum) return rowXml;
  // The closing quote anchors the match so r="A2" is not hit when oldNum=22 etc.
  return rowXml.replace(new RegExp(`r="([A-Z]*)${oldNum}"`, "g"), (_m, col) =>
    col ? `r="${col}${newNum}"` : `r="${newNum}"`,
  );
}

export async function removeFromLoader(input: {
  userId: string;
  stagingId: string;
  objectType: string;
  rowNames?: string[];
  packageName?: string;
}): Promise<RemoveFromLoaderResult> {
  const target = canonicalType(input.objectType) ?? input.objectType;
  const entry = Object.entries(SCHEMA).find(
    ([k, v]) => !RESERVED.has(k) && k.toLowerCase() === target.toLowerCase() && v?.columns,
  )?.[1];
  if (!entry) {
    return { objectType: target, removedRows: 0, remainingRows: 0, error: `"${target}" isn't a known object type.` };
  }

  const staged = await getStagedUpload(input.stagingId, input.userId);
  if (!staged) {
    return { objectType: target, removedRows: 0, remainingRows: 0, error: `Loader ${input.stagingId} not found.` };
  }

  const zip = await JSZip.loadAsync(staged.bytes);
  const sheets = await buildSheetIndex(zip);
  const sheet = sheets.find((s) => s.name === entry.raw);
  if (!sheet) {
    return { objectType: target, removedRows: 0, remainingRows: 0, error: `"${target}" has no sheet in this loader.` };
  }

  const sheetXml = await zip.file(sheet.path)!.async("text");
  const dataMatch = sheetXml.match(/<sheetData(?:\s[^>]*)?>([\s\S]*?)<\/sheetData>/);
  if (!dataMatch) {
    return { objectType: target, removedRows: 0, remainingRows: 0, error: `"${target}" sheet has no data area.` };
  }

  // Split the sheet's rows into the header (r=1) and data rows (r>=2). KSP
  // sheets ship with ~49 pre-styled BLANK rows before any data; the generator
  // appends real values after them. We only ever remove data-BEARING rows and
  // keep the styled blanks, so the file stays shaped exactly like a freshly
  // generated one (which CMF accepts).
  const hasContent = (row: string) => /<c\b[^>]*>(?:<is>|<v>)/.test(row);
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g;
  let headerXml = "";
  const dataRows: string[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(dataMatch[1]))) {
    if (Number(rm[1]) === 1) headerXml = rm[0];
    else dataRows.push(rm[0]);
  }
  const contentBefore = dataRows.filter(hasContent).length;

  // Which cell holds Name (column letter among the kept columns)?
  const removed = getRemovedColumns(target);
  const kept = entry.columns.filter((c) => !removed.has(c.toLowerCase()));
  const nameIdx = kept.findIndex((c) => c.toLowerCase() === "name");

  let dropRow: (row: string) => boolean;
  if (input.rowNames?.length) {
    if (nameIdx < 0) {
      return { objectType: target, removedRows: 0, remainingRows: contentBefore, error: `"${target}" has no Name column, so rows can't be removed by name — omit rowNames to clear the whole type.` };
    }
    const nameCol = colLetters(nameIdx);
    const drop = new Set(input.rowNames.map((n) => n.trim().toLowerCase()));
    dropRow = (r) => hasContent(r) && drop.has(cellText(r, nameCol).toLowerCase());
  } else {
    dropRow = (r) => hasContent(r); // clear every data row, keep styled blanks
  }
  const keep = dataRows.filter((r) => !dropRow(r));
  const removedRows = dataRows.length - keep.length;
  const remainingContent = keep.filter(hasContent).length;

  // Renumber kept rows to 2,3,… and rewrite the sheet's data area only.
  const renumbered = keep.map((r, i) => {
    const oldNum = Number(/\br="(\d+)"/.exec(r)![1]);
    return renumberRow(r, oldNum, i + 2);
  });
  const newInner = headerXml + renumbered.join("");
  const newSheetXml = sheetXml.replace(
    /(<sheetData(?:\s[^>]*)?>)[\s\S]*?(<\/sheetData>)/,
    (_m, open, close) => open + newInner + close,
  );
  zip.file(sheet.path, newSheetXml);

  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const filename = staged.filename.replace(/\.xlsx$/i, "") + "_edited.xlsx";
  const newStaged = await createStagedUpload({
    userId: input.userId,
    filename,
    bytes,
    packageName: input.packageName,
  });

  return { stagingId: newStaged.id, filename, objectType: target, removedRows, remainingRows: remainingContent };
}
