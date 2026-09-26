/**
 * THE PAGE AND ITS QUERIES MUST AGREE ON PARAMETER NAMES.
 *
 * A `QueryDataSource` exposes one input PORT per query parameter, named exactly
 * as the parameter is named. The page's `links` bind to those port names. If the
 * two disagree the import SUCCEEDS and the binding silently does nothing — the
 * filter renders, the operator types into it, and the grid never responds.
 *
 * WHY THIS FILE EXISTS
 *   Measured 2026-09-02 on the PO Management unit that was about to be sent to
 *   the client. Its page bound `ProductionOrder_Name`, `ProductionOrder_Product_Name`
 *   and `Material_ProductionOrder_Name` — matching the delivered page exactly —
 *   while its queries declared `ProductionOrder_ProductionOrder_Name` and the
 *   other two doubled forms. All three filters would have shipped dead.
 *
 *   The run reported `23 passed · 2 warnings`. Nothing was wrong with either
 *   artifact ALONE: `query-checks.ts` verifies a query against ITSELF (its
 *   filters reference its own declared parameters, which they did), and
 *   `checks.ts` verifies a page against itself. The defect lived in the space
 *   between two individually-valid files, which is precisely the space no
 *   single-artifact validator can see.
 *
 * THIS IS A TRIPWIRE, NOT THE FIX. The cause was `parameterName()` not applying
 * the root-entity normalisation the resolver has always applied, and that is
 * fixed at source in `generate/query.ts`. This check exists so the class of
 * fault cannot return silently.
 */
import type { Result } from "./types";

/**
 * Inputs that are NOT query parameters and must never be reported as unbound.
 *
 * A link's `input` names whatever port it targets, and a QueryDataSource exposes
 * control ports as well as one per parameter. Measured against the delivered
 * corpus: Athena's own PO page binds `refresh`, and their Load Materials page
 * binds `filterCollection` — neither is a declared parameter on either side, so
 * a check that flagged them would fail the authority's own files (F-118).
 */
const CONTROL_PORTS = new Set([
  "refresh", "filterCollection", "LoadEntities", "LoadEntity", "data", "Data",
]);

export interface WiringInput {
  /** every link the page declares, as (target data-source id, input port) */
  links: ReadonlyArray<{ targetId: string | null; input: string | null }>;
  /**
   * The ids of the page's QUERY data sources — and ONLY those.
   *
   * A page's `dataSources` also holds `ServiceCallDataSource` entries, whose
   * input ports are the service contract's arguments and have nothing to do
   * with query parameters. Passing every data source here made this check FAIL
   * a correct Load Materials to Feeder unit on `Materials` and `Resource`, the
   * two arguments of `AttachConsumablesToResource` — measured 2026-09-02, on
   * the first unit this check ever ran against.
   */
  queryDataSourceIds: ReadonlySet<string>;
  /** every parameter name declared by any query in the unit */
  declaredParameters: ReadonlySet<string>;
}

/**
 * One FAIL per parameter the page binds that no query declares.
 *
 * Reported per-name rather than as one aggregate finding: each is a separately
 * dead control, and an engineer reading the report needs to know WHICH filter
 * will not work.
 *
 * The converse — a query declaring a parameter the page never binds — is NOT a
 * fault here. A Filter widget supplies its criteria as a `filterCollection`
 * rather than through named ports, so a page can legitimately leave every named
 * parameter unbound. `query-checks.ts` already reports unused parameters.
 */
export function checkWiring(input: WiringInput): Result[] {
  const bound = new Set<string>();
  for (const l of input.links) {
    if (!l.input || !l.targetId) continue;
    if (!input.queryDataSourceIds.has(l.targetId)) continue;
    if (CONTROL_PORTS.has(l.input)) continue;
    bound.add(l.input);
  }

  if (bound.size === 0) {
    /* Nothing to check is not the same as everything agreeing, and saying so
       keeps a page that binds nothing from reading as a clean pass. */
    return [{
      level: "PASS",
      name: "page/query parameter wiring (no named bindings)",
      detail: "the page binds no query parameter by name",
    }];
  }

  const unbound = [...bound].filter((p) => !input.declaredParameters.has(p)).sort();
  if (unbound.length === 0) {
    return [{
      level: "PASS",
      name: `page/query parameter wiring ${bound.size}/${bound.size}`,
      detail: "",
    }];
  }

  return unbound.map((p) => ({
    level: "FAIL" as const,
    name: "page binds a query parameter that no query declares",
    detail: `link input "${p}" — declared: ${[...input.declaredParameters].sort().join(", ") || "(none)"}`,
  }));
}

/* ═══════════════════ the other direction, where it bites ═══════════════════
 *
 * The check above runs page -> query and says, correctly, that the converse is
 * not a fault: a Filter widget supplies criteria as `filterCollection`, so a
 * page can legitimately leave named parameters unbound.
 *
 * That is true of an OPTIONAL filter and false of a mandatory one, and the
 * difference is the whole of the defect Athena reported as "on initial page
 * load, the Production Orders are not displayed in the grid."
 *
 * A CMF query filter with `IsOptional=False` is always applied. Leave its
 * parameter unbound and the comparison runs against NULL — `Product.Name = NULL`
 * matches no row ever — so the query executes, succeeds, and returns nothing.
 * The page imports, the grid renders, and it is empty. Nothing in either
 * artifact alone is wrong, which is why 25 validator checks passed on it.
 *
 * Scoped deliberately:
 *   - MANDATORY filters only. An optional one drops itself when unbound, which
 *     is the mechanism the comment above is describing, and flagging it would
 *     fail the client's own pages.
 *   - Queries that FILL A WIDGET only. A source nothing reads may sit unbound
 *     for a reason that is not visible here.
 */

export interface MandatoryBindingInput {
  /** every link, as (target data-source id, input port) */
  links: ReadonlyArray<{ targetId: string | null; input: string | null }>;
  /**
   * One entry per query data source that FILLS a widget: the source's id, a
   * readable name, the query's name, and the parameter names its mandatory
   * filters depend on.
   */
  sources: ReadonlyArray<{
    id: string;
    name: string;
    query: string;
    mandatoryParameters: readonly string[];
    /**
     * Of those, the ones fed ONLY by a control that is empty when the page
     * opens — a Form or Filter field nobody has typed into yet.
     *
     * This distinction is the whole check. The first version asked only "is it
     * bound", passed a page whose filter box fed the parameter, and that page
     * still opened with an empty grid: a link is not a value. A port fed from a
     * grid's `selectedChange` is deliberately not counted here, because a
     * detail grid is SUPPOSED to be empty until a row is selected.
     */
    emptyOnLoad?: readonly string[];
  }>;
}

/**
 * One FAIL per mandatory query parameter no link supplies.
 *
 * Reported per parameter, per source, for the same reason the check above is:
 * an engineer needs to know WHICH grid will be empty and WHAT to bind to fix it.
 */
export function checkMandatoryBindings(input: MandatoryBindingInput): Result[] {
  if (input.sources.length === 0) return [];

  const boundOn = new Map<string, Set<string>>();
  for (const l of input.links) {
    if (!l.input || !l.targetId) continue;
    if (!boundOn.has(l.targetId)) boundOn.set(l.targetId, new Set());
    boundOn.get(l.targetId)!.add(l.input);
  }

  const out: Result[] = [];
  let checked = 0;
  for (const s of input.sources) {
    const bound = boundOn.get(s.id) ?? new Set<string>();
    const empty = new Set(s.emptyOnLoad ?? []);
    for (const p of s.mandatoryParameters) {
      checked += 1;
      const isBound = bound.has(p);
      const isEmptyOnLoad = empty.has(p);
      if (isBound && !isEmptyOnLoad) continue;
      out.push({
        level: "FAIL",
        name: "a mandatory query parameter has no value on load, so the grid opens empty",
        detail: `"${s.name}" runs ${s.query}, whose filter on "${p}" is mandatory ` +
          `(IsOptional=False), and ` +
          (isBound
            ? `the only thing feeding it is a filter field — empty until somebody types. ` +
              `On load the comparison runs against an empty value and matches nothing.`
            : `no link supplies it at all. The comparison runs against NULL and matches ` +
              `nothing.`) +
          ` The query succeeds and returns no rows. Make that filter optional, so CMF ` +
          `drops it when there is no value.`,
      });
    }
  }

  if (out.length === 0) {
    return [{
      level: "PASS",
      name: `mandatory query parameters bound ${checked}/${checked}`,
      detail: checked === 0 ? "no grid-filling query has a mandatory parameter" : "",
    }];
  }
  return out;
}

/* ════════════ a column can only show what its query selected ════════════
 *
 * The second thing Athena reported: "some columns values in the material grid
 * are not populated/fetched." Six of the nine Materials columns were blank.
 *
 * Every one of the six was a real `Material` property, spelled correctly, bound
 * to a column the document asked for. The query feeding the grid simply did not
 * SELECT them, so the row object arrived without those keys and each column
 * rendered whatever its template makes of `undefined` — usually nothing.
 *
 * This is invisible to every check that looks at one artifact. The page is
 * correct. The query is correct. The pairing is not, and only the pairing can
 * be asked.
 *
 * WHY IT IS A FAIL AND NOT A WARNING
 *   The failure mode is a blank cell, which reads to a reviewer as "no data for
 *   this lot" rather than "wrong artifact". It survived our validator, our GUI
 *   check and three test runs, and was found by the client.
 */

export interface ColumnCoverageInput {
  /** one entry per grid whose rows come from a query */
  grids: ReadonlyArray<{
    /** the widget's name, as an engineer would recognise it */
    widget: string;
    query: string;
    /** `settings.columns[].path` — what each column reads from the row */
    columnPaths: readonly string[];
    /** the field aliases the query selects */
    selected: readonly string[];
    /**
     * Column roots already reported as needing a join nobody can evidence.
     *
     * These are a WARN rather than a FAIL — not because they matter less, but
     * because the run has already said so in words and named what would settle
     * it. A FAIL that repeats an answered question trains people to skim.
     */
    unevidenced?: readonly string[];
  }>;
}

/**
 * The root of a column path: `Step.Id` reads the `Step` the query selected, and
 * CMF materialises a reference field as the whole object. So coverage is decided
 * on the first segment, not the full path — otherwise every reference column in
 * every delivered page would report as uncovered.
 */
const rootOf = (path: string): string => (path.split(".")[0] ?? path);

export function checkColumnCoverage(input: ColumnCoverageInput): Result[] {
  if (input.grids.length === 0) return [];
  const out: Result[] = [];
  let covered = 0, total = 0;

  for (const g of input.grids) {
    const have = new Set(g.selected.map(rootOf));
    const known = new Set(g.unevidenced ?? []);
    const roots = new Set(g.columnPaths.map(rootOf));
    const missing = [...roots].filter((p) => !have.has(p)).sort();
    total += roots.size;
    covered += roots.size - missing.length;

    const unexplained = missing.filter((m) => !known.has(m));
    const explained = missing.filter((m) => known.has(m));

    if (unexplained.length) {
      out.push({
        level: "FAIL",
        name: "a grid binds columns its query does not select, so they render blank",
        detail: `"${g.widget}" reads ${g.query}, which selects ` +
          `${g.selected.length} field(s) and not ${unexplained.map((m) => `"${m}"`).join(", ")}. ` +
          `The rows arrive without those keys and the cells are empty — no error is ` +
          `raised anywhere. Add the field(s) to the query, or drop the column(s).`,
      });
    }
    if (explained.length) {
      out.push({
        level: "WARN",
        name: "a column needs a join that could not be evidenced",
        detail: `"${g.widget}" binds ${explained.map((m) => `"${m}"`).join(", ")}, which ` +
          `${g.query} does not select because reaching it means a join no available ` +
          `artifact states. Those cells will be blank until the join is confirmed. ` +
          `Named here rather than guessed.`,
      });
    }
  }

  if (out.length === 0) {
    return [{ level: "PASS", name: `grid columns covered by their query ${covered}/${total}`, detail: "" }];
  }
  return out;
}

/* ═════════ a reference column needs the joined NAME, not just the id ═════════
 *
 * A grid column bound to `Step.Id` or `Product.Id` reads an entity reached
 * through a join. CMF renders it as a navigable name only when the query
 * selects the materialised pair — `__cmf_html_Step_Id` and
 * `__cmf_html_Step_Name`. That prefix is exactly why Athena's Step column reads
 * "SCCO2 Cleaning" and not a row id, visible in the screenshot they sent.
 *
 * MEASURED over their 17 delivered query exports:
 *
 *   fields on the ROOT entity      90 plain,  0 prefixed
 *   fields reached through a JOIN   4 plain, 32 prefixed
 *
 * The four plain ones are not counter-examples: each is an EXTRA alias
 * (`ProductName`) sitting beside the prefixed trio in the same query. So the
 * reading is unambiguous — a joined field that backs a reference column is
 * materialised, and a root field never is.
 *
 * WHY THIS IS A CHECK AND NOT A CHANGE TO THE QUERY BUILDER
 *   The builder emits plain aliases. Teaching it the prefix means deciding WHEN
 *   to apply it, and the corpus shows two shapes rather than one. A check names
 *   the shortfall precisely and leaves the choice with a human; inventing the
 *   rule from 17 files would be the derivation this project keeps refusing.
 */

export interface ReferenceColumnInput {
  grids: ReadonlyArray<{
    widget: string;
    query: string;
    /** `settings.columns[].path` — only the dotted ones matter here */
    columnPaths: readonly string[];
    /** every `<Alias value="…">` the written query file carries */
    aliases: readonly string[];
  }>;
}

export function checkReferenceColumns(input: ReferenceColumnInput): Result[] {
  const out: Result[] = [];
  let checked = 0;

  for (const g of input.grids) {
    const has = new Set(g.aliases);
    /* One entry per referenced entity, not per column: `Step.Id` and `Step.Name`
       are one relationship and would otherwise report twice. */
    const referenced = new Set(
      g.columnPaths.filter((p) => p.includes(".")).map((p) => p.split(".")[0]!),
    );
    for (const entity of referenced) {
      checked += 1;
      /* Either shape their corpus uses: the materialised pair, or a flattened
         alias like `ProductName`. */
      const materialised = has.has(`__cmf_html_${entity}_Name`);
      const flattened = has.has(`${entity}Name`);
      if (materialised || flattened) continue;

      out.push({
        level: "WARN",
        name: "a reference column may render an id instead of a name",
        detail: `"${g.widget}" binds a column through "${entity}", and ${g.query} ` +
          `selects neither \`__cmf_html_${entity}_Name\` nor \`${entity}Name\`. On their ` +
          `delivered queries a joined field is materialised that way 32 times out of 36, ` +
          `and that prefix is what makes such a column show a name. Without it the cell ` +
          `shows a raw id, or nothing.`,
      });
    }
  }

  if (out.length === 0 && checked) {
    return [{ level: "PASS", name: `reference columns carry a name field ${checked}/${checked}`, detail: "" }];
  }
  return out;
}
