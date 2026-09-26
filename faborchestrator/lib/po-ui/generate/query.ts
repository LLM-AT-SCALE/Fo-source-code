/**
 * QUERY ASSEMBLY — a query definition to a CMF-importable Query export.
 *
 * DELIBERATELY SEPARATE FROM assemble.ts, and this is not an oversight.
 *
 * A UI Page carries its whole definition as ONE XML-escaped JSON blob inside
 * `<Settings value="…">`, so `assemble.ts` escapes a JSON string and substitutes it
 * into a skeleton, and `$id` numbering applies across the JSON graph.
 *
 * A Query is **structured XML, element by element**. There is no `<Settings>`, no
 * JSON, no escaping step and no `$id`. Reusing the page assembler here would have
 * meant bending it into something that does neither job well.
 *
 * Everything below reproduces element shapes read verbatim out of the three query
 * exports Athena delivered — see _working/skeleton/QUERY-BODY-MODEL.md, which
 * models the format, and the tests, which check this code against those exports.
 *
 * The same division of labour as the page generator: the MODEL decides which
 * entity, fields, joins and filters a query needs; THIS CODE decides aliases,
 * parameter names, element order and the type strings.
 */
import { escapeAttribute } from "./assemble";
import type { QueryDefinitionType, QueryFilterType } from "../descriptor";
import { deriveJoin, type RelationGraph } from "./relations";

/* ------------------------------------------------------------------ type strings */

/** CMF stamps every element with its CLR type. These are copied from real exports. */
const T = {
  str: "System.String, System.Private.CoreLib, Version=6.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e",
  bool: "System.Boolean, System.Private.CoreLib, Version=6.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e",
  int32: "System.Int32, System.Private.CoreLib, Version=6.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e",
  relationColl: "Cmf.Foundation.BusinessObjects.QueryObject.RelationCollection, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  relation: "Cmf.Foundation.BusinessObjects.QueryObject.Relation, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  objectType: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.QueryObjectType, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  fieldColl: "Cmf.Foundation.BusinessObjects.QueryObject.FieldCollection, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  field: "Cmf.Foundation.BusinessObjects.QueryObject.Field, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  joinType: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.JoinType, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  topUnit: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.TopUnit, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  paramColl: "Cmf.Foundation.BusinessObjects.QueryObject.QueryParameterCollection, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  param: "Cmf.Foundation.BusinessObjects.QueryObject.QueryParameter, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  direction: "System.Data.ParameterDirection, System.Data.Common, Version=6.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
  filterType: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.FilterType, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  fieldSort: "Cmf.Foundation.Common.FieldSort, Cmf.Foundation.Common, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  aggregate: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.FieldAggregateFunction, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  filterColl: "Cmf.Foundation.BusinessObjects.QueryObject.FilterCollection, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  filter: "Cmf.Foundation.BusinessObjects.QueryObject.Filter, Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  logicalOperator: "Cmf.Foundation.Common.LogicalOperator, Cmf.Foundation.Common, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  fieldOperator: "Cmf.Foundation.Common.FieldOperator, Cmf.Foundation.Common, Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
} as const;

export class QueryAssembleError extends Error {}

/* ------------------------------------------------------------------ primitives */

const el = (name: string, value: string, type: string): string =>
  `<${name} value="${escapeAttribute(value)}" type="${type}" />`;

const nul = (name: string): string => `<${name} isNull="True" />`;

const coll = (name: string, actualtype: string, items: readonly string[]): string =>
  items.length === 0
    ? `<${name} type="Collection" actualtype="${actualtype}" />`
    : `<${name} type="Collection" actualtype="${actualtype}">${items.join("")}</${name}>`;

/* ------------------------------------------------------------------ aliasing */

/**
 * The alias scheme, read off the delivered exports:
 *
 *   root entity            ProductionOrder        -> ProductionOrder_1
 *   one hop through Product                       -> ProductionOrder_Product_2
 *
 * i.e. the path from the root, joined by "_", then a document-order counter.
 * The counter is 1-based and shared across the whole query.
 */
export function aliasOf(rootEntity: string, hops: readonly string[], ordinal: number): string {
  return [rootEntity, ...hops, String(ordinal)].join("_");
}

/**
 * Parameter names are the alias path WITHOUT the counter, plus the property:
 *   Name          on the root      -> ProductionOrder_Name
 *   Product.Name  one hop          -> ProductionOrder_Product_Name
 *
 * These are not cosmetic. A QueryDataSource exposes an input PORT per parameter,
 * named exactly this, and the UI page's links bind to those port names — so the
 * query's parameter names determine the page's wiring. Change one and the other
 * silently stops receiving data.
 */
export function parameterName(rootEntity: string, path: string): string {
  const parts = path.split(".");
  /*
   * A PATH MAY ALREADY LEAD WITH THE ROOT ENTITY, and the resolver has always
   * known that - `strip()` in `resolvePaths` drops a leading hop equal to
   * `def.entity` before resolving. This function did not, so a definition
   * written as "ProductionOrder.Name" rather than "Name" produced the parameter
   * `ProductionOrder_ProductionOrder_Name` while `EntityTypePropertyId`, coming
   * from the resolver, correctly read `ProductionOrder.Name`.
   *
   * That is not cosmetic, for the reason stated above: the page's links bind to
   * the parameter NAME. MEASURED 2026-09-02 on the PO Management unit about to
   * go to the client - the page bound `ProductionOrder_Name` (matching the
   * delivered page exactly) while its query declared the doubled form, so all
   * three filters would have imported and silently never bound. The query was
   * internally consistent, which is why nothing caught it.
   *
   * Normalised HERE rather than at the caller because the resolver already
   * normalises and the two must agree by construction; leaving it to callers is
   * what let them disagree in the first place.
   */
  if (parts.length > 1 && parts[0] === rootEntity) parts.shift();
  return [rootEntity, ...parts].join("_");
}

/** "Product.Name" -> { hops: ["Product"], property: "Name" } */
function splitPath(path: string): { hops: string[]; property: string } {
  const parts = path.split(".");
  const property = parts.pop();
  if (!property) throw new QueryAssembleError(`empty path in query definition`);
  return { hops: parts, property };
}

/* ------------------------------------------------------------------ the body */

interface Resolved {
  /** entity that owns the property, e.g. Product */
  objectName: string;
  /** its alias, e.g. ProductionOrder_Product_2 */
  objectAlias: string;
  property: string;
}

/**
 * Work out, for every path the definition uses, which entity owns it and under
 * which alias. A dotted path needs a declared join: we cannot invent the foreign
 * key columns (`ProductId` -> `DefinitionId` on the reference page) and a guess
 * would produce a query that runs and returns the wrong rows.
 */
function resolvePaths(def: QueryDefinitionType, graph: RelationGraph | null = null): {
  resolve: (path: string) => Resolved;
  relations: string[];
  /** joins the SCHEMA supplied, so a run can report what it did not have to guess */
  derived: string[];
} {
  const derived: string[] = [];
  const aliases = new Map<string, { entity: string; alias: string }>();
  let ordinal = 1;
  const root = { entity: def.entity, alias: aliasOf(def.entity, [], ordinal++) };
  aliases.set("", root);
  /*
   * A path may name the ROOT ENTITY as its first hop, and that is not a join.
   *
   * The delivered queries never do this: `CustomRetrieveProductionOrders` filters
   * on `Name` and `Product.Name`, not `ProductionOrder.Name`. But descriptors
   * produced by the model routinely write the root in — `ProductionOrder.Name`
   * on a query whose entity IS ProductionOrder — and that was read as "cross into
   * ProductionOrder", which needs a join, which does not exist, so the whole
   * query was refused. Measured: 0 of 3 buildable on a real chat descriptor.
   *
   * Registering the root under its own name costs nothing and cannot be
   * ambiguous: a self-join would need a reference property named after its own
   * entity, and the alias map is keyed by PATH, so a real `X.X` hop still
   * resolves through the join branch below.
   */
  /*
   * Normalise a leading ROOT-ENTITY hop away, rather than aliasing the root
   * under a second key.
   *
   * Aliasing worked but double-counted: a descriptor that writes BOTH
   * `ProductionOrder.Product.Name` and `Product.Id` produced two alias entries
   * for one join, and therefore two <Relation> items in the query. Normalising
   * makes both spellings the same key, so the join is built once.
   */
  const strip = (hops: string[]): string[] =>
    hops.length && hops[0] === def.entity ? hops.slice(1) : hops;

  const joins = def.joins ?? [];
  const relations: string[] = [];

  for (const j of joins) {
    const hops = strip(j.path.split("."));
    const parentKey = hops.slice(0, -1).join(".");
    const parent = aliases.get(parentKey);
    if (!parent) {
      throw new QueryAssembleError(
        `join "${j.path}" has no parent join — declare "${parentKey}" first`,
      );
    }
    const alias = aliasOf(def.entity, hops, ordinal++);
    aliases.set(hops.join("."), { entity: j.entity, alias });

    relations.push(
      `<Item type="${T.relation}">` +
        el("Name", "", T.str) +
        el("Alias", "", T.str) +
        el("IsRelation", "False", T.bool) +
        el("SourceEntity", parent.entity, T.str) +
        el("SourceEntityAlias", parent.alias, T.str) +
        el("SourceObjectType", "EntityType", T.objectType) +
        el("TargetEntity", j.entity, T.str) +
        el("TargetEntityAlias", alias, T.str) +
        el("TargetObjectType", "EntityType", T.objectType) +
        el("SourceProperty", j.sourceProperty, T.str) +
        el("TargetProperty", j.targetProperty, T.str) +
        nul("Filter") +
        coll("Fields", T.fieldColl, []) +
        el("SourceJoinType", j.joinType ?? "InnerJoin", T.joinType) +
        el("TargetJoinType", j.joinType ?? "InnerJoin", T.joinType) +
      `</Item>`,
    );
  }

  /**
   * Build the join for one undeclared hop, IF the schema states it.
   *
   * This is the F-158 rule: a reference property's `ReferenceType` says which key
   * the foreign key targets (1 -> `Id`, 7 -> `DefinitionId`). Verified against
   * every join Athena delivered, 5 of 5, including the two F-125 called
   * unpredictable. `deriveJoin` returns null unless the schema is unambiguous,
   * and a null keeps the refusal below — declining less often is the goal,
   * guessing is not.
   */
  const derive = (parentKey: string, hop: string): { entity: string; alias: string } | null => {
    const parent = aliases.get(parentKey);
    if (!parent) return null;
    const j = deriveJoin(graph, parent.entity, hop);
    if (!j) return null;

    const key = parentKey ? `${parentKey}.${hop}` : hop;
    const alias = aliasOf(def.entity, key.split("."), ordinal++);
    aliases.set(key, { entity: j.entity, alias });
    derived.push(`${key}: ${j.sourceProperty} -> ${j.entity}.${j.targetProperty}  (${j.because})`);

    relations.push(
      `<Item type="${T.relation}">` +
        el("Name", "", T.str) + el("Alias", "", T.str) + el("IsRelation", "False", T.bool) +
        el("SourceEntity", parent.entity, T.str) +
        el("SourceEntityAlias", parent.alias, T.str) +
        el("SourceObjectType", "EntityType", T.objectType) +
        el("TargetEntity", j.entity, T.str) +
        el("TargetEntityAlias", alias, T.str) +
        el("TargetObjectType", "EntityType", T.objectType) +
        el("SourceProperty", j.sourceProperty, T.str) +
        el("TargetProperty", j.targetProperty, T.str) +
        nul("Filter") + coll("Fields", T.fieldColl, []) +
        el("SourceJoinType", "InnerJoin", T.joinType) +
        el("TargetJoinType", "InnerJoin", T.joinType) +
      `</Item>`,
    );
    return { entity: j.entity, alias };
  };

  const resolve = (path: string): Resolved => {
    const { hops: raw, property } = splitPath(path);
    const hops = strip(raw);
    const key = hops.join(".");
    let found = aliases.get(key);

    // Walk the hops, deriving any the definition did not declare. Left to right,
    // so a second hop can build on a first that was itself derived.
    if (!found && hops.length) {
      let parentKey = "";
      for (const hop of hops) {
        const thisKey = parentKey ? `${parentKey}.${hop}` : hop;
        if (!aliases.has(thisKey) && !derive(parentKey, hop)) break;
        parentKey = thisKey;
      }
      found = aliases.get(key);
    }

    if (!found) {
      throw new QueryAssembleError(
        `path "${path}" crosses into "${key}" but no join declares it, ` +
        `and the schema does not state one. ` +
        `Add a join { path: "${key}", entity: "…", sourceProperty: "…", targetProperty: "…" } ` +
        `— the foreign-key columns cannot be guessed.`,
      );
    }
    return { objectName: found.entity, objectAlias: found.alias, property };
  };

  return { resolve, relations, derived };
}

/** Filters that draw their value from a parameter, in declaration order. */
const parameterised = (filters: readonly QueryFilterType[]): QueryFilterType[] =>
  filters.filter((f) => f.parameter === true);

export function buildQueryBody(
  def: QueryDefinitionType, graph: RelationGraph | null = null,
  /**
   * `entity -> property -> type`, from ENTITY-TYPES.md.
   *
   * Used for exactly one decision: whether a materialised reference field also
   * carries `Revision`. Optional so a caller without the schema still builds a
   * query — it simply omits Revision, which is what two of their three
   * materialised entities do anyway.
   */
  schema?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string {
  const { resolve, relations } = resolvePaths(def, graph);

  const params = parameterised(def.filters).map((f) => {
    const r = resolve(f.path);
    return (
      `<Item type="${T.param}">` +
        el("Name", parameterName(def.entity, f.path), T.str) +
        nul("Value") +
        el("Direction", "Input", T.direction) +
        nul("Type") +
        el("EntityTypePropertyId", `${r.objectName}.${r.property}`, T.str) +
        el("EntityTypeId", "", T.str) +
        el("FilterType", "Normal", T.filterType) +
        el("IsOptional", f.optional ? "True" : "False", T.bool) +
      `</Item>`
    );
  });

  /*
   * FIELD ALIASES, AND THE MATERIALISED REFERENCE PAIR  (T-49)
   *
   * Two things were wrong here and both are silent.
   *
   * 1. Every field was aliased by its bare property name, so a joined `Product.Id`
   *    came out as `Id` — colliding with the root's own `Id`. Their own exports
   *    never do this: a plain joined field is aliased `<Hop><Property>`,
   *    `ProductName` on 4 of 4 occurrences.
   *
   * 2. A column bound to `Step.Id` renders a NAME only when the query selects the
   *    materialised pair `__cmf_html_Step_Id` / `__cmf_html_Step_Name`. That
   *    prefix is why Athena's Step column reads "SCCO2 Cleaning" rather than a
   *    row id, and our builder never emitted it. Harmless while a query is
   *    transcribed; the first newly-BUILT query with a reference column would
   *    have shown a raw id — the same class of defect the client already
   *    reported once (F-204).
   *
   * MEASURED over their 17 delivered query exports:
   *
   *   fields on the ROOT entity        90 plain,  0 prefixed
   *   fields reached through a JOIN     4 plain, 32 prefixed
   *   Product     -> Id, Name, Revision   6 of 6
   *   ProductionOrder -> Id, Name         2 of 2
   *   Step        -> Id, Name             1 of 1
   *
   * Revision is not a Product special case: `Product` HAS a `Revision` property
   * in the CMF schema and the other two do not. So the set is Id + Name, plus
   * Revision when the entity has one — a schema question, not a list of names.
   *
   * POSITIONS follow their files: the `_Id` takes the display slot the column
   * occupies, and `_Name`/`_Revision` are appended after every declared field.
   *
   * SCOPE: single-hop reference paths only. A two-hop path gives no evidence
   * about which segment the renderer looks up, and inventing that is the kind of
   * derivation this file refuses elsewhere.
   */
  const rootAlias = aliasOf(def.entity, [], 1);
  const trailing: string[] = [];
  let nextPosition = def.fields.length;

  const fieldItem = (
    name: string, alias: string, position: number, objectAlias: string, objectName: string,
  ): string =>
    `<Item type="${T.field}">` +
      el("Name", name, T.str) +
      el("Alias", alias, T.str) +
      el("Position", String(position), T.int32) +
      el("Sort", "NoSort", T.fieldSort) +
      el("IsUserAttribute", "False", T.bool) +
      nul("DisplayFormatName") +
      nul("DisplayStyleName") +
      nul("DisplayConditionalStyleName") +
      el("AggregateFunction", "NoFunction", T.aggregate) +
      el("ObjectType", "EntityType", T.objectType) +
      el("ObjectAlias", objectAlias, T.str) +
      el("ObjectName", objectName, T.str) +
    `</Item>`;

  const fields = def.fields.map((path, i) => {
    const r = resolve(path);
    const { hops } = splitPath(path);
    const joined = r.objectAlias !== rootAlias;

    /* A single-hop `.Id` is a reference column — materialise it. */
    if (joined && hops.length === 1 && r.property === "Id") {
      const hop = hops[0]!;
      for (const extra of ["Name", "Revision"]) {
        /* Revision only where the entity really has one. Absent schema, omit:
           two of their three materialised entities have no Revision, so the
           conservative branch is also the common one. */
        if (extra === "Revision" && !(schema?.get(r.objectName)?.has("Revision"))) continue;
        trailing.push(fieldItem(
          extra, `__cmf_html_${hop}_${extra}`, nextPosition++, r.objectAlias, r.objectName));
      }
      return fieldItem("Id", `__cmf_html_${hop}_Id`, i, r.objectAlias, r.objectName);
    }

    /* Any other joined field takes the flattened alias, so it cannot collide
       with a root property of the same name. */
    const alias = joined && hops.length ? `${hops[hops.length - 1]}${r.property}` : r.property;
    return fieldItem(r.property, alias, i, r.objectAlias, r.objectName);
  }).concat(trailing);

  const filters = def.filters.map((f, i) => {
    const r = resolve(f.path);
    const value = f.parameter ? `@${parameterName(def.entity, f.path)}` : (f.value ?? "");
    /*
     * `LogicalOperator` joins a filter to the NEXT one, so the last filter has
     * nothing to join to and CMF writes the literal "Nothing".
     *
     * MEASURED across every delivered query export: the last filter is "Nothing"
     * in 11 of 11, and every other filter is "AND" in 17 of 17 — no exceptions.
     * We emitted "AND" on the last filter until 2026-08-20, so every query this
     * pipeline has ever produced differed from CMF's own convention there. Found
     * by round-tripping their exports (T-21), not by reading the code.
     */
    const isLast = i === def.filters.length - 1;
    const logical = isLast ? "Nothing" : (f.logicalOperator ?? "AND");
    return (
      `<Item type="${T.filter}">` +
        el("EntityTypeId", "", T.str) +
        el("EntityTypePropertyId", r.property, T.str) +
        el("FilterType", "Normal", T.filterType) +
        el("IsOptional", f.optional ? "True" : "False", T.bool) +
        el("LogicalOperator", logical, T.logicalOperator) +
        el("Name", r.property, T.str) +
        el("Operator", f.operator, T.fieldOperator) +
        el("Value", value, T.str) +
        nul("InnerFilters") +
        el("ObjectType", "EntityType", T.objectType) +
        el("ObjectAlias", r.objectAlias, T.str) +
        el("ObjectName", r.objectName, T.str) +
      `</Item>`
    );
  });

  // Element order matters for a faithful reproduction — this is the order the
  // delivered exports use, verified against all three.
  return (
    nul("Entities") +
    coll("Relations", T.relationColl, relations) +
    nul("Top") +
    el("Distinct", def.distinct ? "True" : "False", T.bool) +
    el("TopUnit", "Records", T.topUnit) +
    el("HasParameters", params.length ? "True" : "False", T.bool) +
    coll("QueryParameters", T.paramColl, params) +
    coll("Fields", T.fieldColl, fields) +
    nul("FieldsDisplayStyles") +
    nul("FieldsDisplayFormats") +
    coll("Filters", T.filterColl, filters)
  );
}

/* ------------------------------------------------------------------ assembly */

export const QUERY_PLACEHOLDERS = {
  name: "{{QUERY_NAME}}",
  entity: "{{ENTITY_TYPE}}",
  objectId: "{{OBJECT_ID}}",
  body: "{{QUERY_BODY}}",
} as const;

export interface AssembleQueryInput {
  /** skeleton-query.xml, placeholders intact */
  skeleton: string;
  def: QueryDefinitionType;
  objectId: string;
  /** the schema join graph; absent means "declare every join or be refused" */
  relations?: RelationGraph | null;
  /**
   * `entity -> property -> type`. Passed through to the field builder for one
   * decision only: whether a materialised reference field also carries
   * `Revision`. Optional — without it the pair is emitted, which is what two of
   * their three materialised entities carry anyway.
   */
  schema?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export function assembleQuery(input: AssembleQueryInput): { xml: string; body: string } {
  const body = buildQueryBody(input.def, input.relations ?? null, input.schema);

  let xml = input.skeleton;
  for (const token of Object.values(QUERY_PLACEHOLDERS)) {
    if (!xml.includes(token)) {
      throw new QueryAssembleError(
        `query skeleton has no ${token} placeholder — it may have been edited by hand`,
      );
    }
  }

  xml = xml
    .replace(QUERY_PLACEHOLDERS.name, () => escapeAttribute(input.def.name))
    .replace(QUERY_PLACEHOLDERS.entity, () => escapeAttribute(input.def.entity))
    .replace(QUERY_PLACEHOLDERS.objectId, () => input.objectId)
    .replace(QUERY_PLACEHOLDERS.body, () => body);

  const leftover = xml.match(/\{\{(\w+)\}\}/g);
  if (leftover) {
    throw new QueryAssembleError(
      `assembled query still contains placeholders: ${[...new Set(leftover)].join(", ")}`,
    );
  }
  return { xml, body };
}

/**
 * The input port names a QueryDataSource will expose for this query.
 *
 * Exported because the UI page generator needs them: a link's `input` must be one
 * of these, and getting it wrong produces a page that imports cleanly and never
 * receives data.
 */
export function inputPortsOf(def: QueryDefinitionType): string[] {
  return parameterised(def.filters).map((f) => parameterName(def.entity, f.path));
}

/**
 * Of those ports, the ones a MANDATORY filter depends on.
 *
 * The distinction decides whether an unbound port is harmless or fatal. CMF
 * drops an optional filter whose parameter has no value; a mandatory one is
 * always applied, so it compares against NULL and matches nothing — the query
 * succeeds, returns no rows, and the grid renders empty with no error anywhere.
 *
 * `optional` is absent on most filters and means `IsOptional=False`, which is
 * what CMF writes when nobody ticked the box. Absent is therefore MANDATORY
 * here, matching the serialiser above rather than reading absence as lenient.
 */
export function mandatoryPortsOf(def: QueryDefinitionType): string[] {
  return parameterised(def.filters)
    .filter((f) => f.optional !== true)
    .map((f) => parameterName(def.entity, f.path));
}
