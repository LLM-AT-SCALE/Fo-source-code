import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { entityTablePk, findRelTable } from "@/modules/master-data-load/lib/chat-cmf/junction-reader";
import junctionColumns from "@/modules/master-data-load/lib/validation/junction-columns.json";

/**
 * M:N "list" template columns (e.g. Step.Areas) — a parent object carries a
 * separator-joined list of related Names in one cell, sourced from a CMF
 * Source/Target relationship table (T_<relTable>: SourceEntityId -> parent,
 * TargetEntityId -> target). These can't be resolved as a single FK, so we fill
 * them here and let the dependency walk split them to discover the target
 * records. See junction-columns.json.
 */

export type JunctionColumnRule = { relTable: string; targetType: string; separator: string };

const RULES: Map<string, JunctionColumnRule> = new Map(
  Object.entries(junctionColumns as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith("$") && v && typeof v === "object" && (v as JunctionColumnRule).relTable)
    .map(([k, v]) => [k.toLowerCase(), v as JunctionColumnRule]),
);

/** The junction-list columns declared for `objectType`, as [column, rule] pairs. */
export function junctionColumnsFor(objectType: string): [string, JunctionColumnRule][] {
  const prefix = `${objectType.toLowerCase()}.`;
  const out: [string, JunctionColumnRule][] = [];
  for (const [key, rule] of RULES) {
    if (key.startsWith(prefix)) out.push([key.slice(prefix.length), rule]);
  }
  return out;
}

/** The rule for a specific `ObjectType.Column`, if it is a junction-list column. */
export function junctionColumnRule(objectType: string, column: string): JunctionColumnRule | null {
  return RULES.get(`${objectType}.${column}`.toLowerCase()) ?? null;
}

/**
 * For each parent name, the related target Names via the relationship table.
 * Returns a map keyed by the parent Name (verbatim) → array of target Names.
 * Empty map on any resolution failure (missing table/PK) — the caller then
 * leaves the column blank rather than erroring the whole export.
 */
export async function fetchJunctionListValues(
  parentType: string,
  parentNames: string[],
  rule: JunctionColumnRule,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const names = [...new Set(parentNames.filter((n) => n && n.trim()))];
  if (!names.length) return out;

  const [rel, parent, target] = await Promise.all([
    findRelTable(rule.relTable),
    entityTablePk(parentType),
    entityTablePk(rule.targetType),
  ]);
  if (!rel || !parent || !target) return out;

  const params: Record<string, string> = {};
  const ph = names.map((n, i) => {
    params[`n${i}`] = n;
    return `@n${i}`;
  });
  const sql =
    `select src.[Name] as parentName, tgt.[Name] as targetName ` +
    `from [${rel.schema}].[${rel.table}] r ` +
    `join [${parent.schema}].[${parent.table}] src on src.[${parent.pk}] = r.[SourceEntityId] ` +
    `join [${target.schema}].[${target.table}] tgt on tgt.[${target.pk}] = r.[TargetEntityId] ` +
    `where src.[Name] in (${ph.join(", ")}) and tgt.[Name] is not null ` +
    `order by src.[Name], tgt.[Name]`;

  const rows = await cmfQuery<{ parentName: string; targetName: string }>(sql, params);
  for (const r of rows) {
    if (!r.parentName || !r.targetName) continue;
    const list = out.get(r.parentName) ?? [];
    if (!list.includes(r.targetName)) list.push(r.targetName);
    out.set(r.parentName, list);
  }
  return out;
}
