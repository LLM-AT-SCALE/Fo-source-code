import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset, type PropertyRule } from "@/modules/master-data-load/lib/validation/metadata";
import { isSystemManaged } from "@/modules/master-data-load/lib/validation/system-columns";
import { isObjectRemoved, isColumnRemoved } from "@/modules/master-data-load/lib/validation/removal-policy";

/**
 * Pre-fill engine for the inline entry form.
 *
 * Phase 1.5 of the AI Template Builder: when the user provides data upfront
 * (paste in chat, table, or uploaded .xlsx), we want the form to open
 * pre-filled with their values AND with every cell already DB-validated so
 * they see green/yellow/red instead of having to hand-check each row.
 *
 * `prefillFormFromInput` takes loose rows (col → value) and returns the same
 * rows wrapped in per-cell `CellResult` with a status + optional suggestions.
 * It validates against CMF metadata (mandatory, length, regex, FK existence)
 * via `loadRuleset` and one batched FK-existence query per target table.
 *
 * Design notes (kept minimal per CLAUDE.md):
 *   - One query per distinct FK target (not per row × per FK column).
 *   - Fuzzy match = substring or normalized character-overlap > 0.6. Not
 *     Levenshtein; substring catches "site x" vs "SITE-X" which is the
 *     typical user input.
 *   - When CMF metadata is unavailable, we pass values through with status
 *     "ok" rather than blocking. Surfacing "we couldn't check" lets the LLM
 *     decide whether to warn the user.
 *   - FK options cap: 1000 per target. Larger tables get an "fk-unknown"
 *     status (yellow, not red) so the user can still proceed.
 */

const FK_OPTION_CAP = 1000;

type CellStatus =
  /** Value passes all checks; nothing to flag. */
  | "ok"
  /** Value matches an existing parent record exactly. */
  | "fk-resolved"
  /** Close match exists (case-insensitive substring or similar). */
  | "fk-fuzzy"
  /** Value doesn't match anything in the parent table. */
  | "fk-missing"
  /** Parent table has > FK_OPTION_CAP rows; we can't be sure. */
  | "fk-unknown"
  /** Mandatory column has no value. */
  | "required-missing"
  /** Value exceeds the column's maxLength. */
  | "too-long"
  /** Value fails the column's validation regex. */
  | "regex-fail";

type CellResult = {
  value: string;
  status: CellStatus;
  /** Short human-readable note; the form shows this on hover. */
  message?: string;
  /**
   * For fk-fuzzy / fk-missing: up to 3 nearest existing parent names so the
   * user can pick the right one without re-typing.
   */
  suggestions?: string[];
};

type PrefilledRow = {
  /** Keyed by canonical column name (matches schema casing). */
  cells: Record<string, CellResult>;
};

export type PrefillResult = {
  objectType: string;
  rows: PrefilledRow[];
  /** Columns we saw in the input but the schema doesn't know about. */
  unknownColumns: string[];
  /**
   * True when at least one cell would block the load — fk-missing,
   * required-missing, too-long, or regex-fail. fk-fuzzy / fk-unknown do
   * NOT count as blockers (they're yellow warnings).
   */
  hasBlockers: boolean;
  /**
   * True when ruleset lookup failed for the parent object. In this mode the
   * rows are passed through verbatim with status "ok"; the LLM should tell
   * the user we couldn't validate.
   */
  metadataMissing: boolean;
  /**
   * True when the client has removed this object type from the template
   * entirely (struck through in TemplateObjectCatalog.xlsx). Callers must
   * NOT generate a template or open a form for it.
   */
  objectRemoved?: boolean;
};

export async function prefillFormFromInput(
  objectType: string,
  rows: Record<string, string>[],
): Promise<PrefillResult> {
  if (isObjectRemoved(objectType)) {
    return {
      objectType,
      rows: [],
      unknownColumns: [],
      hasBlockers: true,
      metadataMissing: false,
      objectRemoved: true,
    };
  }

  if (rows.length === 0) {
    return { objectType, rows: [], unknownColumns: [], hasBlockers: false, metadataMissing: false };
  }

  const ruleset = await loadRuleset(objectType);
  if (!ruleset) {
    // No CMF metadata — pass through unchanged. Caller decides what to do.
    return {
      objectType,
      rows: rows.map((row) => ({
        cells: Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, { value: v, status: "ok" as const }]),
        ),
      })),
      unknownColumns: [],
      hasBlockers: false,
      metadataMissing: true,
    };
  }

  const propByLower = new Map(ruleset.properties.map((p) => [p.name.toLowerCase(), p]));

  // Batch FK lookups: one query per distinct target table.
  const fkTargets = new Set<string>();
  for (const p of ruleset.properties) if (p.referenceTargetType) fkTargets.add(p.referenceTargetType);
  const fkExistingByTarget = new Map<string, Set<string>>();
  const fkLowerByTarget = new Map<string, string[]>();
  const fkOverCapTargets = new Set<string>();

  for (const target of fkTargets) {
    const targetRuleset = await loadRuleset(target);
    if (!targetRuleset?.table) {
      // No table to query — leave it as fk-unknown later.
      fkOverCapTargets.add(target);
      continue;
    }
    const existing = await cmfQuery<{ Name: string }>(
      `select top ${FK_OPTION_CAP + 1} Name from [${targetRuleset.table.schema}].[${targetRuleset.table.name}] order by Name`,
    );
    if (existing.length > FK_OPTION_CAP) {
      // Too many — we won't claim a value is missing if we can't see all options.
      fkOverCapTargets.add(target);
    }
    const names = existing.slice(0, FK_OPTION_CAP).map((r) => String(r.Name));
    fkExistingByTarget.set(target, new Set(names));
    fkLowerByTarget.set(target, names.map((n) => n.toLowerCase()));
  }

  const unknownColumns = new Set<string>();
  let hasBlockers = false;

  const outRows: PrefilledRow[] = rows.map((row) => {
    const cells: Record<string, CellResult> = {};

    // Process every column the user provided.
    for (const [userKey, userValueRaw] of Object.entries(row)) {
      const userValue = userValueRaw ?? "";
      const prop = propByLower.get(userKey.toLowerCase());
      if (!prop) {
        unknownColumns.add(userKey);
        cells[userKey] = {
          value: userValue,
          status: "ok",
          message: `Column "${userKey}" isn't in the ${ruleset.objectType} template — it will be ignored.`,
        };
        continue;
      }
      const result = validateCell(userValue, prop, fkExistingByTarget, fkLowerByTarget, fkOverCapTargets);
      cells[prop.name] = result;
      if (isBlocker(result.status)) hasBlockers = true;
    }

    // Surface any mandatory column the user didn't provide at all. Skip CMF
    // system-managed columns (CreatedBy, Id, Version, etc.) — they're flagged
    // mandatory in metadata but the loader auto-fills them. Also skip columns
    // the client has removed from this object's template.
    for (const prop of ruleset.properties) {
      if (cells[prop.name]) continue;
      if (isColumnRemoved(ruleset.objectType, prop.name)) continue;
      if (prop.mandatory && !isSystemManaged(prop.name)) {
        cells[prop.name] = {
          value: "",
          status: "required-missing",
          message: `${prop.name} is required.`,
        };
        hasBlockers = true;
      }
    }

    return { cells };
  });

  return {
    objectType: ruleset.objectType,
    rows: outRows,
    unknownColumns: [...unknownColumns],
    hasBlockers,
    metadataMissing: false,
  };
}

function isBlocker(s: CellStatus): boolean {
  return s === "fk-missing" || s === "required-missing" || s === "too-long" || s === "regex-fail";
}

function validateCell(
  raw: string,
  prop: PropertyRule,
  fkExistingByTarget: Map<string, Set<string>>,
  fkLowerByTarget: Map<string, string[]>,
  fkOverCapTargets: Set<string>,
): CellResult {
  const trimmed = (raw ?? "").trim();

  if (!trimmed) {
    if (prop.mandatory) return { value: "", status: "required-missing", message: `${prop.name} is required.` };
    return { value: "", status: "ok" };
  }

  if (prop.scalarSize && trimmed.length > prop.scalarSize) {
    return {
      value: trimmed,
      status: "too-long",
      message: `Exceeds max length ${prop.scalarSize}.`,
    };
  }

  if (prop.validationRegex) {
    try {
      const re = new RegExp(prop.validationRegex);
      if (!re.test(trimmed)) {
        return { value: trimmed, status: "regex-fail", message: "Doesn't match required format." };
      }
    } catch {
      // Invalid regex in CMF metadata — skip silently.
    }
  }

  if (prop.referenceTargetType) {
    return resolveFk(trimmed, prop.referenceTargetType, fkExistingByTarget, fkLowerByTarget, fkOverCapTargets);
  }

  return { value: trimmed, status: "ok" };
}

function resolveFk(
  value: string,
  target: string,
  fkExistingByTarget: Map<string, Set<string>>,
  fkLowerByTarget: Map<string, string[]>,
  fkOverCapTargets: Set<string>,
): CellResult {
  const existing = fkExistingByTarget.get(target);
  if (!existing) {
    return { value, status: "fk-unknown", message: `Could not look up ${target} parents.` };
  }
  if (existing.has(value)) {
    return { value, status: "fk-resolved" };
  }
  // Case-insensitive exact match — common case ("SiteX" vs "SITEX").
  const lower = value.toLowerCase();
  const lowerList = fkLowerByTarget.get(target) ?? [];
  const ciExactIdx = lowerList.indexOf(lower);
  if (ciExactIdx >= 0) {
    const canonical = [...existing][ciExactIdx];
    return {
      value,
      status: "fk-fuzzy",
      message: `Casing differs from CMF "${canonical}".`,
      suggestions: [canonical],
    };
  }
  // Substring match — "site x" inside "ACID-SITE-X".
  const fuzzy: { name: string; score: number }[] = [];
  for (let i = 0; i < lowerList.length; i++) {
    const n = lowerList[i];
    let score = 0;
    if (n.includes(lower) || lower.includes(n)) score = 0.85;
    else score = charOverlap(lower, n);
    if (score >= 0.6) {
      fuzzy.push({ name: [...existing][i], score });
    }
  }
  fuzzy.sort((a, b) => b.score - a.score);
  const suggestions = fuzzy.slice(0, 3).map((f) => f.name);

  if (fkOverCapTargets.has(target)) {
    // Too many options to be sure — yellow instead of red.
    return {
      value,
      status: "fk-unknown",
      message: `${target} has more than ${FK_OPTION_CAP} rows; could not fully check.`,
      suggestions,
    };
  }
  if (suggestions.length > 0) {
    return {
      value,
      status: "fk-fuzzy",
      message: `Closest match in ${target}: "${suggestions[0]}".`,
      suggestions,
    };
  }
  return {
    value,
    status: "fk-missing",
    message: `Not found in ${target}.`,
  };
}

/** Cheap similarity: shared distinct-character count over union size. */
function charOverlap(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  for (const c of setA) if (setB.has(c)) common++;
  const denom = Math.max(setA.size, setB.size);
  return denom === 0 ? 0 : common / denom;
}
