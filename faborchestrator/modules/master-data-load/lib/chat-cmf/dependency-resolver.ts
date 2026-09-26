import dependencyGraph from "@/modules/master-data-load/lib/validation/dependency-graph.json";
import executionOrder from "@/modules/master-data-load/lib/validation/execution-order.json";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";
import { getComposition } from "@/modules/master-data-load/lib/validation/composition";

/**
 * Transitive dependency resolver for master-data EXPORT (Scope 2).
 *
 * A complex object (Flow, Schedule) can't be loaded alone — CMF needs the
 * objects it references to already exist, loaded in EXECUTION ORDER (parents
 * first). Given a root object type this walks `dependency-graph.json` to the
 * full set of object types that must ride along, attaches each type's
 * composition sub-sheets, and orders everything by `execution-order.json`
 * (the authoritative CMF load order) so the generated workbook's sheets are
 * in a loadable sequence.
 *
 * `required` edges are always followed; `optional` context/association tables
 * are included only when `includeOptional` is set (the user can trim them).
 * Pure data + JSON — no CMF round-trips; the actual record pre-fill happens in
 * the export tool.
 */

const RESERVED = new Set(["$order", "$ambiguous"]);
type SchemaEntry = { raw: string; columns: string[] };
const SCHEMA = templateSchema as unknown as Record<string, SchemaEntry>;
const GRAPH = dependencyGraph as unknown as Record<
  string,
  { required?: string[]; optional?: string[] }
>;
const EXEC = executionOrder as unknown as Record<string, number>;

const NO_ORDER = 100000; // types without an execution order sort to the end

/**
 * Roots whose dependency objects are DEEP-expanded (each dependency brings its
 * own composition sub-sheets), because those dependencies are the root's actual
 * CONTENT rather than external references. A Flow IS its Steps — a Flow export
 * should carry the full Step definitions (StepReason, contexts, …), not a bare
 * Step sheet. Every other root keeps dependencies as single referenceable sheets
 * (a BOM references Products; it does not redefine them).
 *
 * `service` is deep too: the client requires a Service export to carry its
 * linked Resource WITH all its sub-sheets (ResourceService + StorageBin,
 * ResourceInventory, ... — "resource with all the dependent sheets"), not a bare
 * Resource reference. Service's only direct dependency is Resource, so deep
 * expansion here means exactly that.
 */
const DEEP_ROOTS = new Set(["flow", "service"]);

/** True when `root` (canonical) deep-expands its dependency objects' composition. */
export function isDeepRoot(root: string | null): boolean {
  return !!root && DEEP_ROOTS.has(root.toLowerCase());
}

const byLower = new Map(
  Object.keys(SCHEMA)
    .filter((k) => !RESERVED.has(k))
    .map((k) => [k.toLowerCase(), k]),
);

/** Canonical schema spelling for a type name, or null if not a loadable sheet. */
export function canonicalType(name: string): string | null {
  return byLower.get(name.toLowerCase()) ?? null;
}

function graphFor(type: string): { required: string[]; optional: string[] } {
  const g = GRAPH[type] ?? {};
  return { required: g.required ?? [], optional: g.optional ?? [] };
}

type PlanType = {
  /** Canonical object type. */
  objectType: string;
  /** True if reached through the required-dependency chain (or is the root). */
  required: boolean;
  /** Execution order (ascending = load first); NO_ORDER if unknown. */
  execOrder: number;
  /** Canonical composition sub-sheet types that load with this object. */
  subSheets: string[];
};

export type ExportPlan = {
  root: string;
  /** Every object type to include, ordered ascending by execution order. */
  types: PlanType[];
};

/**
 * Resolve the full ordered set of object types to export for `rootObjectType`.
 * Required deps are always included; optional context tables only when
 * `includeOptional` is true. Unknown / non-loadable types are skipped.
 */
export function resolveExportPlan(
  rootObjectType: string,
  opts: { includeOptional?: boolean } = {},
): ExportPlan | null {
  const root = canonicalType(rootObjectType);
  if (!root) return null;

  // The root's DIRECT required dependency objects only — NOT the transitive
  // chain. The client's per-object sheets list one level (a Resource pulls Area,
  // not Area→Facility→Site; a BOM pulls Product, not Product's own deps). For a
  // same-CMF load those grand-parents already exist; the parent-precheck confirms
  // it. (Cross-environment deep packaging would be a separate, opt-in mode.)
  const requiredSet = new Set<string>([root]);
  for (const dep of graphFor(root).required) {
    const c = canonicalType(dep);
    if (c) requiredSet.add(c);
  }

  // The root's own optional context/association objects (only when requested).
  const optionalSet = new Set<string>();
  if (opts.includeOptional) {
    for (const opt of graphFor(root).optional) {
      const c = canonicalType(opt);
      if (c && !requiredSet.has(c)) optionalSet.add(c);
    }
  }

  const all = [
    ...[...requiredSet].map((t) => ({ objectType: t, required: true })),
    ...[...optionalSet].map((t) => ({ objectType: t, required: false })),
  ];

  const deep = isDeepRoot(root);
  const types: PlanType[] = all.map(({ objectType, required }) => {
    // The ROOT always expands its composition. Dependency objects expand ONLY
    // for a deep root (Flow — its Steps are its content); otherwise they come in
    // as a single referenceable sheet (a BOM pulls Product as one sheet, not
    // Product + ProductParameters + ProductManufacturer).
    const comp = deep || objectType === root ? getComposition(objectType) : null;
    return {
      objectType,
      required,
      execOrder: EXEC[objectType] ?? NO_ORDER,
      subSheets: comp ? comp.subSheets.map((s) => s.objectType) : [],
    };
  });

  // Load parents before children.
  types.sort((a, b) => a.execOrder - b.execOrder || a.objectType.localeCompare(b.objectType));
  return { root, types };
}
