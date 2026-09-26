import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { currentDbKey } from "@/modules/master-data-load/lib/cmf/db-context";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { physicalColumns } from "@/modules/master-data-load/lib/chat-cmf/cmf-schema-util";
import { canonicalType } from "@/modules/master-data-load/lib/chat-cmf/dependency-resolver";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";

/**
 * CMF-relationship-aware reader for SUB-SHEET data.
 *
 * The master-data template's sub-sheets (DataCollectionParameters, BOMProducts,
 * FlowStructures, StorageBin, …) are NOT standalone CMF entities — `loadRuleset`
 * returns nothing for them, so the entity-metadata reader (`fetchTemplateRows`)
 * comes back empty. But their DATA lives in RELATIONSHIP tables that follow a
 * fixed CMF convention (verified live against T_DataCollectionParameter,
 * T_BOMProduct):
 *
 *   - physical table  = `T_<SubSheet>` (or the singular `T_<SubSheet w/o trailing s>`)
 *   - `SourceEntityId` → the PARENT row  (join `T_<Parent>.<Parent>Id`)
 *   - `TargetEntityId` → the referenced object (join `T_<Target>.<Target>Id`, → Name)
 *   - remaining columns (Order, IsOptional, Quantity, …) map 1:1 to the template
 *     sub-sheet's own columns.
 *
 * The TARGET type is auto-detected: it's the sub-sheet's template column whose
 * name resolves to another loadable object type (e.g. the `Parameter` column of
 * DataCollectionParameters, the `Product` column of BOMProducts). The PARENT
 * column is the one matching the parent object type. Everything else is a direct
 * association column. No per-sub-sheet config needed.
 */

const RESERVED = new Set(["$order", "$ambiguous"]);
const SCHEMA = templateSchema as unknown as Record<string, { raw: string; columns: string[] }>;

// Canonical object-type names, longest first — for resolving a column name to
// the object type it references, either exactly ("Parameter") or by suffix
// ("SourceProduct" → Product, "AssemblyStep" → Step, "QuantityCalculationRule"
// → Rule). CMF sub-sheet columns name references inconsistently, so suffix
// matching is needed; longest-first avoids "Rule" matching before a longer type.
const CANON_TYPES = Object.keys(SCHEMA)
  .filter((k) => !RESERVED.has(k))
  .sort((a, b) => b.length - a.length);

/** The object type a sub-sheet column references, by exact then suffix match. */
function columnRefType(col: string): string | null {
  const exact = canonicalType(col);
  if (exact) return exact;
  const lc = col.toLowerCase();
  for (const t of CANON_TYPES) {
    if (t.length >= 4 && lc.endsWith(t.toLowerCase()) && lc !== t.toLowerCase()) return t;
  }
  return null;
}

/**
 * The object type a SUB-SHEET column references, relationship-map-aware. A
 * relationship sub-sheet names its endpoints generically (FlowStructures.`Target`
 * → Step, `SourceEntity`/`TargetEntity`) which `columnRefType` alone can't
 * resolve; consult the RELATIONSHIP_MAP first so the export walk can discover the
 * referenced object (e.g. a Flow's Steps) from those columns. Falls back to
 * `columnRefType` for ordinary named-FK columns.
 */
export function subSheetColumnRefType(subSheetType: string, col: string): string | null {
  const m = RELATIONSHIP_MAP[subSheetType.toLowerCase()];
  if (m) {
    const cl = col.toLowerCase();
    if (cl === "sourceentity" || cl === m.source.toLowerCase()) return m.source;
    if (cl === "targetentity" || cl === "target" || cl === m.target.toLowerCase()) return m.target;
  }
  return columnRefType(col);
}

export type JunctionResult = {
  rows: Record<string, string>[];
  total: number;
  truncated: boolean;
  /** Diagnostic when we couldn't read via the relationship pattern. */
  note?: string;
};

// Cache table lookups + parent/target PK resolution across a walk. Keyed with
// the active dbKey so the two CMF databases (source/target) never alias — the
// same sub-sheet/entity can resolve to different physical tables per DB.
const tableCache = new Map<string, { schema: string; table: string } | null>();
const pkCache = new Map<string, { schema: string; table: string; pk: string } | null>();
const dbk = (name: string): string => `${currentDbKey()}::${name}`;

// Template sheet names abbreviate some words the physical tables spell out.
const NAME_EXPANSIONS: [RegExp, string][] = [
  [/DataCol(?!lection)/g, "DataCollection"], // ChecklistItemDataColParameters → …DataCollectionParameter
];
function expandName(n: string): string {
  let out = n;
  for (const [re, to] of NAME_EXPANSIONS) out = out.replace(re, to);
  return out;
}

/** Find the physical relationship table for a sub-sheet name (tries the name,
 *  its singular form, and abbreviation-expanded forms; returns owning schema). */
export async function findRelTable(subSheet: string): Promise<{ schema: string; table: string } | null> {
  if (tableCache.has(dbk(subSheet))) return tableCache.get(dbk(subSheet)) ?? null;
  const forms = [subSheet, expandName(subSheet)];
  const candidates = forms
    .flatMap((f) => [f, f.replace(/s$/i, "")])
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((n) => `T_${n}`);
  const params: Record<string, string> = {};
  const ph = candidates.map((c, i) => {
    params[`t${i}`] = c;
    return `@t${i}`;
  });
  const rows = await cmfQuery<{ sch: string; tbl: string }>(
    `select s.name as sch, t.name as tbl from sys.tables t join sys.schemas s on s.schema_id=t.schema_id where t.name in (${ph.join(",")})`,
    params,
  );
  // Prefer exact, then expanded, then singular forms.
  const wanted = candidates.map((c) => c.toLowerCase());
  const pick =
    wanted.map((w) => rows.find((r) => r.tbl.toLowerCase() === w)).find(Boolean) ??
    rows[0];
  const out = pick ? { schema: pick.sch, table: pick.tbl } : null;
  tableCache.set(dbk(subSheet), out);
  return out;
}

/** Resolve an ENTITY type to its physical table + primary-key column. */
export async function entityTablePk(objectType: string): Promise<{ schema: string; table: string; pk: string } | null> {
  const key = dbk(objectType.toLowerCase());
  if (pkCache.has(key)) return pkCache.get(key) ?? null;
  let out: { schema: string; table: string; pk: string } | null = null;
  const rs = await loadRuleset(objectType);
  if (rs?.table) {
    const cols = await physicalColumns(rs.table.schema, rs.table.name);
    const canon = rs.objectType;
    const pk =
      cols.find((c) => c.toLowerCase() === `${canon.toLowerCase()}id`) ??
      cols.find((c) => /id$/i.test(c) && c.toLowerCase() !== "datagroupid");
    if (pk) out = { schema: rs.table.schema, table: rs.table.name, pk };
  }
  pkCache.set(key, out);
  return out;
}

/** A relationship table's own PK column, by convention `<TableNameSansT_>Id`. */
async function relTablePk(rel: { schema: string; table: string }): Promise<string | null> {
  const cols = await physicalColumns(rel.schema, rel.table);
  const base = rel.table.replace(/^T_/i, "");
  return cols.find((c) => c.toLowerCase() === `${base.toLowerCase()}id`) ?? null;
}

/** Which column of `cols` links a (sub-)table to a parent whose PK is `topPk`
 *  and type `parentType` — one of the CMF conventions. Also tries a column
 *  literally named the parent type (named-FK context tables carry e.g. `Step`). */
function parentLinkColumn(cols: Map<string, string>, topPk: string, parentType: string): string | null {
  for (const cand of ["sourceentityid", topPk.toLowerCase(), `${parentType.toLowerCase()}versionid`, parentType.toLowerCase()]) {
    const hit = cols.get(cand);
    if (hit) return hit;
  }
  return null;
}

/**
 * Relationship sub-sheets whose physical shape the reader can't infer from the
 * name: both endpoints are generic `SourceEntityId`/`TargetEntityId` (not a
 * `<Parent>Id` column, not named-FK columns), and the template column that names
 * the target (e.g. FlowStructures.`Target`) doesn't resolve to a type. Each entry
 * gives the physical relationship table (when it differs from the sub-sheet name)
 * and the source/target ENTITY types the two ids point to. Verified live:
 * FlowStructures→T_FlowStep (Source=Flow, Target=Step); ResourceService
 * (Source=Resource, Target=Service); StepReason (Source=Step, Target=Reason).
 */
const RELATIONSHIP_MAP: Record<
  string,
  { table?: string; source: string; target: string; lineFlag?: string; lineTarget?: string }
> = {
  // FlowStructures rows are usually Flow→Step, but a row flagged IsLine=true is a
  // SUBFLOW node: its Target is a child Flow, not a step. T_Step/T_Flow use
  // separate id sequences that overlap, so the plain Step join would resolve a
  // subflow node to a colliding step — resolve via Flow when IsLine=true.
  flowstructures: { table: "FlowStep", source: "Flow", target: "Step", lineFlag: "IsLine", lineTarget: "Flow" },
  resourceservice: { source: "Resource", target: "Service" },
  stepreason: { source: "Step", target: "Reason" },
};

/**
 * Shape A — a Source/Target relationship table (RELATIONSHIP_MAP). Joins BOTH
 * endpoints to their entity Names, fills the literal `SourceEntity`/`TargetEntity`
 * columns AND the type-named columns (`Flow`, `Target`→Step, `Step`, `Reason`),
 * and filters on whichever endpoint IS the parent (so ResourceService reads
 * correctly whether the parent is Resource=source or Service=target). Returns
 * null when the table/types can't be resolved so the caller falls back to legacy.
 */
async function fetchRelationshipRows(
  subSheetType: string,
  templateCols: string[],
  map: { table?: string; source: string; target: string; lineFlag?: string; lineTarget?: string },
  parentType: string,
  parentNames: string[],
  limit: number,
): Promise<JunctionResult | null> {
  const rel = await findRelTable(map.table ?? subSheetType);
  if (!rel) return null;
  const relLower = new Map((await physicalColumns(rel.schema, rel.table)).map((c) => [c.toLowerCase(), c]));
  const srcId = relLower.get("sourceentityid");
  const tgtId = relLower.get("targetentityid");
  if (!srcId || !tgtId) return null;
  const src = await entityTablePk(map.source);
  const tgt = await entityTablePk(map.target);
  if (!src || !tgt) return null;

  // Filter on whichever endpoint is the parent being exported.
  const parentAlias =
    map.target.toLowerCase() === parentType.toLowerCase() && map.source.toLowerCase() !== parentType.toLowerCase()
      ? "tgt"
      : "src";

  const base = "j";
  const joins = [
    `left join [${src.schema}].[${src.table}] src on ${base}.[${srcId}] = src.[${src.pk}]`,
    `left join [${tgt.schema}].[${tgt.table}] tgt on ${base}.[${tgtId}] = tgt.[${tgt.pk}]`,
  ];
  // IsLine-aware Target: for a relationship with a line flag (FlowStructures),
  // a flagged row's Target points at the `lineTarget` entity (a sub-Flow) rather
  // than the ordinary target (Step). Join that table too and resolve via CASE.
  const lineFlagCol = map.lineFlag ? relLower.get(map.lineFlag.toLowerCase()) : undefined;
  const lineTgt = lineFlagCol && map.lineTarget ? await entityTablePk(map.lineTarget) : null;
  if (lineFlagCol && lineTgt) {
    joins.push(`left join [${lineTgt.schema}].[${lineTgt.table}] tgtline on ${base}.[${tgtId}] = tgtline.[${lineTgt.pk}]`);
  }
  const targetExpr =
    lineFlagCol && lineTgt
      ? `case when ${base}.[${lineFlagCol}] = 1 then tgtline.[Name] else tgt.[Name] end`
      : `tgt.[Name]`;
  const srcL = map.source.toLowerCase();
  const tgtL = map.target.toLowerCase();
  const selects: { label: string; expr: string }[] = [];
  for (const col of templateCols) {
    const cl = col.toLowerCase();
    if (cl === "sourceentity" || cl === srcL || columnRefType(col)?.toLowerCase() === srcL) {
      selects.push({ label: col, expr: `src.[Name]` });
    } else if (cl === "targetentity" || cl === "target" || cl === tgtL || columnRefType(col)?.toLowerCase() === tgtL) {
      selects.push({ label: col, expr: targetExpr });
    } else {
      const idCol = relLower.get(`${cl}id`);
      if (idCol) {
        const refType = columnRefType(col);
        const ref = refType ? await entityTablePk(refType) : null;
        if (ref) {
          const a = `r${selects.length}`;
          joins.push(`left join [${ref.schema}].[${ref.table}] ${a} on ${base}.[${idCol}] = ${a}.[${ref.pk}]`);
          selects.push({ label: col, expr: `${a}.[Name]` });
        }
        continue; // unresolvable FK id → blank
      }
      const direct = relLower.get(cl);
      if (direct) selects.push({ label: col, expr: `${base}.[${direct}]` });
    }
  }
  if (!selects.length) return { rows: [], total: 0, truncated: false, note: `${subSheetType}: no columns mapped.` };

  const params: Record<string, string> = {};
  const ph = parentNames.slice(0, 5000).map((n, i) => {
    params[`n${i}`] = n;
    return `@n${i}`;
  });
  const orderCol = relLower.get("position") ? `${base}.[${relLower.get("position")}]` : `${parentAlias}.[Name]`;
  const select = selects.map((s) => `${s.expr} as [${s.label}]`).join(", ");
  const sql = `select top ${limit} ${select} from [${rel.schema}].[${rel.table}] ${base} ${joins.join(" ")} where ${parentAlias}.[Name] in (${ph.join(",")}) order by ${orderCol}`;
  const dataRows = await cmfQuery<Record<string, unknown>>(sql, params);
  const rows = dataRows.map((r) => {
    const o: Record<string, string> = {};
    for (const s of selects) o[s.label] = r[s.label] == null ? "" : String(r[s.label]);
    return o;
  });
  return { rows, total: rows.length, truncated: rows.length >= limit };
}

/**
 * Shape B — a named-column CONTEXT table (smart/generic table, `T_ST_…`/`T_GT_…`).
 * Its reference columns store the related object's NAME directly (verified:
 * T_ST_ServiceContext.Step = "De IPA flush", .Service = "De-IPA flushing"), so we
 * just filter on the column named after the parent type and copy every template
 * column that exists physically. Returns null when there is no parent-named column.
 */
async function fetchNamedContextRows(
  subSheetType: string,
  templateCols: string[],
  table: { schema: string; name: string },
  parentType: string,
  parentNames: string[],
  limit: number,
): Promise<JunctionResult | null> {
  const relLower = new Map((await physicalColumns(table.schema, table.name)).map((c) => [c.toLowerCase(), c]));
  const parentColTpl = templateCols.find((c) => c.toLowerCase() === parentType.toLowerCase() || columnRefType(c)?.toLowerCase() === parentType.toLowerCase());
  const parentCol = relLower.get(parentType.toLowerCase()) ?? (parentColTpl ? relLower.get(parentColTpl.toLowerCase()) : undefined);
  if (!parentCol) return null;
  const selects: { label: string; expr: string }[] = [];
  for (const col of templateCols) {
    const direct = relLower.get(col.toLowerCase());
    if (direct) selects.push({ label: col, expr: `[${direct}]` });
  }
  if (!selects.length) return null;
  const params: Record<string, string> = {};
  const ph = parentNames.slice(0, 5000).map((n, i) => {
    params[`n${i}`] = n;
    return `@n${i}`;
  });
  const select = selects.map((s) => `${s.expr} as [${s.label}]`).join(", ");
  const sql = `select top ${limit} ${select} from [${table.schema}].[${table.name}] where [${parentCol}] in (${ph.join(",")})`;
  const dataRows = await cmfQuery<Record<string, unknown>>(sql, params);
  const rows = dataRows.map((r) => {
    const o: Record<string, string> = {};
    for (const s of selects) o[s.label] = r[s.label] == null ? "" : String(r[s.label]);
    return o;
  });
  return { rows, total: rows.length, truncated: rows.length >= limit };
}

/**
 * Read the rows of `subSheetType` that belong to the given `parentNames`,
 * mapped to the sub-sheet's template columns (parent + target resolved to names,
 * association columns copied straight). Returns a note (and empty rows) when the
 * relationship pattern doesn't apply, so callers degrade gracefully.
 *
 * `intermediates` are sibling sub-sheets that may sit BETWEEN this sub-sheet and
 * the top parent (nested composition, e.g. ChecklistItemParameters → ChecklistItem
 * → Checklist). When the sub-sheet doesn't link to the top parent directly, the
 * reader chains through an intermediate whose PK column it carries.
 */
export async function fetchJunctionRows(input: {
  parentType: string;
  subSheetType: string;
  parentNames: string[];
  intermediates?: string[];
  limit?: number;
}): Promise<JunctionResult> {
  const { parentType, subSheetType } = input;
  const empty: JunctionResult = { rows: [], total: 0, truncated: false };
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 1000)), 5000);
  if (!input.parentNames.length) return { ...empty, note: `${subSheetType}: no parent rows to link from.` };

  const tplEntry = Object.entries(SCHEMA).find(
    ([k]) => !RESERVED.has(k) && k.toLowerCase() === subSheetType.toLowerCase(),
  );
  const templateCols = tplEntry?.[1].columns;
  if (!templateCols?.length) return { ...empty, note: `${subSheetType}: not in template schema.` };

  // Shape A — curated Source/Target relationship tables (FlowStructures→FlowStep,
  // ResourceService, StepReason): resolve both endpoints + fill SourceEntity/TargetEntity.
  const mapEntry = RELATIONSHIP_MAP[subSheetType.toLowerCase()];
  if (mapEntry) {
    const r = await fetchRelationshipRows(subSheetType, templateCols, mapEntry, parentType, input.parentNames, limit);
    if (r) return r;
  }
  // Shape B — named-column context (smart/generic table T_ST_…/T_GT_…): columns
  // store related-object NAMES; filter on the parent-named column and copy them.
  const entityRs = await loadRuleset(subSheetType);
  if (entityRs?.table && /^T_(ST|GT)_/i.test(entityRs.table.name)) {
    const ctx = await fetchNamedContextRows(subSheetType, templateCols, entityRs.table, parentType, input.parentNames, limit);
    if (ctx) return ctx;
  }

  // Shape C (legacy) — `T_<name>` with SourceEntityId / `<Parent>Id` link.
  const relTable = await findRelTable(subSheetType);
  if (!relTable) return { ...empty, note: `${subSheetType}: no relationship table (T_${subSheetType}) in CMF.` };
  const relCols = await physicalColumns(relTable.schema, relTable.table);
  const relLower = new Map(relCols.map((c) => [c.toLowerCase(), c]));

  const parent = await entityTablePk(parentType);
  if (!parent) return { ...empty, note: `${subSheetType}: parent ${parentType} has no resolvable table.` };

  const base = "j";
  const selects: { label: string; expr: string }[] = [];
  const joins: string[] = [];
  // Alias of the row carrying the INTERMEDIATE name (nested case), if any — its
  // ItemName-style column resolves to this instead of the top parent.
  let imAlias: string | null = null;

  // Build the join chain from this sub-sheet (alias `j`) UP to the top parent
  // (alias `p`), whose Name we filter on. Direct link first; else one hop
  // through an intermediate sibling sub-sheet.
  const directLink = parentLinkColumn(relLower, parent.pk, parentType);
  if (directLink) {
    joins.push(`join [${parent.schema}].[${parent.table}] p on ${base}.[${directLink}] = p.[${parent.pk}]`);
  } else {
    let linked = false;
    for (const im of input.intermediates ?? []) {
      const imTable = await findRelTable(im);
      if (!imTable) continue;
      const imPk = await relTablePk(imTable);
      if (!imPk || !relLower.has(imPk.toLowerCase())) continue; // grandchild must carry the intermediate's PK
      const imCols = new Map((await physicalColumns(imTable.schema, imTable.table)).map((c) => [c.toLowerCase(), c]));
      const imToTop = parentLinkColumn(imCols, parent.pk, parentType);
      if (!imToTop) continue;
      joins.push(`join [${imTable.schema}].[${imTable.table}] im on ${base}.[${relLower.get(imPk.toLowerCase())}] = im.[${imPk}]`);
      joins.push(`join [${parent.schema}].[${parent.table}] p on im.[${imToTop}] = p.[${parent.pk}]`);
      imAlias = "im";
      linked = true;
      break;
    }
    if (!linked) {
      return { ...empty, note: `${subSheetType}: no parent-link to ${parentType} (tried SourceEntityId / ${parent.pk} / version, and intermediates).` };
    }
  }

  // Template columns that name the parents: the parent type → p.Name; an
  // ItemName-style column in a nested sheet → the intermediate's Name.
  const parentCol =
    templateCols.find((c) => c.toLowerCase() === parentType.toLowerCase()) ??
    templateCols.find((c) => canonicalType(c)?.toLowerCase() === parentType.toLowerCase());
  const itemNameCol = imAlias ? templateCols.find((c) => /itemname$/i.test(c)) : undefined;

  let joinN = 0;
  let usedTargetEntityId = false; // only ONE column resolves via TargetEntityId

  // Map each template column to a SELECT expression:
  //  - parent column         → p.Name (via SourceEntityId, the filter join)
  //  - a `<col>Id` FK column  → resolve to the referenced object's Name
  //  - a direct column        → copy straight
  //  - the primary target     → resolve via TargetEntityId (matched by type)
  //  - otherwise              → blank (omitted)
  for (const col of templateCols) {
    if (col === parentCol) {
      selects.push({ label: col, expr: `p.[Name]` });
      continue;
    }
    if (col === itemNameCol && imAlias) {
      selects.push({ label: col, expr: `${imAlias}.[Name]` });
      continue;
    }
    const idCol = relLower.get(`${col.toLowerCase()}id`);
    if (idCol) {
      const refType = columnRefType(col);
      const ref = refType ? await entityTablePk(refType) : null;
      if (ref) {
        const a = `r${joinN++}`;
        joins.push(`left join [${ref.schema}].[${ref.table}] ${a} on ${base}.[${idCol}] = ${a}.[${ref.pk}]`);
        selects.push({ label: col, expr: `${a}.[Name]` });
      }
      // FK id with no resolvable target → leave blank (raw id is not useful).
      continue;
    }
    const direct = relLower.get(col.toLowerCase());
    if (direct) {
      selects.push({ label: col, expr: `${base}.[${direct}]` });
      continue;
    }
    // Primary target via TargetEntityId (the sub-sheet's core referenced object,
    // e.g. Parameter for DataCollectionParameters, SourceProduct→Product for
    // BOMProducts). Only the first such column claims TargetEntityId.
    if (!usedTargetEntityId && relLower.has("targetentityid")) {
      const refType = columnRefType(col);
      const ref = refType ? await entityTablePk(refType) : null;
      if (ref) {
        const a = `r${joinN++}`;
        joins.push(`left join [${ref.schema}].[${ref.table}] ${a} on ${base}.[TargetEntityId] = ${a}.[${ref.pk}]`);
        selects.push({ label: col, expr: `${a}.[Name]` });
        usedTargetEntityId = true;
      }
    }
    // else: no source for this column → omit (blank in the sheet)
  }
  if (selects.length === 0) return { ...empty, note: `${subSheetType}: no columns could be mapped.` };

  const params: Record<string, string> = {};
  const nameList = input.parentNames.slice(0, 5000).map((n, i) => {
    params[`n${i}`] = n;
    return `@n${i}`;
  });
  const where = `where p.[Name] in (${nameList.join(",")})`;
  const orderCol = relLower.get("order") ? `${base}.[${relLower.get("order")}]` : `p.[Name]`;
  const select = selects.map((s) => `${s.expr} as [${s.label}]`).join(", ");
  const sql = `select top ${limit} ${select} from [${relTable.schema}].[${relTable.table}] ${base} ${joins.join(" ")} ${where} order by ${orderCol}`;

  const dataRows = await cmfQuery<Record<string, unknown>>(sql, params);
  const rows = dataRows.map((r) => {
    const o: Record<string, string> = {};
    for (const s of selects) o[s.label] = r[s.label] == null ? "" : String(r[s.label]);
    return o;
  });
  return { rows, total: rows.length, truncated: rows.length >= limit };
}
