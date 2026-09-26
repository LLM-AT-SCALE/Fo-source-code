import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { entityTablePk, findRelTable } from "@/modules/master-data-load/lib/chat-cmf/junction-reader";

/**
 * Child SUBFLOW names for a set of parent flows.
 *
 * A Flow can embed other Flows as "line" nodes: a `T_FlowStep` row with
 * `IsLine = 1` whose `TargetEntityId` points at a child Flow (not a step). Because
 * T_Step and T_Flow use separate id sequences whose values overlap, a flow node
 * can only be recognised as a subflow by the `IsLine` flag — never by testing
 * whether the target id exists in T_Flow (it always appears to). This resolves the
 * target strictly through T_Flow AND requires IsLine=1, so ordinary step nodes are
 * never mistaken for subflows.
 *
 * Returns the distinct child-flow Names. Empty where no flow has a subflow (e.g.
 * the KSP environment, where every FlowStep is IsLine=false).
 */
export async function fetchChildSubflowNames(parentFlowNames: string[]): Promise<string[]> {
  const names = [...new Set(parentFlowNames.filter((n) => n && n.trim()))];
  if (!names.length) return [];

  const [rel, flow] = await Promise.all([findRelTable("FlowStep"), entityTablePk("Flow")]);
  if (!rel || !flow) return [];

  const params: Record<string, string> = {};
  const ph = names.slice(0, 5000).map((n, i) => {
    params[`n${i}`] = n;
    return `@n${i}`;
  });
  const sql =
    `select distinct sub.[Name] as SubflowName ` +
    `from [${rel.schema}].[${rel.table}] fs ` +
    `join [${flow.schema}].[${flow.table}] pf on pf.[${flow.pk}] = fs.[SourceEntityId] ` +
    `join [${flow.schema}].[${flow.table}] sub on sub.[${flow.pk}] = fs.[TargetEntityId] ` +
    `where fs.[IsLine] = 1 and pf.[Name] in (${ph.join(", ")}) and sub.[Name] is not null`;

  const rows = await cmfQuery<{ SubflowName: string }>(sql, params);
  return [...new Set(rows.map((r) => r.SubflowName).filter(Boolean))];
}
