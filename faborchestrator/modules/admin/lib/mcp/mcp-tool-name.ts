/**
 * MCP tool keys are namespaced per connection as `mcp_<8 hex>__<tool>` (older
 * rows: `mcp_<tool>`). Anywhere the admin app groups or shows a tool name from
 * prompt_audit_logs (tool_calls[].name, timings.toolDetail[].name, "step:…"
 * phase keys) it should show the plain tool name.
 */

const PREFIX_RE = /^mcp_(?:[0-9a-f]{8}__)?/;
const INLINE_RE = /\bmcp_(?:[0-9a-f]{8}__)?(?=[A-Za-z0-9_])/g;

/** "mcp_1a2b3c4d__get_lots" → "get_lots"; "mcp_get_lots" → "get_lots"; other names unchanged. */
export function displayToolName(name: string | null | undefined): string {
  if (typeof name !== "string") return "";
  return name.replace(PREFIX_RE, "");
}

/** Strip the MCP prefix from every tool name embedded in free text (e.g. "step:mcp_ab12cd34__a,mcp_ab12cd34__b"). */
export function stripMcpPrefixes(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text.replace(INLINE_RE, "");
}

/** Map `{name, …}[]` (tool_calls / toolDetail) to display names; anything else is returned untouched. */
export function displayToolCallNames<T>(calls: T): T {
  if (!Array.isArray(calls)) return calls;
  return calls.map((c) =>
    c && typeof c === "object" && "name" in (c as object)
      ? { ...(c as Record<string, unknown>), name: displayToolName((c as { name?: string }).name) }
      : c,
  ) as unknown as T;
}

/**
 * Merge rows that collapse to the same display name (two connections exposing
 * the same tool). `sum` lists the numeric fields to add; `max` those to take the max of;
 * averages are recomputed from `calls`-weighted totals when `avg` is given as [avgField, countField].
 */
export function mergeByDisplayName<T extends Record<string, unknown>>(
  rows: T[],
  nameField: keyof T,
  opts: { sum?: (keyof T)[]; max?: (keyof T)[]; avg?: [keyof T, keyof T] },
): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const name = displayToolName(String(r[nameField] ?? ""));
    const prev = out.get(name);
    if (!prev) {
      out.set(name, { ...r, [nameField]: name });
      continue;
    }
    const merged: Record<string, unknown> = { ...prev };
    const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
    if (opts.avg) {
      const [avgF, cntF] = opts.avg;
      const total = num(prev[avgF]) * num(prev[cntF]) + num(r[avgF]) * num(r[cntF]);
      const cnt = num(prev[cntF]) + num(r[cntF]);
      merged[avgF as string] = cnt ? total / cnt : 0;
    }
    for (const f of opts.sum ?? []) merged[f as string] = num(prev[f]) + num(r[f]);
    for (const f of opts.max ?? []) merged[f as string] = Math.max(num(prev[f]), num(r[f]));
    out.set(name, merged as T);
  }
  return [...out.values()];
}
