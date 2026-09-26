import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { isObjectRemoved, getRemovedColumns } from "@/modules/master-data-load/lib/validation/removal-policy";
import { physicalColumns, resolveRefJoins } from "@/modules/master-data-load/lib/chat-cmf/cmf-schema-util";
import { generateFromSkeleton } from "@/modules/master-data-load/lib/validation/ksp-skeleton";
import { generateLeanTemplate } from "@/modules/master-data-load/lib/validation/lean-template";
import { resolveEnumValue } from "@/modules/master-data-load/lib/validation/enum-resolve";
import { junctionColumnsFor, fetchJunctionListValues } from "@/modules/master-data-load/lib/chat-cmf/junction-list";
import { createStagedUpload } from "@/modules/master-data-load/lib/repo-cmf/validation";
import fieldDefaults from "@/modules/master-data-load/lib/validation/field-defaults.json";

/** Curated blank-cell defaults for `objectType` as [lowercased column, value]
 *  pairs (from field-defaults.json, keyed `ObjectType.Column`). */
function curatedDefaultsFor(objectType: string): [string, string][] {
  const prefix = `${objectType.toLowerCase()}.`;
  return Object.entries(fieldDefaults as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith("$") && k.toLowerCase().startsWith(prefix) && typeof v === "string")
    .map(([k, v]) => [k.slice(prefix.length).toLowerCase(), String(v)] as [string, string]);
}
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";

/**
 * Auto-fill a master-data template from EXISTING CMF records.
 *
 * The user often wants to start from live data — "pre-fill a Resource template
 * with all resources in the Assembly area", "clone these 10 products",
 * "set Type=X on every product in group Y". This reads the real records and maps
 * CMF's PHYSICAL columns to the loadable TEMPLATE columns:
 *   - a template column that IS a physical column → copied straight across;
 *   - a template column that is a relationship → the numeric FK (`FlowId`) is
 *     resolved to the related object's NAME via join (so the template gets the
 *     name it expects, not an id);
 *   - anything with no source → left blank for the user to complete.
 *
 * The retrieved rows are written directly into the file and never pass through
 * the model, so the data is exactly what CMF holds (nothing invented). An
 * optional `set` applies a bulk change to every retrieved row before writing.
 */

const RESERVED = new Set(["$order", "$ambiguous"]);
const SCHEMA = templateSchema as unknown as Record<string, { raw: string; columns: string[] }>;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Map a CMF-declared `DefaultValue` to the string the loadable TEMPLATE expects.
 * CMF stores a Bit default as "0"/"1"; the template uses "false"/"true", so keep
 * the existing Bit behaviour. Every other scalar (Int enums like SPCPostMode,
 * strings, …) is copied through verbatim — it is already CMF's own value.
 */
function normalizeDefault(scalarType: string | null, raw: string): string {
  if (scalarType === "Bit") return raw === "1" || /^true$/i.test(raw) ? "true" : "false";
  return raw;
}

export type FillSelector = {
  /** Specific records by Name. */
  names?: string[];
  /** Or a filter: exact-match a field (direct column or a related object's Name). */
  filterColumn?: string;
  filterValue?: string;
  /** Multi-value form of `filterColumn`: matches any of these (SQL `in (…)`).
   *  Used by the dependency export to pull a sub-sheet for every parent name at
   *  once. Ignored when `filterValue` is set. */
  filterValues?: string[];
  /** Or a keyword on Name/Description. */
  search?: string;
  limit?: number;
};

export type FetchTemplateRowsResult = {
  objectType: string;
  /** Template columns we could populate. */
  columnsFilled: string[];
  rows: Record<string, string>[];
  total: number;
  truncated: boolean;
  removed?: boolean;
  metadataMissing?: boolean;
  error?: string;
};

/**
 * Read existing records and return rows keyed by TEMPLATE column names (with
 * relationships resolved to names) — ready to hand to `generateFromSkeleton`.
 */
export async function fetchTemplateRows(
  objectType: string,
  selector: FillSelector = {},
  opts: { trustAllRefs?: boolean; effectiveOnly?: boolean; fillRequiredDefaults?: boolean } = {},
): Promise<FetchTemplateRowsResult> {
  const limit = Math.min(Math.max(1, Math.floor(selector.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const empty = { objectType, columnsFilled: [], rows: [], total: 0, truncated: false };

  if (isObjectRemoved(objectType)) return { ...empty, removed: true };
  const entry = Object.entries(SCHEMA).find(
    ([k, v]) => !RESERVED.has(k) && k.toLowerCase() === objectType.toLowerCase() && v?.columns,
  );
  const templateCols = entry?.[1].columns;
  const canonical = entry?.[0] ?? objectType;
  if (!templateCols) return { ...empty, metadataMissing: true };

  const ruleset = await loadRuleset(canonical);
  if (!ruleset?.table) return { ...empty, metadataMissing: true };
  const { schema, name: baseTable } = ruleset.table;

  // Effective-revision source. A change-controlled object (has an
  // `IsDefaultRevision` column) stores its data across several revision rows,
  // and — crucially — the `IsDefaultRevision=1` row is NOT always the one that
  // holds the data: for BOM/DataCollection/Checklist it's an empty Version-0
  // pointer (mandatory fields NULL), with the real values in a sibling version.
  // Reading that empty pointer is what made CMF reject a BOM load ("Missing
  // value for mandatory property Units"). CMF's own `V_<Object>` view resolves
  // this — it exposes the effective (coalesced) values on every version row —
  // so for change-controlled objects we read the view and take the single
  // Version=0 row per Name (verified 1-per-name, covers every record). Simple
  // objects (no IsDefaultRevision column) are untouched.
  let table = baseTable;
  let real = await physicalColumns(schema, baseTable);
  let useViewEffective = false;
  const changeControlled = real.some((c) => c.toLowerCase() === "isdefaultrevision");
  if (opts.effectiveOnly !== false && changeControlled) {
    const viewName = baseTable.replace(/^T_/i, "V_");
    const viewCols = await physicalColumns(schema, viewName);
    if (viewCols.some((c) => c.toLowerCase() === "version")) {
      table = viewName;
      real = viewCols;
      useViewEffective = true;
    }
  }
  const realLower = new Map(real.map((c) => [c.toLowerCase(), c]));
  const removedCols = getRemovedColumns(canonical);
  const refJoins = await resolveRefJoins(ruleset, realLower, removedCols, { trustAll: opts.trustAllRefs });
  const refByProp = new Map(refJoins.map((j) => [j.prop.toLowerCase(), j]));

  // Map each template column to a SELECT expression (direct column or joined name).
  const base = "t";
  const selects: { label: string; expr: string }[] = [];
  const joins: string[] = [];
  for (const col of templateCols) {
    if (removedCols.has(col.toLowerCase())) continue;
    const directName = realLower.get(col.toLowerCase());
    if (directName) {
      selects.push({ label: col, expr: `${base}.[${directName}]` });
      continue;
    }
    const ref = refByProp.get(col.toLowerCase());
    if (ref) {
      const alias = `r${joins.length}`;
      joins.push(
        `left join [${ref.targetSchema}].[${ref.targetTable}] ${alias} on ${base}.[${ref.fkCol}] = ${alias}.[${ref.targetPk}]`,
      );
      selects.push({ label: col, expr: `${alias}.[Name]` });
    }
    // else: no source → left blank in the template.
  }
  if (selects.length === 0) return { ...empty, error: `Could not map any columns for "${canonical}".` };

  // ── WHERE ─────────────────────────────────────────────────────────────────
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (selector.names?.length) {
    const ph = selector.names.slice(0, MAX_LIMIT).map((n, i) => {
      params[`n${i}`] = n;
      return `@n${i}`;
    });
    if (realLower.get("name")) where.push(`${base}.[${realLower.get("name")}] in (${ph.join(", ")})`);
  }
  if (selector.search?.trim()) {
    const cols = ["Name", "Description"]
      .map((c) => realLower.get(c.toLowerCase()))
      .filter((c): c is string => !!c);
    if (cols.length) {
      params.q = `%${selector.search.trim()}%`;
      where.push("(" + cols.map((c) => `${base}.[${c}] like @q`).join(" or ") + ")");
    }
  }
  if (selector.filterColumn && (selector.filterValue != null || selector.filterValues?.length)) {
    // Single value → `= @fv`; multi value → `in (@fv0, @fv1, …)`.
    const multi =
      selector.filterValue == null && selector.filterValues?.length
        ? selector.filterValues.slice(0, MAX_LIMIT)
        : null;
    let matchExpr: string;
    if (multi) {
      const ph = multi.map((v, i) => {
        params[`fv${i}`] = v;
        return `@fv${i}`;
      });
      matchExpr = `in (${ph.join(", ")})`;
    } else {
      params.fv = selector.filterValue!;
      matchExpr = `= @fv`;
    }
    const ref = refByProp.get(selector.filterColumn.toLowerCase());
    const direct = realLower.get(selector.filterColumn.toLowerCase());
    if (ref) {
      const alias = `f${joins.length}`;
      joins.push(
        `left join [${ref.targetSchema}].[${ref.targetTable}] ${alias} on ${base}.[${ref.fkCol}] = ${alias}.[${ref.targetPk}]`,
      );
      where.push(`${alias}.[Name] ${matchExpr}`);
    } else if (direct) {
      where.push(`${base}.[${direct}] ${matchExpr}`);
    } else {
      return { ...empty, error: `"${canonical}" has no field called "${selector.filterColumn}".` };
    }
  }
  // Effective-revision filter: pull the ONE current row per record.
  //  • When reading a `V_<Object>` effective view (change-controlled objects),
  //    `Version = 0` yields exactly one row per Name carrying the coalesced
  //    effective values (Units/Type/etc.) — the fix for the empty-pointer bug.
  //  • Otherwise, `IsDefaultRevision = 1` picks the effective revision on the
  //    raw table. Correct for top-level records; WRONG for dependency/structure
  //    tables (FlowStructures rows may not carry it), so callers that pull
  //    linked/child records pass effectiveOnly:false to skip this entirely.
  if (opts.effectiveOnly !== false) {
    if (useViewEffective) {
      where.push(`${base}.[Version] = 0`);
    } else {
      const effCol = realLower.get("isdefaultrevision");
      if (effCol) where.push(`${base}.[${effCol}] = 1`);
    }
  }

  const joinSql = joins.length ? " " + joins.join(" ") : "";
  const whereSql = where.length ? ` where ${where.join(" and ")}` : "";

  const countRows = await cmfQuery<{ n: number }>(
    `select count(*) as n from [${schema}].[${table}] ${base}${joinSql}${whereSql}`,
    params,
  );
  const total = Number(countRows[0]?.n ?? 0);

  const orderCol = realLower.get("name");
  const select = selects.map((c) => `${c.expr} as [${c.label}]`).join(", ");
  const dataRows = await cmfQuery<Record<string, unknown>>(
    `select top ${limit} ${select} from [${schema}].[${table}] ${base}${joinSql}${whereSql}${orderCol ? ` order by ${base}.[${orderCol}]` : ""}`,
    params,
  );
  // Mandatory fields that come back NULL from an existing record are filled with
  // the value CMF ITSELF would apply on load — its declared `DefaultValue`
  // (`T_*Property.DefaultValue`). This makes an export-to-reload pass the
  // required-field check without inventing data: e.g. DataCollection.SPCPostMode
  // (Int) → "0", and any mandatory Bit → "false"/"true". A mandatory field whose
  // CMF default is NULL (e.g. DataCollection.Type — no declared default) is left
  // BLANK on purpose, so the template check flags it for the user to fill.
  // Build field → fill-value for mandatory fields we can safely default:
  //   • a declared CMF DefaultValue → use it (Int enums like SPCPostMode → "0");
  //   • a mandatory Bit with NO declared default → "false" (preserves the prior
  //     hazard-flag behaviour: an unset boolean IS false, and CMF defaults it);
  //   • everything else (e.g. Type, a string with no default) → NOT in the map,
  //     so it stays blank and the template check flags it.
  const requiredDefaults =
    opts.fillRequiredDefaults
      ? new Map(
          ruleset.properties
            .filter((p) => p.mandatory && (p.defaultValue != null || p.scalarType === "Bit"))
            .map((p) => [
              p.name.toLowerCase(),
              p.defaultValue != null ? normalizeDefault(p.scalarType, p.defaultValue) : "false",
            ] as const),
        )
      : null;
  // Curated defaults for mandatory fields CMF stores NULL with no declared
  // DefaultValue (e.g. Type). Each is the object's own dominant VALID value —
  // see field-defaults.json. Merged in (not overriding a real CMF default) so a
  // blank cell gets a loadable value instead of failing the required-field check.
  if (requiredDefaults) {
    for (const [col, val] of curatedDefaultsFor(canonical)) {
      if (!requiredDefaults.has(col)) requiredDefaults.set(col, val);
    }
  }
  const rows = dataRows.map((r) => {
    const o: Record<string, string> = {};
    for (const c of selects) {
      const v = r[c.label] == null ? "" : String(r[c.label]);
      // System-enum columns (no DB authority — see enum-labels.json): blank an
      // "unset" ordinal (e.g. ProductType 0) and, when configured, translate the
      // ordinal to its label. This runs BEFORE the default-fill so a mandatory
      // enum is never back-filled with its placeholder default (e.g. "0").
      const en = resolveEnumValue(canonical, c.label, v);
      if (en !== undefined) {
        o[c.label] = en;
        continue;
      }
      const def = requiredDefaults?.get(c.label.toLowerCase());
      o[c.label] = v === "" && def != null ? def : v;
    }
    return o;
  });

  // M:N "list" columns (e.g. Step.Areas) — a related-object Name list that isn't
  // a single FK, so it's absent from `selects`. Fill each parent row's column
  // with the separator-joined related Names from the CMF relationship table.
  const nameKey = selects.find((s) => s.label.toLowerCase() === "name")?.label ?? "Name";
  const filledListCols: string[] = [];
  for (const [col, rule] of junctionColumnsFor(canonical)) {
    const templateCol = templateCols.find((t) => t.toLowerCase() === col.toLowerCase());
    if (!templateCol) continue;
    const parentNames = rows.map((r) => r[nameKey]).filter((n): n is string => !!n);
    const map = await fetchJunctionListValues(canonical, parentNames, rule);
    for (const r of rows) {
      const vals = r[nameKey] ? map.get(r[nameKey]) : undefined;
      r[templateCol] = vals?.length ? vals.join(rule.separator) : (r[templateCol] ?? "");
    }
    filledListCols.push(templateCol);
  }

  return {
    objectType: canonical,
    columnsFilled: [...selects.map((c) => c.label), ...filledListCols],
    rows,
    total,
    truncated: total > rows.length,
  };
}

export type FillFromExistingResult = {
  stagingId?: string;
  filename?: string;
  objectType: string;
  rowCount: number;
  columnsFilled: string[];
  total: number;
  truncated: boolean;
  /** Columns changed by `set`, if any. */
  applied?: string[];
  removed?: boolean;
  metadataMissing?: boolean;
  error?: string;
};

/**
 * Retrieve existing records, optionally apply a bulk `set`, and generate a
 * pre-filled template staged for download. Single-sheet objects only for now
 * (the requested object's own sheet is filled).
 */
export async function fillFromExisting(input: {
  userId: string;
  objectType: string;
  selector?: FillSelector;
  /** Optional bulk change applied to every retrieved row (column → value). */
  set?: Record<string, string>;
  packageName: string;
  scope?: "full" | "narrow";
}): Promise<FillFromExistingResult> {
  const fetched = await fetchTemplateRows(input.objectType, input.selector, { fillRequiredDefaults: true });
  if (fetched.removed) return { ...fetched, rowCount: 0 };
  if (fetched.metadataMissing || fetched.error) return { ...fetched, rowCount: 0 };
  if (fetched.rows.length === 0) {
    return { ...fetched, rowCount: 0, error: "No matching records found." };
  }

  // Apply the bulk change to every retrieved row. Match an existing template
  // column case-insensitively when possible; otherwise add the key as-is
  // (generateFromSkeleton maps column names to the template case-insensitively).
  const applied: string[] = [];
  if (input.set) {
    for (const [k, v] of Object.entries(input.set)) {
      const target = fetched.columnsFilled.find((c) => c.toLowerCase() === k.toLowerCase()) ?? k;
      for (const row of fetched.rows) row[target] = v;
      applied.push(target);
    }
  }

  // Default/narrow → the LEAN generator: a from-scratch file with a TRIMMED
  // Index (only this object's sheets, not all ~170) and data at row 2 (visible).
  // Only scope:"full" keeps the whole master-template layout (generateFromSkeleton).
  const rowsByType = { [fetched.objectType]: fetched.rows };
  const gen =
    input.scope === "full"
      ? await generateFromSkeleton({ rowsByType, scope: "full" })
      : await generateLeanTemplate(fetched.objectType, rowsByType);
  const filename = `${fetched.objectType}_${slug(input.packageName)}.xlsx`;
  const staged = await createStagedUpload({
    userId: input.userId,
    filename,
    bytes: gen.bytes,
    packageName: input.packageName,
  });

  return {
    stagingId: staged.id,
    filename,
    objectType: fetched.objectType,
    rowCount: fetched.rows.length,
    columnsFilled: fetched.columnsFilled,
    total: fetched.total,
    truncated: fetched.truncated,
    applied: applied.length ? applied : undefined,
  };
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "template";
}
