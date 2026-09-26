import enumConfig from "@/modules/master-data-load/lib/validation/enum-labels.json";

/**
 * Resolution rules for Int-enum columns that are CMF *system enums* with no
 * database authority (see enum-labels.json). Two jobs:
 *   1. BLANK "undefined/unset" ordinals (e.g. Product.ProductType 0) so the
 *      export never emits a meaningless number as if it were real data.
 *   2. Translate an ordinal to its loadable LABEL once the enum is confirmed
 *      (labels are opt-in per column; unlisted ordinals pass through as-is).
 */

type EnumRule = { blank?: string[]; labels?: Record<string, string> };

const RULES: Map<string, EnumRule> = new Map(
  Object.entries(enumConfig as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith("$") && v && typeof v === "object")
    .map(([k, v]) => [k.toLowerCase(), v as EnumRule]),
);

/**
 * Resolve a raw CMF value for an enum-managed column to the string the template
 * should carry. Returns:
 *   - "" when the value is null/blank or a configured "blank" ordinal (unset);
 *   - the mapped LABEL when one is configured for that ordinal;
 *   - the raw value unchanged otherwise.
 * Returns `undefined` when the column is NOT enum-managed (caller keeps its own
 * handling), so callers can distinguish "managed → blank" from "not managed".
 */
export function resolveEnumValue(
  objectType: string,
  column: string,
  raw: string | null | undefined,
): string | undefined {
  const rule = RULES.get(`${objectType}.${column}`.toLowerCase());
  if (!rule) return undefined;
  const v = raw == null ? "" : String(raw).trim();
  if (v === "") return "";
  if (rule.blank?.includes(v)) return "";
  return rule.labels?.[v] ?? v;
}
