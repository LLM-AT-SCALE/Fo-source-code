/**
 * QUERY COMPLETION — the query must be able to serve the page it feeds  (T-47)
 *
 * WHY THIS EXISTS
 *   Athena imported the page and reported two things that are the same fault
 *   seen from two sides:
 *
 *     "On initial page load, the Production Orders are not displayed."
 *     "Some columns values in the material grid are not populated/fetched."
 *
 *   Their delivered `CustomRetrievePOMaterials` selects five fields. The grid
 *   the requirement asks for binds ten columns. Six of them can never render.
 *   Their delivered `CustomRetrieveProductionOrders` has a mandatory filter on
 *   `Product.Name`, and the page supplies no value for it — so the comparison
 *   runs against NULL, matches nothing, and the grid opens empty.
 *
 *   Neither artifact is wrong on its own, and neither is the page. The pairing
 *   is, and the pairing is what nobody was checking.
 *
 * WHY NOT JUST SHIP THEIRS, OR JUST SHIP OURS
 *   Their file has what cannot be derived: the joins, the operators, the
 *   `UniversalState` filter, the exact parameter names. Ours had what the story
 *   needs: the fields the screen shows. Transcribing theirs and then extending
 *   it keeps the unguessable parts and fixes the insufficient ones.
 *
 * WHAT IT WILL AND WILL NOT DO
 *   ADDS a field when the column reads a property the root entity really has,
 *   confirmed against CMF's own schema. It will not invent a field for a path
 *   that needs a join it cannot evidence — `CurrentNote.Comment` is reported as
 *   a gap and left for a human, because a guessed join returns the wrong rows.
 *
 *   RELAXES a mandatory filter only when its parameter is bound by nothing on
 *   the page. That is not a preference; such a filter can never be satisfied, so
 *   the query it belongs to can never return a row. Making it optional is the
 *   repair of an unusable artifact, not a change of behaviour.
 *
 * EVERY CHANGE IS REPORTED. This edits an artifact the client already ships, so
 * silence here would be the worst possible behaviour.
 */
import type { QueryDefinitionType } from "../descriptor";

export interface QueryChange {
  kind: "field" | "optional";
  detail: string;
}

export interface QueryCompletion {
  changes: QueryChange[];
  /** column paths that need a field we could not evidence — a gap, not a change */
  unresolved: string[];
  /**
   * Fields added as a WHOLE PATH across a join, e.g. `CurrentNote.Comment`.
   *
   * The relation graph resolves these, and can decline. Listed so the caller can
   * assemble with them, and retry without them rather than losing the query, if
   * the join cannot be evidenced.
   */
  risky: string[];
}

export interface CompleteQueryInput {
  def: QueryDefinitionType;
  /** `settings.columns[].path` on the grid this query fills */
  columnPaths: readonly string[];
  /** query parameter names the page actually supplies */
  boundPorts: ReadonlySet<string>;
  /**
   * Ports fed only by a control that is EMPTY when the page opens — a Form or
   * Filter field the user has not typed into yet.
   *
   * The distinction that matters, and the one that cost a second round trip
   * with Athena. "Bound by a link" is not "has a value on load": a mandatory
   * filter wired to a filter box still compares against an empty value when the
   * page opens, so the grid is still empty and the symptom is unchanged.
   *
   * A port fed from a grid's `selectedChange` is deliberately NOT in here. That
   * is master-detail: the Materials grid is supposed to be empty until an order
   * is picked, and relaxing its key would make it list every material in the
   * plant on open.
   */
  emptyOnLoadPorts?: ReadonlySet<string>;
  /** every port this query declares, in the order `inputPortsOf` gives */
  ports: readonly string[];
  /** `entity -> property -> type code`, from ENTITY-TYPES.md */
  schema: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** `Step.Id` reads the `Step` the query selected — coverage is decided on the root. */
const rootOf = (path: string): string => (path.split(".")[0] ?? path);

/**
 * Extend a query so it can serve its grid, and report what that took.
 *
 * Returns a new definition; the input is untouched, matching how the button and
 * data-source completions behave.
 */
export function completeQuery(input: CompleteQueryInput): {
  def: QueryDefinitionType; completion: QueryCompletion;
} {
  const def = JSON.parse(JSON.stringify(input.def)) as QueryDefinitionType;
  const completion: QueryCompletion = { changes: [], unresolved: [], risky: [] };

  /* ---------------------------------------------------------------- fields */

  const selected = new Set(def.fields.map(rootOf));
  const props = input.schema.get(def.entity);

  /* Deduplicated on the ROOT — `Step.Id` and `Step.Name` are one demand — but
     carrying the longest path seen for it, because that is what has to be
     selected for the deepest column to render. */
  const wanted = new Map<string, string>();
  for (const p of input.columnPaths) {
    const r = rootOf(p);
    const cur = wanted.get(r);
    if (cur === undefined || p.length > cur.length) wanted.set(r, p);
  }

  for (const [root, path] of wanted) {
    /*
     * A BARE REFERENCE IS NOT THE SAME AS THE COLUMN THAT READS THROUGH IT.
     *
     * A grid column bound to `Product.Id` needs the joined pair the renderer
     * materialises. A query selecting the bare `Product` satisfies every
     * coverage check — the root matches — and still shows a raw id, because a
     * reference property is a foreign key and not the thing on screen.
     *
     * Their own `CustomLoadMaterialsTofeeder` settles the shape: it selects
     * `Material_Product_2.Id`, `.Name` and `.Revision` and carries **no bare
     * `Material_1.Product` field at all**. So this REPLACES rather than adds.
     *
     * Found 2026-09-09 in a real generated artifact — the first US-1122 page
     * driven through the corrected pipeline had exactly this, and it passed
     * every check because `rootOf("Product.Id")` is `Product`.
     *
     * Risky in the same sense as a deep path: reaching `Product.Id` needs a
     * join, which the relation graph supplies or declines. The caller retries
     * without these rather than losing the query.
     */
    if (selected.has(root) && path.includes(".") && !def.fields.includes(path)) {
      const bare = def.fields.indexOf(root);
      if (bare >= 0) {
        def.fields[bare] = path;
        completion.risky.push(path);
        completion.changes.push({
          kind: "field",
          detail: `${root} -> ${path} — the grid binds a column through \`${root}\`, and a ` +
                  `query selecting the bare reference renders the row id rather than the ` +
                  `name. Your own delivered query for this screen selects the joined ` +
                  `\`${root}\` fields and no bare \`${root}\` at all.`,
        });
        continue;
      }
    }

    if (selected.has(root)) continue;

    /* The column reads `root` off the row. Add it only if the entity really has
       a property of that name — the schema is CMF's own, so this is a check
       against the platform rather than against our own vocabulary. */
    if (props?.has(root)) {
      /*
       * A DEEP PATH IS ADDED WHOLE, not as its root.
       *
       * `CurrentNote.Comment` reads `Comment` off the Note that `CurrentNote`
       * points at. Selecting `CurrentNote` alone gives the reference and the
       * cell still renders nothing — the same blank Athena reported, moved one
       * step along. Selecting the whole path makes the assembler resolve the
       * join from CMF's own relation graph, which is what that graph is for.
       *
       * Marked `risky` because the graph can decline: the caller assembles with
       * these, and drops them and reports a gap if it cannot.
       */
      const deep = path.includes(".");
      def.fields.push(deep ? path : root);
      selected.add(root);
      completion.changes.push({
        kind: "field",
        detail: `+${deep ? path : root} — the grid binds a column to it and the query did ` +
                `not select it, so the cell rendered blank. \`${def.entity}.${root}\` is in ` +
                `the CMF schema${deep ? `, and the join to reach \`${path}\` comes from the ` +
                `relation graph rather than a guess` : ""}.`,
      });
      if (deep) completion.risky.push(path);
      continue;
    }

    /* No evidence at all: not a property of the root entity, so there is nothing
       to join FROM. Reported rather than guessed — a wrong join produces a query
       that runs and returns the wrong rows, which is the worst outcome. */
    completion.unresolved.push(root);
  }

  /* -------------------------------------------------------------- filters */

  const parameterised = def.filters.filter((f) => f.parameter === true);
  parameterised.forEach((f, i) => {
    const port = input.ports[i];
    if (!port || f.optional === true) return;

    const unbound = !input.boundPorts.has(port);
    const emptyOnLoad = input.emptyOnLoadPorts?.has(port) ?? false;
    if (!unbound && !emptyOnLoad) return;

    f.optional = true;
    completion.changes.push({
      kind: "optional",
      detail: `"${port}" made optional — it is mandatory and ` +
        (unbound
          ? `the page binds nothing to it, so the filter compares against NULL and the ` +
            `query can never return a row.`
          : `the only thing feeding it is a filter field, which is empty until somebody ` +
            `types. On page load the filter therefore compares against an empty value ` +
            `and matches nothing, so the grid opens empty — being wired to a control is ` +
            `not the same as having a value.`) +
        ` Optional means CMF drops the filter when no value is supplied.`,
    });
  });

  return { def, completion };
}

/** Lines for the run log, or nothing when the query already served its grid. */
export function formatQueryCompletion(name: string, c: QueryCompletion): string[] {
  const lines: string[] = [];
  for (const ch of c.changes) lines.push(`    ~ ${name}: ${ch.detail}`);
  for (const u of c.unresolved) {
    lines.push(`    ! ${name}: a column reads "${u}" and no field supplies it — ` +
      `it is not a property of ${""}the query's root entity, so it needs a join this ` +
      `cannot evidence. Reported as a gap rather than guessed.`);
  }
  return lines;
}
