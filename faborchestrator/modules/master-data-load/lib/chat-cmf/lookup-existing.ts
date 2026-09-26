import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";

/**
 * Look up existing CMF rows by Name for "update", "clone", and "diff" intents.
 *
 * The chatbot's Phase 1.7 needs this whenever the user says:
 *   - "Change Site for MAT-001 to SITE-B"        (update existing → diff cells)
 *   - "Make 10 materials like MAT-001"           (clone → copy then mutate)
 *   - "Show me MAT-001"                           (inspect)
 *
 * For each requested name we issue one parametrised query against the entity's
 * physical table and return the row as a `Record<string, string>` so the LLM
 * (or the prefill engine) can hand it straight to `renderEntryForm` as
 * `prefilledRows`.
 *
 * Design notes (kept minimal per CLAUDE.md):
 *   - One batched IN-query per object type (10–50 names is the typical caller
 *     scale; a single query handles that well).
 *   - Returns a parallel `notFound` list so the LLM can tell the user which
 *     names didn't exist.
 *   - When the ruleset has no backing table, returns `metadataMissing: true`
 *     so callers can degrade gracefully.
 */

export type LookupExistingResult = {
  objectType: string;
  /** Found rows, keyed by Name → column → value. */
  rows: Record<string, Record<string, string>>;
  /** Requested names that didn't match a CMF row. */
  notFound: string[];
  metadataMissing: boolean;
};

export async function lookupExisting(
  objectType: string,
  names: string[],
): Promise<LookupExistingResult> {
  if (names.length === 0) {
    return { objectType, rows: {}, notFound: [], metadataMissing: false };
  }

  const ruleset = await loadRuleset(objectType);
  if (!ruleset?.table) {
    return { objectType, rows: {}, notFound: names, metadataMissing: true };
  }

  // Build parametrised IN-clause (@n0, @n1, …) so we don't expose SQL to user
  // text. Table/column identifiers are bracket-quoted CMF metadata strings,
  // which we already trust elsewhere.
  const params: Record<string, string> = {};
  const placeholders: string[] = [];
  names.forEach((n, i) => {
    params[`n${i}`] = n;
    placeholders.push(`@n${i}`);
  });

  // `select *` is intentional here: callers (update / clone flows) want every
  // column the physical row has so they can show current values. Projecting
  // `ruleset.properties` by name is unsafe because some CMF metadata names
  // (e.g. `Id`) don't always match a real column on the physical table — that
  // raised "Invalid column name 'Id'" in Phase 2 testing.
  const sql = `select * from [${ruleset.table.schema}].[${ruleset.table.name}] where [Name] in (${placeholders.join(", ")})`;

  const found = await cmfQuery<Record<string, unknown>>(sql, params);
  const rows: Record<string, Record<string, string>> = {};
  for (const r of found) {
    const name = String(r.Name ?? "").trim();
    if (!name) continue;
    const stringified: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      stringified[k] = v == null ? "" : String(v);
    }
    rows[name] = stringified;
  }
  const notFound = names.filter((n) => !(n in rows));

  return { objectType: ruleset.objectType, rows, notFound, metadataMissing: false };
}
