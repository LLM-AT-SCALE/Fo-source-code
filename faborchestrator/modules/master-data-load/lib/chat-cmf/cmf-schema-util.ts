import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset, type EntityRuleset } from "@/modules/master-data-load/lib/validation/metadata";

/**
 * Shared helpers for reading CMF's physical schema and resolving its references.
 *
 * CMF stores object relationships as numeric id columns (`FlowId`,
 * `ProductGroupId`, …), so a related object's NAME only exists after a join.
 * These helpers are used by both the discovery browser and the auto-fill engine
 * to resolve those links to names — while defending against CMF's property
 * metadata, which mis-maps many reference targets (e.g. `CapacityClass ->
 * NonWorkingTime`). We only trust a reference when the property name and its
 * target type overlap (Flow→Flow, ProductGroup→ProductGroup, …).
 */

/** Actual columns of a physical table, from INFORMATION_SCHEMA. */
export async function physicalColumns(schema: string, table: string): Promise<string[]> {
  const rows = await cmfQuery<{ COLUMN_NAME: string }>(
    `select COLUMN_NAME from INFORMATION_SCHEMA.COLUMNS where TABLE_SCHEMA = @s and TABLE_NAME = @t`,
    { s: schema, t: table },
  );
  return rows.map((r) => String(r.COLUMN_NAME));
}

/** A reference we trust enough to join for the target's Name. */
export type RefJoin = {
  /** Display/property name, e.g. "Flow". */
  prop: string;
  /** Physical FK column on the base table, e.g. "FlowId". */
  fkCol: string;
  targetSchema: string;
  targetTable: string;
  /** Target PK column, e.g. "FlowId". */
  targetPk: string;
};

/** prop and target name must overlap — filters CMF's mis-mapped reference metadata. */
function nameMatches(prop: string, target: string): boolean {
  const p = prop.toLowerCase();
  const t = target.toLowerCase();
  return p === t || p.includes(t) || t.includes(p);
}

/**
 * Resolve which reference properties can be joined to show a related NAME.
 * Only keeps references where the FK column exists, the target has a table with
 * a `<Target>Id` PK, and the names match (trustworthy).
 */
export async function resolveRefJoins(
  ruleset: EntityRuleset,
  realLower: Map<string, string>,
  removedCols: Set<string>,
  opts: { trustAll?: boolean } = {},
): Promise<RefJoin[]> {
  const out: RefJoin[] = [];
  const seenTargets = new Map<string, { schema: string; table: string; pk: string } | null>();

  for (const p of ruleset.properties) {
    const target = p.referenceTargetType;
    if (!target) continue;
    if (removedCols.has(p.name.toLowerCase())) continue;
    // By default only trust references whose property name overlaps the target
    // type — CMF's reference metadata is noisy. `trustAll` keeps EVERY declared
    // reference (used by the dependency export, where a name-mismatched FK like
    // Flow.Type→Area or FlowStructures.Target→Step is exactly the link to
    // follow; without it those columns come back blank and the walk finds
    // nothing). The FK column must still physically exist.
    if (!opts.trustAll && !nameMatches(p.name, target)) continue;
    const fkCol = realLower.get(`${p.name.toLowerCase()}id`);
    if (!fkCol) continue;

    let tgt = seenTargets.get(target.toLowerCase());
    if (tgt === undefined) {
      tgt = null;
      const tr = await loadRuleset(target);
      if (tr?.table) {
        const tcols = await physicalColumns(tr.table.schema, tr.table.name);
        const pk = tcols.find((c) => c.toLowerCase() === `${target.toLowerCase()}id`);
        if (pk) tgt = { schema: tr.table.schema, table: tr.table.name, pk };
      }
      seenTargets.set(target.toLowerCase(), tgt);
    }
    if (!tgt) continue;
    out.push({ prop: p.name, fkCol, targetSchema: tgt.schema, targetTable: tgt.table, targetPk: tgt.pk });
  }
  return out;
}
