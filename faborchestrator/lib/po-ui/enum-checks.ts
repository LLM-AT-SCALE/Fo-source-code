/**
 * ENUM COLUMNS — a column bound to a CMF enum must not be typed as a plain int.
 *
 * THE QUESTION THIS ANSWERS, WHICH THE GAP REPORT ASKED ON EVERY RUN
 *   "Should Material `SystemState` be rendered as the raw integer (5) or as the
 *   enum reference (11 / referenceType 6)?" We could not settle it: the schema
 *   says `Int`, and Athena's delivered page renders it through a hand-written
 *   template, so it carries no type code at all and gives no evidence either way.
 *
 *   The live CMF schema settles it (F-154). `SystemState` carries
 *   `ReferenceType: 6` — the same marker as `UniversalState`, `ProcessingType`
 *   and **812 other properties**. Its `ScalarType` is `Int` because that is how
 *   an enum is STORED; `ReferenceType` is what says how it is RENDERED. Typing
 *   it 5 loses the state icons and shows an operator a bare number.
 *
 * WHY A CHECK RATHER THAN A RULE IN THE PROMPT
 *   The model decides type codes, and it should: F-148 measured a case where the
 *   artifacts legitimately contradict the schema (`Quantity` is `Decimal` but
 *   every real page types it Integer). A check catches the specific error without
 *   removing that judgement, and it can say exactly which property and why.
 *
 * WHY IT IS NOT IN checks.ts
 *   `checks.ts` is a literal port of `validate.py` and every rule there costs two
 *   implementations, kept in step by the oracle gate. This is TypeScript-only,
 *   run alongside, in the same spirit as `query-checks.ts` and `gui-checks.ts`.
 *
 * SEVERITY IS **WARN**, deliberately
 *   A column rendered by a `customTemplate` has no type code and is not wrong —
 *   that is what Athena's own page does. And an enum shown as a number is
 *   readable, just poor. WARN says "a human should look"; FAIL would reject
 *   pages that are merely plainer than they could be.
 */
import type { RelationGraph } from "./generate/relations";

export interface EnumFinding {
  level: "PASS" | "WARN";
  name: string;
  detail: string;
}

interface Col {
  name?: string;
  path?: string;
  customTemplate?: string;
  type?: { type?: number | null } | null;
}
interface Widget { settings?: { name?: string; entityType?: string; columns?: Col[] } | null }
interface PageJson { widgets?: Widget[] }

/** CMF's UI code for "a reference", which is what an enum column must be. */
const REFERENCE_CODE = 11;

/**
 * The entity a grid lists.
 *
 * Read from the widget where it is stated; otherwise inferred from the widget
 * name, which by convention is the entity. Returning null simply means this
 * grid is not checked, which is the safe direction.
 */
function entityOf(w: Widget, known: ReadonlySet<string>): string | null {
  const s = w.settings ?? {};
  if (s.entityType && known.has(s.entityType)) return s.entityType;
  const n = (s.name ?? "").trim();
  if (known.has(n)) return n;
  // "ProductionOrder Materials" -> the leading word, when that is an entity
  const first = n.split(/[\s_]/)[0] ?? "";
  return known.has(first) ? first : null;
}

/**
 * Flag columns bound to an enum property but typed as a scalar.
 *
 * Only the LAST segment of a path is considered, and only when the grid's entity
 * is known: `SystemState` on a Material grid is checkable, `Foo.SystemState`
 * reached through a join is not, because the owning entity of the far end is not
 * established here and a wrong claim is worse than no claim.
 */
export function checkEnumColumns(page: PageJson, graph: RelationGraph | null): EnumFinding[] {
  if (!graph) return [];
  const known = new Set(Object.keys(graph.entities));
  const out: EnumFinding[] = [];
  const flagged: string[] = [];
  let checked = 0;

  for (const w of page.widgets ?? []) {
    const entity = entityOf(w, known);
    if (!entity) continue;
    const enums = new Set(graph.entities[entity]?.enums ?? []);
    if (enums.size === 0) continue;

    for (const c of w.settings?.columns ?? []) {
      const path = String(c.path ?? "");
      if (!path || path.includes(".")) continue;      // see the doc comment
      if (!enums.has(path)) continue;
      checked += 1;
      // A template renders the column itself and carries no type code. That is
      // what Athena's own page does for SystemState, and it is not an error.
      if (c.customTemplate) continue;
      const code = c.type?.type;
      if (code === REFERENCE_CODE || code === null || code === undefined) continue;
      flagged.push(`${entity}.${path} typed ${code}`);
    }
  }

  if (flagged.length) {
    out.push({
      level: "WARN",
      name: "enum columns typed as scalars",
      detail: `${flagged.length} column(s) bind to a CMF enum but are typed as a plain value: ` +
        `${flagged.join("; ")}. CMF marks these ReferenceType 6, so they render as ` +
        `${REFERENCE_CODE}/6 with the state's icon and text; a scalar code shows the operator ` +
        `a bare number.`,
    });
  } else if (checked > 0) {
    out.push({
      level: "PASS",
      name: "enum columns rendered as references",
      detail: `${checked} enum-bound column(s), none typed as a bare scalar`,
    });
  }
  return out;
}
