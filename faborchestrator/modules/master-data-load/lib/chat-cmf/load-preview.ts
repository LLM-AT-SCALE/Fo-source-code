import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { readUploadSheets } from "@/modules/master-data-load/lib/validation/template-check";
import { isObjectRemoved, isColumnRemoved } from "@/modules/master-data-load/lib/validation/removal-policy";

/**
 * Per-row impact preview for a staged .xlsx — Phase 2 of the AI Template
 * Builder.
 *
 * Before the user commits a load to CMF, we tell them exactly what will
 * happen for each row:
 *   - CREATE       row's Name doesn't exist in CMF yet
 *   - UPDATE       row exists, at least one column the user supplied differs
 *   - SKIP         row exists and every supplied column matches
 *   - CONFLICT     row references a parent (FK) that's missing in CMF
 *
 * Atomic-batch reminder: CMF's loader rejects the WHOLE package if any row
 * is a CONFLICT. We surface those clearly so the user can fix or remove them
 * before clicking Load.
 *
 * Implementation: one batched IN-query per object type, plus one batched
 * IN-query per FK target table to validate references. Cheap and scales
 * well for typical chatbot inputs (≤50 rows).
 */

type RowVerdict = "CREATE" | "UPDATE" | "SKIP" | "CONFLICT";

type RowImpact = {
  rowIndex: number;
  name: string;
  verdict: RowVerdict;
  /** Columns whose value would change (UPDATE) or are missing/invalid (CONFLICT). */
  changedColumns?: string[];
  conflicts?: string[]; // e.g. "Site=SITE-Q (missing)"
};

type SheetImpact = {
  objectType: string;
  totalRows: number;
  byVerdict: Record<RowVerdict, number>;
  rows: RowImpact[];
};

export type LoadPreviewResult = {
  sheets: SheetImpact[];
  /** Any row with verdict=CONFLICT will block the whole batch. */
  blockingConflicts: number;
  metadataMissing: boolean;
};

export async function previewLoadImpact(
  bytes: Buffer,
): Promise<LoadPreviewResult> {
  const sheets = await readUploadSheets(bytes);

  const out: SheetImpact[] = [];
  let blockingConflicts = 0;
  let metadataMissing = false;

  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue;
    if (isObjectRemoved(sheet.objectType)) {
      // Treat the whole sheet as a conflict so the load is blocked.
      out.push({
        objectType: sheet.objectType,
        totalRows: sheet.rows.length,
        byVerdict: { CREATE: 0, UPDATE: 0, SKIP: 0, CONFLICT: sheet.rows.length },
        rows: sheet.rows.map((r, i) => ({
          rowIndex: i + 1,
          name: String((r as Record<string, string>).Name ?? `row-${i + 1}`),
          verdict: "CONFLICT" as const,
          conflicts: [`Object "${sheet.objectType}" has been removed from the client's template.`],
        })),
      });
      blockingConflicts += sheet.rows.length;
      continue;
    }
    const ruleset = await loadRuleset(sheet.objectType);
    if (!ruleset?.table) {
      metadataMissing = true;
      // Without metadata we can't predict — mark every row as CREATE
      // optimistically and let CMF be the final authority.
      out.push({
        objectType: sheet.objectType,
        totalRows: sheet.rows.length,
        byVerdict: { CREATE: sheet.rows.length, UPDATE: 0, SKIP: 0, CONFLICT: 0 },
        rows: sheet.rows.map((_, i) => ({
          rowIndex: i + 1,
          name: String((sheet.rows[i] as Record<string, string>).Name ?? `row-${i + 1}`),
          verdict: "CREATE",
        })),
      });
      continue;
    }

    // 1. Look up existing rows by Name in one batched query. Project ONLY
    //    [Name] + the columns the user actually supplied in the rows. Some CMF
    //    properties (e.g. `Id`) are flagged in metadata but aren't physical
    //    columns on every table → projecting them blindly produces
    //    "Invalid column name 'Id'". User-supplied columns are exactly what we
    //    need to diff CREATE / UPDATE / SKIP, so a narrower projection is both
    //    safer and faster.
    const names = sheet.rows.map((r) => String(r.Name ?? "").trim()).filter(Boolean);
    const existing = new Map<string, Record<string, string>>();
    if (names.length > 0) {
      const userColLower = new Set<string>();
      for (const row of sheet.rows) {
        for (const k of Object.keys(row as Record<string, string>)) {
          userColLower.add(k.toLowerCase());
        }
      }
      const propByLower = new Map(ruleset.properties.map((p) => [p.name.toLowerCase(), p.name]));
      // Always include Name; add any user-supplied column that exists in the
      // ruleset and hasn't been removed from this object's template.
      const projCols = new Set<string>(["Name"]);
      for (const lower of userColLower) {
        const canon = propByLower.get(lower);
        if (canon && !isColumnRemoved(ruleset.objectType, canon)) projCols.add(canon);
      }
      const params: Record<string, string> = {};
      const placeholders: string[] = [];
      names.forEach((n, i) => {
        params[`n${i}`] = n;
        placeholders.push(`@n${i}`);
      });
      const cols = [...projCols].map((c) => `[${c}]`).join(", ");
      const sql = `select ${cols} from [${ruleset.table.schema}].[${ruleset.table.name}] where [Name] in (${placeholders.join(", ")})`;
      const found = await cmfQuery<Record<string, unknown>>(sql, params);
      for (const r of found) {
        const n = String(r.Name ?? "").trim();
        if (!n) continue;
        const s: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) s[k] = v == null ? "" : String(v);
        existing.set(n, s);
      }
    }

    // 2. Validate FK references — collect distinct values per target and
    //    issue one IN-query each.
    const fkProps = ruleset.properties.filter((p) => p.referenceTargetType);
    const fkExistingByTarget = new Map<string, Set<string>>();
    const fkValuesByTarget = new Map<string, Set<string>>();
    for (const p of fkProps) {
      const target = p.referenceTargetType!;
      if (!fkValuesByTarget.has(target)) fkValuesByTarget.set(target, new Set());
      const bag = fkValuesByTarget.get(target)!;
      for (const row of sheet.rows) {
        const v = String((row as Record<string, string>)[p.name] ?? "").trim();
        if (v) bag.add(v);
      }
    }
    for (const [target, values] of fkValuesByTarget) {
      if (values.size === 0) {
        fkExistingByTarget.set(target, new Set());
        continue;
      }
      const targetRuleset = await loadRuleset(target);
      if (!targetRuleset?.table) {
        fkExistingByTarget.set(target, new Set([...values])); // can't verify → pass through
        continue;
      }
      const params: Record<string, string> = {};
      const placeholders: string[] = [];
      [...values].forEach((v, i) => {
        params[`v${i}`] = v;
        placeholders.push(`@v${i}`);
      });
      const found = await cmfQuery<{ Name: string }>(
        `select Name from [${targetRuleset.table.schema}].[${targetRuleset.table.name}] where [Name] in (${placeholders.join(", ")})`,
        params,
      );
      fkExistingByTarget.set(target, new Set(found.map((r) => String(r.Name))));
    }

    // 3. Per-row verdict.
    const byVerdict: Record<RowVerdict, number> = { CREATE: 0, UPDATE: 0, SKIP: 0, CONFLICT: 0 };
    const rowImpacts: RowImpact[] = sheet.rows.map((row, i) => {
      const name = String((row as Record<string, string>).Name ?? "").trim() || `row-${i + 1}`;

      // FK conflicts first — they're load-blockers
      const conflicts: string[] = [];
      for (const p of fkProps) {
        const v = String((row as Record<string, string>)[p.name] ?? "").trim();
        if (!v) continue;
        const ok = fkExistingByTarget.get(p.referenceTargetType!);
        if (!ok || !ok.has(v)) {
          conflicts.push(`${p.name}=${v} (no ${p.referenceTargetType})`);
        }
      }
      if (conflicts.length > 0) {
        byVerdict.CONFLICT++;
        return { rowIndex: i + 1, name, verdict: "CONFLICT", conflicts };
      }

      const dbRow = existing.get(name);
      if (!dbRow) {
        byVerdict.CREATE++;
        return { rowIndex: i + 1, name, verdict: "CREATE" };
      }

      // Diff only the columns the user supplied.
      const changed: string[] = [];
      for (const [k, v] of Object.entries(row as Record<string, string>)) {
        const userVal = String(v ?? "").trim();
        if (!userVal) continue; // empty cells aren't proposed changes
        const dbVal = String(dbRow[k] ?? "").trim();
        if (userVal !== dbVal) changed.push(k);
      }
      if (changed.length === 0) {
        byVerdict.SKIP++;
        return { rowIndex: i + 1, name, verdict: "SKIP" };
      }
      byVerdict.UPDATE++;
      return { rowIndex: i + 1, name, verdict: "UPDATE", changedColumns: changed };
    });

    blockingConflicts += byVerdict.CONFLICT;
    out.push({
      objectType: ruleset.objectType,
      totalRows: sheet.rows.length,
      byVerdict,
      rows: rowImpacts,
    });
  }

  return { sheets: out, blockingConflicts, metadataMissing };
}
