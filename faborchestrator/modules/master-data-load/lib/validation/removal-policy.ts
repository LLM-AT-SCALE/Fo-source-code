import overrides from "@/modules/master-data-load/lib/validation/template-overrides.json";

/**
 * Client-driven template overrides.
 *
 * `template-overrides.json` captures the client's TemplateObjectCatalog.xlsx
 * strike-through rows (= object removal) and red-font column names (= column
 * removal). Provenance for this file and its source catalog is recorded in
 * `template-assets.meta.json` (hashes of both assets and the catalog they came from).
 *
 * This module is the SINGLE consumer of that file. Every chatbot
 * touch-point reads from these helpers so the same blacklist applies
 * everywhere: generation, form rendering, prefill, preview, lookups.
 */

type Overrides = {
  removedObjects?: string[];
  removedColumns?: Record<string, string[]>;
};
const data = overrides as Overrides;

const removedObjectSet = new Set((data.removedObjects ?? []).map((s) => s.toLowerCase()));
const removedColumnsByObject = new Map<string, Set<string>>(
  Object.entries(data.removedColumns ?? {}).map(([obj, cols]) => [
    obj.toLowerCase(),
    new Set(cols.map((c) => c.toLowerCase())),
  ]),
);

/** True when the client has marked an object for removal from the template. */
export function isObjectRemoved(objectType: string): boolean {
  return removedObjectSet.has(objectType.toLowerCase());
}

/**
 * COLUMN REMOVAL DISABLED (Danish, 2026-08-03).
 *
 * The `removedColumns` overrides were extracted from the client's catalog
 * (red-font columns) and applied when generating from `KSP_DL_client_final.xlsx`.
 * They strip columns CMF actually requires — e.g. `Config.ValueType` — so a
 * generated file fails CMF's dry-run with
 * "The given key 'ValueType' was not present in the dictionary" (verified live
 * 2026-08-03). Now that generation uses the pristine `KSP_DL_AI.xlsx` (which CMF
 * accepts with ALL columns present), removing columns is both unnecessary and
 * harmful, so `isColumnRemoved`/`getRemovedColumns` are forced empty.
 *
 * `removedColumnsByObject` (the parsed data) is kept intact for reference.
 * To RE-ENABLE, restore the original one-line bodies below.
 */

/** Column removal is disabled — always false. (see note above) */
export function isColumnRemoved(_objectType: string, _columnName: string): boolean {
  void removedColumnsByObject; // data retained for reference; intentionally unused
  return false;
}

/** Column removal is disabled — always empty. (see note above) */
export function getRemovedColumns(_objectType: string): Set<string> {
  return new Set();
}
