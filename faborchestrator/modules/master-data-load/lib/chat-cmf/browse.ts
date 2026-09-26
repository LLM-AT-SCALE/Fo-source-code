import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { isObjectRemoved, getRemovedColumns } from "@/modules/master-data-load/lib/validation/removal-policy";
import { physicalColumns, resolveRefJoins, type RefJoin } from "@/modules/master-data-load/lib/chat-cmf/cmf-schema-util";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";

const SCHEMA = templateSchema as unknown as Record<string, { raw: string; columns: string[] }>;

/** Noisy columns that add no value to a browse list. */
const NOISE_RE = /url$|image|picture|icon|documentation|thumbnail/i;

/**
 * CMF database discovery lookup — the "help me find it" counterpart to
 * `lookupExisting` (which needs exact Names).
 *
 * A user often doesn't remember an exact record name ("what flows exist?",
 * "products and their flow", "which products use flow F1"). This browses ANY
 * object type's live CMF table read-only and returns a capped, ordered list of
 * records with useful fields — Name, Description, and RELATED OBJECT NAMES
 * (e.g. a product's Flow / ProductGroup), plus the total count.
 *
 * The CMF physical model stores references as numeric id columns (`FlowId`,
 * `ProductGroupId`, …), so a related object's NAME only exists after a join.
 * We resolve those joins, but only for references we can TRUST — CMF's property
 * metadata mis-maps many reference targets (e.g. `CapacityClass -> NonWorkingTime`),
 * so we keep a join only when the property name and its target type match
 * (Flow→Flow, ProductGroup→ProductGroup, …). That filters the garbage out.
 *
 * Safety:
 *   - Read-only. Every VALUE (search term, filter value) is a bound parameter.
 *   - Every COLUMN / table identifier is validated against INFORMATION_SCHEMA —
 *     never taken raw from the model — so nothing can inject SQL.
 *   - Client-removed objects and columns are excluded; `limit` is a clamped int.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_COLUMNS = 8;

/** Physical columns CMF manages; never useful to display. */
const SYSTEM_RE =
  /^(Id|Version|UniversalState|RevisionState|IsDefaultRevision|CreatedBy|CreatedOn|ModifiedBy|ModifiedOn|Last[A-Z]|MainState|Locked(By|On)?|IsLocked|Definition(Id)?|ChangeSet(Id)?|EntityPictureId|CorrelationID)/;

export type BrowseResult = {
  objectType: string;
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  returned: number;
  truncated: boolean;
  metadataMissing?: boolean;
  removed?: boolean;
  error?: string;
};

export type BrowseInput = {
  objectType: string;
  search?: string;
  filterColumn?: string;
  filterValue?: string;
  columns?: string[];
  limit?: number;
};

export async function browseCmfRecords(input: BrowseInput): Promise<BrowseResult> {
  const { objectType } = input;
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const empty = { objectType, columns: [], rows: [], total: 0, returned: 0, truncated: false };

  if (isObjectRemoved(objectType)) return { ...empty, removed: true };

  const ruleset = await loadRuleset(objectType);
  if (!ruleset?.table) return { ...empty, metadataMissing: true };

  const { schema, name: table } = ruleset.table;
  const real = await physicalColumns(schema, table);
  const realLower = new Map(real.map((c) => [c.toLowerCase(), c]));
  const removedCols = getRemovedColumns(objectType);
  const direct = (c: string): string | undefined => {
    const r = realLower.get(c.toLowerCase());
    return r && !removedCols.has(r.toLowerCase()) ? r : undefined;
  };

  const refJoins = await resolveRefJoins(ruleset, realLower, removedCols);
  const refByProp = new Map(refJoins.map((j) => [j.prop.toLowerCase(), j]));

  // ── choose display columns ────────────────────────────────────────────────
  // Each is either a direct base column or a joined reference name.
  type Col = { label: string; expr: string };
  const base = "t";
  const directCol = (c: string): Col => ({ label: c, expr: `${base}.[${c}]` });
  const refCol = (j: RefJoin, alias: string): Col => ({ label: j.prop, expr: `${alias}.[Name]` });

  const chosen: Col[] = [];
  const joins: string[] = [];
  const usedLabels = new Set<string>();
  const addRefJoin = (j: RefJoin): Col => {
    const alias = `r${joins.length}`;
    joins.push(
      `left join [${j.targetSchema}].[${j.targetTable}] ${alias} on ${base}.[${j.fkCol}] = ${alias}.[${j.targetPk}]`,
    );
    return refCol(j, alias);
  };

  if (input.columns?.length) {
    for (const req of input.columns) {
      if (usedLabels.has(req.toLowerCase())) continue;
      const j = refByProp.get(req.toLowerCase());
      const d = direct(req);
      if (j) chosen.push(addRefJoin(j));
      else if (d) chosen.push(directCol(d));
      usedLabels.add(req.toLowerCase());
    }
  } else {
    const push = (c: Col | undefined) => {
      if (c && !usedLabels.has(c.label.toLowerCase())) {
        chosen.push(c);
        usedLabels.add(c.label.toLowerCase());
      }
    };
    push(direct("Name") ? directCol(direct("Name")!) : undefined);
    push(direct("Description") ? directCol(direct("Description")!) : undefined);
    for (const j of refJoins) if (chosen.length < MAX_COLUMNS) push(addRefJoin(j));
    // Fill remaining with meaningful scalar business columns — prefer the
    // client-curated template columns, then others; skip id/system/noise.
    const curated = new Set((SCHEMA[ruleset.objectType]?.columns ?? []).map((c) => c.toLowerCase()));
    const scalarOrder = [
      ...real.filter((c) => curated.has(c.toLowerCase())),
      ...real.filter((c) => !curated.has(c.toLowerCase())),
    ];
    for (const c of scalarOrder) {
      if (chosen.length >= MAX_COLUMNS) break;
      if (SYSTEM_RE.test(c) || /Id$/.test(c) || NOISE_RE.test(c) || removedCols.has(c.toLowerCase())) continue;
      push(directCol(c));
    }
  }
  if (chosen.length === 0 && direct("Name")) chosen.push(directCol(direct("Name")!));
  const display = chosen.slice(0, MAX_COLUMNS);

  // ── WHERE ─────────────────────────────────────────────────────────────────
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (input.search?.trim()) {
    const cols = ["Name", "Description"].map(direct).filter((c): c is string => !!c);
    if (cols.length) {
      params.q = `%${input.search.trim()}%`;
      where.push("(" + cols.map((c) => `${base}.[${c}] like @q`).join(" or ") + ")");
    }
  }
  if (input.filterColumn && input.filterValue != null) {
    params.fv = input.filterValue;
    const j = refByProp.get(input.filterColumn.toLowerCase());
    const d = direct(input.filterColumn);
    if (j) {
      // reverse lookup by related NAME (e.g. products where Flow = 'F1')
      const alias = `f${joins.length}`;
      joins.push(
        `left join [${j.targetSchema}].[${j.targetTable}] ${alias} on ${base}.[${j.fkCol}] = ${alias}.[${j.targetPk}]`,
      );
      where.push(`${alias}.[Name] = @fv`);
    } else if (d) {
      where.push(`${base}.[${d}] = @fv`);
    } else {
      return { ...empty, error: `"${objectType}" has no field called "${input.filterColumn}".` };
    }
  }
  // Effective-revision filter. CMF versions entities (Flow, Step, …) as MANY
  // rows per name; `IsDefaultRevision = 1` is the single EFFECTIVE / current
  // revision. Without it, browsing "effective flows with bulk" returned all 98
  // version-rows (capped, then de-duplicated by eye) → 10 flows instead of the
  // 20 effective ones. Filtering here yields exactly one row per effective
  // object and a truthful count. Non-versioned tables lack the column → no-op.
  const effCol = realLower.get("isdefaultrevision");
  if (effCol) where.push(`${base}.[${effCol}] = 1`);

  const joinSql = joins.length ? " " + joins.join(" ") : "";
  const whereSql = where.length ? ` where ${where.join(" and ")}` : "";

  // ── query ─────────────────────────────────────────────────────────────────
  const countRows = await cmfQuery<{ n: number }>(
    `select count(*) as n from [${schema}].[${table}] ${base}${joinSql}${whereSql}`,
    params,
  );
  const total = Number(countRows[0]?.n ?? 0);

  const orderCol = direct("Name");
  const select = display.map((c) => `${c.expr} as [${c.label}]`).join(", ");
  const dataRows = await cmfQuery<Record<string, unknown>>(
    `select top ${limit} ${select} from [${schema}].[${table}] ${base}${joinSql}${whereSql}${orderCol ? ` order by ${base}.[${orderCol}]` : ""}`,
    params,
  );
  const rows = dataRows.map((r) => {
    const o: Record<string, string> = {};
    for (const c of display) o[c.label] = r[c.label] == null ? "" : String(r[c.label]);
    return o;
  });

  return {
    objectType: ruleset.objectType,
    columns: display.map((c) => c.label),
    rows,
    total,
    returned: rows.length,
    truncated: total > rows.length,
  };
}

export type FieldValueOptions = {
  objectType: string;
  field: string;
  /** Distinct values the field actually holds in CMF, most-common first. */
  values: { value: string; count: number }[];
  /** Total number of distinct values (values[] may be capped below this). */
  distinctTotal: number;
  /** True when the field is a real FK — values are the referenced object's Names. */
  isReference?: boolean;
  metadataMissing?: boolean;
  removed?: boolean;
  error?: string;
};

/**
 * "Don't guess — suggest real values." For a field whose valid value the model
 * doesn't know (e.g. a mandatory scalar like Step.Type with no declared default),
 * return the values that field ACTUALLY holds across existing CMF records,
 * most-common first, so the model can offer real options instead of inventing.
 *
 * Handles a direct scalar column (group by the value) and a genuine FK column
 * (resolve the id to the referenced object's Name, then group). Read-only; the
 * column/table identifiers are validated against INFORMATION_SCHEMA.
 */
export async function getFieldValueOptions(
  objectType: string,
  field: string,
  limit = 20,
): Promise<FieldValueOptions> {
  const empty = { objectType, field, values: [], distinctTotal: 0 };
  if (isObjectRemoved(objectType)) return { ...empty, removed: true };

  const ruleset = await loadRuleset(objectType);
  if (!ruleset?.table) return { ...empty, metadataMissing: true };
  const { schema, name: table } = ruleset.table;

  const real = await physicalColumns(schema, table);
  const realLower = new Map(real.map((c) => [c.toLowerCase(), c]));
  const removedCols = getRemovedColumns(objectType);
  const cap = Math.min(Math.max(1, Math.floor(limit)), 100);

  if (removedCols.has(field.toLowerCase())) {
    return { ...empty, error: `"${field}" is not available on "${objectType}".` };
  }

  // Direct scalar column → distinct values in use.
  const directCol = realLower.get(field.toLowerCase());
  if (directCol) {
    const rows = await cmfQuery<{ value: unknown; n: number }>(
      `select top ${cap} [${directCol}] as value, count(*) as n
       from [${schema}].[${table}]
       where [${directCol}] is not null and ltrim(rtrim(cast([${directCol}] as nvarchar(400)))) <> ''
       group by [${directCol}] order by count(*) desc`,
    );
    const distinct = await cmfQuery<{ n: number }>(
      `select count(*) as n from (select distinct [${directCol}] from [${schema}].[${table}] where [${directCol}] is not null) t`,
    );
    return {
      objectType: ruleset.objectType,
      field: directCol,
      values: rows.map((r) => ({ value: String(r.value), count: Number(r.n) })),
      distinctTotal: Number(distinct[0]?.n ?? rows.length),
    };
  }

  // Genuine FK column → resolve the id to the target's Name, then group.
  const refJoins = await resolveRefJoins(ruleset, realLower, removedCols, { trustAll: true });
  const ref = refJoins.find((j) => j.prop.toLowerCase() === field.toLowerCase());
  if (ref) {
    const rows = await cmfQuery<{ value: string; n: number }>(
      `select top ${cap} r.[Name] as value, count(*) as n
       from [${schema}].[${table}] t
       join [${ref.targetSchema}].[${ref.targetTable}] r on t.[${ref.fkCol}] = r.[${ref.targetPk}]
       where r.[Name] is not null
       group by r.[Name] order by count(*) desc`,
    );
    return {
      objectType: ruleset.objectType,
      field: ref.prop,
      values: rows.map((r) => ({ value: String(r.value), count: Number(r.n) })),
      distinctTotal: rows.length,
      isReference: true,
    };
  }

  return { ...empty, error: `"${objectType}" has no field called "${field}".` };
}
