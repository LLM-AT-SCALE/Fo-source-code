import { fetchTemplateRows, type FillSelector } from "@/modules/master-data-load/lib/chat-cmf/fill-from-existing";
import { fetchJunctionRows, subSheetColumnRefType } from "@/modules/master-data-load/lib/chat-cmf/junction-reader";
import { junctionColumnRule } from "@/modules/master-data-load/lib/chat-cmf/junction-list";
import { fetchChildSubflowNames } from "@/modules/master-data-load/lib/chat-cmf/subflow";
import fkExclusions from "@/modules/master-data-load/lib/validation/dependency-fk-exclusions.json";

/** ObjectType(lower) -> set of FK column names(lower) to skip in dependency
 *  discovery (see dependency-fk-exclusions.json). */
const FK_EXCLUDE = new Map<string, Set<string>>(
  Object.entries(fkExclusions as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith("$") && Array.isArray(v))
    .map(([k, v]) => [k.toLowerCase(), new Set((v as string[]).map((s) => s.toLowerCase()))]),
);
import { resolveExportPlan, canonicalType, isDeepRoot } from "@/modules/master-data-load/lib/chat-cmf/dependency-resolver";
import { loadRuleset, type EntityRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { generateLeanMulti } from "@/modules/master-data-load/lib/validation/lean-template";
import { parseWorkbook } from "@/modules/master-data-load/lib/validation/xlsx";
import { createStagedUpload, getStagedUpload } from "@/modules/master-data-load/lib/repo-cmf/validation";

/**
 * Scope 2 — export an object PLUS its whole dependency chain into ONE loader,
 * pre-filled with the real CMF records for the chosen root(s).
 *
 * Pipeline:
 *   1. resolveExportPlan() → the ordered set of object types + their sub-sheets
 *      (execution order = load order, parents first).
 *   2. Data walk: fetch the root record(s) by the user's selector, then follow
 *      FK-resolved NAMES through already-fetched rows to pull exactly the
 *      referenced records at each level (fix-point). Sub-sheets are pulled by
 *      their parent's names (reverse FK). Types with no discoverable link are
 *      left as empty sheets and reported — we never dump unrelated records.
 *   3. Merge into one rowsByType, dedupe, assemble with generateFromSkeleton
 *      (narrow scope), stage for download.
 *
 * Multiple roots (e.g. two flows) are merged into one loader. `startFromStagingId`
 * appends the export to an existing session loader.
 */

const MAX_PER_TYPE = 1000;
const MAX_PASSES = 8;
// Whole-export row budget across ALL sheets. A deep Flow export (every Step's
// full definition + all context sub-sheets, plus recursive subflows) can pull
// enough rows to exhaust the single app instance when the workbook is assembled
// in memory — this once hung production. Once the budget is spent the walk stops
// pulling more and reports the truncation, so the export always completes and the
// process stays healthy. Override with EXPORT_MAX_TOTAL_ROWS.
const MAX_TOTAL_ROWS = Math.max(1000, Number(process.env.EXPORT_MAX_TOTAL_ROWS ?? "20000") || 20000);

type Rows = Record<string, string>[];

/** Distinct non-empty Name values across rows. */
function rowNames(rows: Rows): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const key = Object.keys(r).find((k) => k.toLowerCase() === "name");
    const v = key ? r[key]?.trim() : "";
    if (v) out.add(v);
  }
  return [...out];
}

/** Row identity for de-duplication (order-independent over its cells). */
function rowKey(r: Rows[number]): string {
  return JSON.stringify(
    Object.entries(r)
      .filter(([, v]) => v !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function mergeRows(into: Rows, add: Rows): void {
  const seen = new Set(into.map(rowKey));
  for (const r of add) {
    const k = rowKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      into.push(r);
    }
  }
}

type DependencyEntry = {
  objectType: string;
  required: boolean;
  rowCount: number;
  /** How this type's records were selected. */
  fill: "linked" | "root" | "sub-sheet" | "empty";
};

export type ExportWithDependenciesResult = {
  stagingId?: string;
  filename?: string;
  root: string;
  dependencyList: DependencyEntry[];
  totalRows: number;
  /** Human-readable caveats (truncations, unlinked types) for the assistant. */
  notes: string[];
  error?: string;
};

/** Same as the export result but carries the assembled bytes instead of a
 *  stagingId — the S3-free core, so the whole walk + assembly is testable
 *  without staging. `exportWithDependencies` wraps this and stages the bytes. */
type ExportBuildResult = Omit<ExportWithDependenciesResult, "stagingId"> & { bytes?: Buffer };

async function buildExportWorkbook(input: {
  userId: string;
  rootObjectType: string;
  selector?: FillSelector;
  includeOptional?: boolean;
  packageName: string;
  startFromStagingId?: string;
}): Promise<ExportBuildResult> {
  const plan = resolveExportPlan(input.rootObjectType, { includeOptional: input.includeOptional });
  if (!plan) {
    return {
      root: input.rootObjectType,
      dependencyList: [],
      totalRows: 0,
      notes: [],
      error: `"${input.rootObjectType}" isn't a loadable object type in this template.`,
    };
  }
  const root = plan.root;
  const notes: string[] = [];

  // Cache rulesets (FK metadata) so the walk hits CMF once per type.
  const rsCache = new Map<string, EntityRuleset | null>();
  const ruleset = async (t: string) => {
    if (!rsCache.has(t)) rsCache.set(t, await loadRuleset(t));
    return rsCache.get(t) ?? null;
  };

  // Which columns of `srcType` reference `targetType`. Match the declared
  // referenceTargetType to the canonical type either exactly, or where the ref
  // name CONTAINS the target (CMF may name the entity slightly differently, e.g.
  // "MC Area" for Area). We deliberately do NOT match the reverse (target
  // contains ref): that made compound types (ResourceService, CompatibleService,
  // StepReason) falsely match a shorter reference (Service, Reason) — e.g. a
  // ServiceContext.`Service` column would be mistaken for a ResourceService FK,
  // sending the walk to fetch ResourceService by service names (→ 0 rows) instead
  // of via the junction table.
  const refCols = async (srcType: string, targetType: string): Promise<string[]> => {
    const rs = await ruleset(srcType);
    if (!rs) return [];
    const tl = targetType.toLowerCase();
    // FK columns that reference an object but are NOT its real dependency here
    // (e.g. Step.QueuedStorageService/ProcessedStorageService point at a STORAGE
    // service, not the step's process service) — skip them so the dependency
    // sheet isn't polluted. See dependency-fk-exclusions.json.
    const excluded = FK_EXCLUDE.get(srcType.toLowerCase());
    return rs.properties
      .filter((p) => {
        if (excluded?.has(p.name.toLowerCase())) return false;
        const ref = p.referenceTargetType;
        if (!ref) return false;
        if (canonicalType(ref) === targetType) return true;
        const rl = ref.toLowerCase();
        return rl === tl || rl.includes(tl);
      })
      .map((p) => p.name.toLowerCase());
  };

  const fetched = new Map<string, Rows>(); // canonical type -> rows
  const fill = new Map<string, DependencyEntry["fill"]>();

  // The export resolves EVERY declared reference (trustAllRefs), including
  // name-mismatched ones like Flow.Type→Area and FlowStructures.Target→Step —
  // those are the links to follow; the default name-matched resolution leaves
  // them blank and the walk finds nothing.
  // Resilient fetch: a single CMF reset mid-walk must not abort the whole
  // export. On a thrown error we return an empty result with the message so the
  // walk records it and moves on (the sheet is included empty, diagnosably).
  // `effectiveOnly` defaults FALSE for dependency/structure fetches — those
  // tables (FlowStructures, sub-sheets, junction rows) often don't carry
  // IsDefaultRevision=1, so the effective filter would wrongly drop them.
  type FetchRes = Awaited<ReturnType<typeof fetchTemplateRows>>;
  const safeFetch = async (t: string, sel: FillSelector, effectiveOnly = false): Promise<FetchRes> => {
    try {
      return await fetchTemplateRows(t, { ...sel, limit: MAX_PER_TYPE }, { trustAllRefs: true, effectiveOnly, fillRequiredDefaults: true });
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      return { objectType: t, columnsFilled: [], rows: [], total: 0, truncated: false, error: msg };
    }
  };

  // 1) Root record(s) by the caller's selector — the effective flow only.
  const rootRes = await safeFetch(root, { ...input.selector }, true);
  if (rootRes.error) return { root, dependencyList: [], totalRows: 0, notes, error: rootRes.error };
  fetched.set(root, rootRes.rows);
  fill.set(root, "root");
  if (rootRes.truncated) notes.push(`${root}: matched ${rootRes.total} record(s), capped at ${rootRes.rows.length}.`);

  // Whole-export row budget (see MAX_TOTAL_ROWS). `admit` trims a freshly-read
  // sheet to what's left and records the shortfall; `budgetLeft` lets the walk
  // stop cleanly once spent so the workbook stays small enough to assemble.
  let totalRowsFetched = rootRes.rows.length;
  const budgetLeft = () => Math.max(0, MAX_TOTAL_ROWS - totalRowsFetched);
  let budgetNoted = false;
  const admit = (t: string, rows: Rows): Rows => {
    const room = budgetLeft();
    let kept = rows;
    if (rows.length > room) {
      kept = rows.slice(0, room);
      notes.push(`${t}: export row cap (${MAX_TOTAL_ROWS}) reached — kept ${room} of ${rows.length} rows. Narrow the selection or raise EXPORT_MAX_TOTAL_ROWS.`);
    }
    totalRowsFetched += kept.length;
    return kept;
  };

  // Recursively pull SUBFLOWS (Flow root only): a Flow can embed child Flows as
  // "line" nodes (T_FlowStep.IsLine=true → Target is a sub-Flow). Grow the Flow
  // row-set to every reachable subflow so the main walk then pulls each one's
  // FlowStructures + full step definitions. Cycle-safe (a flow may reference
  // itself — track seen names) and budget-bounded. Inert where flows have no
  // subflows (KSP has none — every FlowStep is IsLine=false).
  if (root.toLowerCase() === "flow") {
    const flowRows = fetched.get(root)!;
    const seen = new Set(rowNames(flowRows).map((n) => n.toLowerCase()));
    let frontier = [...new Set(rowNames(flowRows))];
    while (frontier.length && budgetLeft() > 0) {
      let children: string[];
      try {
        children = await fetchChildSubflowNames(frontier);
      } catch (e) {
        notes.push(`subflows: couldn't be read this time (${(e as { message?: string })?.message ?? e}).`);
        break;
      }
      const fresh = children.filter((n) => !seen.has(n.toLowerCase()));
      if (!fresh.length) break;
      fresh.forEach((n) => seen.add(n.toLowerCase()));
      const res = await safeFetch(root, { names: fresh }, true);
      mergeRows(flowRows, admit(root, res.rows));
      if (res.rows.length) notes.push(`Included ${fresh.length} subflow(s) of the selected flow.`);
      frontier = fresh;
    }
  }

  // Every type to pull: top-level types plus their sub-sheets. A sub-sheet
  // records its parent so it can be pulled by the parent's names (reverse FK).
  // `subsByParent` gives each sub-sheet's siblings — passed to the junction
  // reader as possible intermediates for nested grandchildren.
  // A sub-sheet can belong to SEVERAL parents (e.g. ResourceService is a
  // sub-sheet of both Service and Resource). Track ALL parents so the walk can
  // pull it from whichever parent already has rows — pulling via only the
  // last-declared parent deadlocks when that parent is itself discovered FROM
  // this sub-sheet (Service root → Resource is found via ResourceService, so
  // ResourceService must be read via Service, not via the still-empty Resource).
  const parentsOfSub = new Map<string, string[]>();
  const subsByParent = new Map<string, string[]>();
  for (const t of plan.types) {
    if (t.subSheets.length) subsByParent.set(t.objectType, t.subSheets);
    for (const s of t.subSheets) {
      const arr = parentsOfSub.get(s) ?? [];
      if (!arr.includes(t.objectType)) arr.push(t.objectType);
      parentsOfSub.set(s, arr);
    }
  }
  const walkTypes = [...new Set([...plan.types.map((t) => t.objectType), ...parentsOfSub.keys()])].filter(
    (t) => t !== root,
  );

  // Forward names referencing `target`, gathered from every fetched row two ways:
  //  1. FK metadata — columns the entity model says reference `target`.
  //  2. Column NAME — a column whose header resolves (exact/suffix) to `target`,
  //     e.g. a sub-sheet's `Parameter` or `SourceProduct` column. This is what
  //     lets junction rows (DataCollectionParameters, BOMProducts) feed the
  //     top-level dependency fetch (Parameter, Product).
  const forwardNames = async (target: string): Promise<Set<string>> => {
    const names = new Set<string>();
    for (const [srcType, rows] of fetched) {
      if (!rows.length) continue;
      const fkCols = new Set(await refCols(srcType, target));
      const excludedCols = FK_EXCLUDE.get(srcType.toLowerCase());
      for (const r of rows)
        for (const [k, v] of Object.entries(r)) {
          if (!v?.trim()) continue;
          // Skip FK columns that reference an object but aren't its real dependency
          // (e.g. Step.QueuedStorageService/ProcessedStorageService → a STORAGE
          // service). refCols already drops them, but the column-NAME suffix match
          // below (`...Service`) would still pull them in — so skip here too.
          if (excludedCols?.has(k.toLowerCase())) continue;
          // A M:N "list" column (e.g. Step.Areas) holds several Names joined by a
          // separator — split so each referenced object (Area) is discovered.
          const listRule = junctionColumnRule(srcType, k);
          if (listRule && listRule.targetType === target) {
            for (const part of v.split(listRule.separator)) if (part.trim()) names.add(part.trim());
            continue;
          }
          // subSheetColumnRefType resolves relationship-sub-sheet endpoints too
          // (e.g. FlowStructures.`Target` → Step), so a Flow discovers its Steps.
          if (fkCols.has(k.toLowerCase()) || subSheetColumnRefType(srcType, k) === target) names.add(v.trim());
        }
    }
    return names;
  };

  // ONE fix-point over top-level types AND sub-sheets. Each pass resolves any
  // type reachable from what's already fetched — a top-level type via forward
  // FK names, a sub-sheet via its parent's names (reverse FK). Sub-sheets can
  // therefore unlock further top-level types (e.g. FlowStructures → Step) and
  // vice-versa, so the whole flow tree fills regardless of link direction.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const t of walkTypes) {
      if (fetched.has(t)) continue;
      // Stop pulling new sheets once the whole-export row budget is spent —
      // remaining types fall through to empty sheets (noted once), keeping the
      // assembled workbook bounded.
      if (budgetLeft() <= 0) {
        if (!budgetNoted) {
          notes.push(`Export row cap (${MAX_TOTAL_ROWS}) reached — remaining linked sheets were left empty. Narrow the selection or raise EXPORT_MAX_TOTAL_ROWS.`);
          budgetNoted = true;
        }
        break;
      }
      // Forward: names referencing t from any fetched rows. These are top-level
      // ENTITIES (Product, Parameter, Area, …) — fetch the EFFECTIVE revision
      // only, else a change-controlled object returns every version (a Product
      // with 3 revisions → 3 duplicate rows, and the old revisions carry empty
      // required fields → spurious validation errors).
      const names = await forwardNames(t);
      if (names.size) {
        const res = await safeFetch(t, { names: [...names] }, true);
        const kept = admit(t, res.rows);
        fetched.set(t, kept);
        fill.set(t, kept.length ? "linked" : "empty");
        if (res.error) notes.push(`${t}: couldn't be read this time (${res.error}).`);
        else if (res.truncated) notes.push(`${t}: ${res.total} referenced, capped at ${res.rows.length}.`);
        changed = true;
        continue;
      }
      // Reverse: if t is a sub-sheet, pull it via the CMF relationship table
      // (T_<sub>: SourceEntityId→parent, TargetEntityId/<col>Id→referenced names)
      // keyed by a parent's names. This is the ONLY way sub-sheet data reads —
      // sub-sheets are not queryable entities. Pull from EVERY parent that
      // already has rows and merge (a sub-sheet shared by two parents resolves
      // via whichever is present).
      const readyParents = (parentsOfSub.get(t) ?? []).filter((p) => fetched.get(p)?.length);
      if (readyParents.length) {
        const merged: Rows = [];
        for (const parent of readyParents) {
          try {
            const res = await fetchJunctionRows({
              parentType: parent,
              subSheetType: t,
              parentNames: rowNames(fetched.get(parent)!),
              intermediates: (subsByParent.get(parent) ?? []).filter((s) => s !== t),
              limit: MAX_PER_TYPE,
            });
            mergeRows(merged, res.rows);
            if (res.note) notes.push(res.note);
            if (res.truncated) notes.push(`${t}: capped at ${res.rows.length} rows.`);
          } catch (e) {
            notes.push(`${t}: couldn't be read this time (${(e as { message?: string })?.message ?? e}).`);
          }
        }
        const kept = admit(t, merged);
        fetched.set(t, kept);
        fill.set(t, kept.length ? "sub-sheet" : "empty");
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Anything still unresolved → empty sheet (never dump unrelated records).
  for (const t of walkTypes) {
    if (!fetched.has(t)) {
      fetched.set(t, []);
      fill.set(t, "empty");
      const why = parentsOfSub.has(t) ? `couldn't auto-link to ${parentsOfSub.get(t)!.join("/")}` : `no link to the selected ${root} found`;
      notes.push(`${t}: ${why} — included as an empty sheet.`);
    }
  }

  // 3) Assemble. Merge into rowsByType (dedupe), keeping only types with rows so
  // the narrow layout hides untouched sheets — but ALWAYS include the root.
  const rowsByType: Record<string, Rows> = {};
  for (const [t, rows] of fetched) {
    if (rows.length || t === root) {
      const bucket = (rowsByType[t] ??= []);
      mergeRows(bucket, rows);
    }
  }

  // Ordered sheet types (execution order — parents first) for the Index.
  const orderedTypes = plan.types.map((t) => t.objectType);

  // Extending an existing loader → read its rows and fold them in (lean loaders
  // are small, so parseWorkbook is safe), then regenerate the whole file.
  if (input.startFromStagingId) {
    const staged = await getStagedUpload(input.startFromStagingId, input.userId);
    if (!staged) return { root, dependencyList: [], totalRows: 0, notes, error: `Loader ${input.startFromStagingId} not found.` };
    for (const s of await parseWorkbook(staged.bytes)) {
      if (!s.rows.length) continue;
      const canon = canonicalType(s.objectType) ?? s.objectType;
      mergeRows((rowsByType[canon] ??= []), s.rows);
      if (!orderedTypes.some((t) => t.toLowerCase() === canon.toLowerCase())) orderedTypes.push(canon);
    }
  }

  // Assemble via the LEAN generator: a from-scratch workbook with a TRIMMED
  // Index listing ONLY the involved sheets (self-consistent → CMF-valid), and
  // data written at row 2 so it's visible.
  // Index composition expansion must match the data walk: for a deep root (Flow)
  // every type expands its sub-sheets; otherwise only the root does.
  const gen = await generateLeanMulti(orderedTypes, rowsByType, isDeepRoot(root) ? undefined : root);

  const filename = `${root}_with_deps_${input.packageName.replace(/[^a-zA-Z0-9._-]+/g, "_")}.xlsx`;

  // Dependency list in load order (root's required chain first, optional after).
  // Sub-sheets sort right after their parent and inherit its required flag.
  const order = new Map<string, { i: number; required: boolean }>();
  plan.types.forEach((t, i) => {
    order.set(t.objectType, { i: i * 100, required: t.required });
    t.subSheets.forEach((s, j) => order.set(s, { i: i * 100 + j + 1, required: t.required }));
  });
  const dependencyList: DependencyEntry[] = [...fetched.entries()]
    .map(([objectType, rows]) => ({
      objectType,
      required: order.get(objectType)?.required ?? false,
      rowCount: rows.length,
      fill: fill.get(objectType) ?? "empty",
    }))
    .sort((a, b) => (order.get(a.objectType)?.i ?? 1e9) - (order.get(b.objectType)?.i ?? 1e9));

  const totalRows = Object.values(rowsByType).reduce((n, r) => n + r.length, 0);

  return { bytes: gen.bytes, filename, root, dependencyList, totalRows, notes };
}

/** Build the dependency-export workbook and stage it for download. */
export async function exportWithDependencies(input: {
  userId: string;
  rootObjectType: string;
  selector?: FillSelector;
  includeOptional?: boolean;
  packageName: string;
  startFromStagingId?: string;
}): Promise<ExportWithDependenciesResult> {
  const built = await buildExportWorkbook(input);
  const { bytes, ...rest } = built;
  if (built.error || !bytes) return rest;
  const staged = await createStagedUpload({
    userId: input.userId,
    filename: built.filename!,
    bytes,
    packageName: input.packageName,
  });
  return { ...rest, stagingId: staged.id };
}
