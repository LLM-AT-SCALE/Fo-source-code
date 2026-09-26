/**
 * READ A DELIVERED QUERY EXPORT BACK INTO A QueryDefinition  (T-21)
 *
 * The exact inverse of `buildQueryBody()`. Given a query export CMF produced,
 * recover the structure our pipeline needs to regenerate it.
 *
 * WHY THIS EXISTS
 *   A story names its queries; it does not describe them. So `queryDefinitionFor`
 *   returned nothing, `writeQueries` produced nothing, and a run shipped a page
 *   bound to queries that were not in the package — reported honestly as missing,
 *   but missing all the same. Until now the only fix was a HAND-BUILT descriptor
 *   (`runs/phase1-v2-descriptor.json`, "query structure transcribed from Athena's
 *   delivered exports"), which is not something a user of the web app can do.
 *
 * WHY TRANSCRIBE RATHER THAN INFER
 *   A chat run once reported inferring query bodies from the grid's columns. That
 *   will eventually produce a query that runs and returns the WRONG ROWS:
 *   `ProductionOrder -> Product` joins `ProductId -> DefinitionId`, which no
 *   naming rule predicts (F-125). Evidence from a real artifact beats a
 *   derivation — the same rule that already governs data paths and type codes.
 *
 * The reader is deliberately strict: anything it cannot recover with certainty
 * makes it decline the file rather than emit a half-definition, because a
 * plausible-but-wrong query is the worst outcome available.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { QueryDefinitionType } from "../descriptor";

export class QueryReadError extends Error {}

interface Attrs { [k: string]: string | undefined }

/** every `<Tag value="…">` child of a node, as a plain map */
function values(node: unknown): Attrs {
  const out: Attrs = {};
  if (node === null || typeof node !== "object") return out;
  for (const [tag, v] of Object.entries(node as Record<string, unknown>)) {
    if (v === null || typeof v !== "object") continue;
    const a = (v as Record<string, unknown>)["@_value"];
    if (typeof a === "string") out[tag] = a;
  }
  return out;
}

const list = (v: unknown): unknown[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

/**
 * Invert `aliasOf`: "ProductionOrder_Product_2" with root "ProductionOrder"
 * gives the hop list ["Product"]. The root's own alias is "<root>_1", i.e. no
 * hops. Returns null when the alias does not belong to this root, which is the
 * signal to decline rather than guess.
 */
function hopsFromAlias(rootEntity: string, alias: string | undefined): string[] | null {
  if (!alias) return null;
  const parts = alias.split("_");
  const ordinal = parts.pop();
  if (ordinal === undefined || !/^\d+$/.test(ordinal)) return null;
  if (parts[0] !== rootEntity) return null;
  return parts.slice(1);
}

/** the display path for a field or filter: hops from the root plus the property */
function pathOf(rootEntity: string, alias: string | undefined, property: string): string | null {
  const hops = hopsFromAlias(rootEntity, alias);
  if (hops === null) return null;
  return [...hops, property].join(".");
}

/**
 * Parse one delivered query export.
 *
 * @throws QueryReadError when the file is not a query, or carries structure this
 *         reader cannot recover faithfully.
 */
export function readQueryDefinition(xml: string): QueryDefinitionType {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  let doc: Record<string, unknown>;
  try { doc = parser.parse(xml) as Record<string, unknown>; }
  catch (e) { throw new QueryReadError(`not parseable as XML: ${(e as Error).message}`); }

  const root = (doc["CMF.ExportFile"] ?? {}) as Record<string, unknown>;
  const obj = root["Object"] as Record<string, unknown> | undefined;
  if (!obj) throw new QueryReadError("no <Object> element — not an export file");
  const objType = String(obj["@_type"] ?? "");
  if (!objType.includes("QueryObject")) {
    throw new QueryReadError(`Object type is not a QueryObject: ${objType.slice(0, 60)}`);
  }

  const top = values(obj);
  const name = top["Name"];
  const entity = top["EntityTypeName"];
  if (!name) throw new QueryReadError("query has no Name");
  if (!entity) throw new QueryReadError(`${name} has no EntityTypeName`);

  const query = obj["Query"] as Record<string, unknown> | undefined;
  if (!query) throw new QueryReadError(`${name} has no <Query> body`);

  // ---------------------------------------------------------------- fields
  const fields: string[] = [];
  const fieldItems = list((query["Fields"] as Record<string, unknown> | undefined)?.["Item"]);
  for (const it of fieldItems) {
    const v = values(it);
    const prop = v["Name"];
    if (!prop) continue;
    const p = pathOf(entity, v["ObjectAlias"], prop);
    if (p === null) {
      throw new QueryReadError(
        `${name}: field "${prop}" has alias "${v["ObjectAlias"] ?? ""}", which does not ` +
        `resolve against root entity "${entity}" — declining rather than guessing its path`,
      );
    }
    if (!fields.includes(p)) fields.push(p);
  }
  if (!fields.length) throw new QueryReadError(`${name} returns no fields`);

  // --------------------------------------------------------------- filters
  const filters: QueryDefinitionType["filters"] = [];
  for (const it of list((query["Filters"] as Record<string, unknown> | undefined)?.["Item"])) {
    const v = values(it);
    const prop = v["EntityTypePropertyId"] ?? v["Name"];
    if (!prop) continue;
    const p = pathOf(entity, v["ObjectAlias"], prop);
    if (p === null) {
      throw new QueryReadError(
        `${name}: filter on "${prop}" has alias "${v["ObjectAlias"] ?? ""}", which does ` +
        `not resolve against root entity "${entity}"`,
      );
    }
    const raw = v["Value"] ?? "";
    // "@ProductionOrder_Name" means the caller supplies it; anything else is literal
    const isParam = raw.startsWith("@");
    const f: QueryDefinitionType["filters"][number] = {
      path: p,
      operator: (v["Operator"] ?? "IsEqualTo") as QueryDefinitionType["filters"][number]["operator"],
    };
    if (isParam) f.parameter = true;
    else if (raw !== "") f.value = raw;
    if (v["IsOptional"] === "True") f.optional = true;
    // "Nothing" is CMF's marker for the last filter in a chain, not an operator
    const lo = v["LogicalOperator"];
    if (lo === "AND" || lo === "OR") f.logicalOperator = lo;
    filters.push(f);
  }

  // ----------------------------------------------------------------- joins
  const joins: NonNullable<QueryDefinitionType["joins"]> = [];
  for (const it of list((query["Relations"] as Record<string, unknown> | undefined)?.["Item"])) {
    const v = values(it);
    const target = v["TargetEntity"];
    const src = v["SourceProperty"];
    const tgt = v["TargetProperty"];
    if (!target || !src || !tgt) continue;
    const hops = hopsFromAlias(entity, v["TargetEntityAlias"]);
    if (hops === null || !hops.length) {
      throw new QueryReadError(
        `${name}: relation to "${target}" has alias "${v["TargetEntityAlias"] ?? ""}", ` +
        `which does not resolve against root entity "${entity}"`,
      );
    }
    const jt = v["SourceJoinType"];
    const join: NonNullable<QueryDefinitionType["joins"]>[number] = {
      path: hops.join("."), entity: target, sourceProperty: src, targetProperty: tgt,
    };
    if (jt === "InnerJoin" || jt === "LeftJoin" || jt === "RightJoin" || jt === "FullJoin") {
      join.joinType = jt;
    }
    joins.push(join);
  }

  /*
   * A multi-hop join must have its parent hop declared, because that is what our
   * assembler needs to build the chain. CMF's own exports do NOT always emit one
   * relation per hop — `SampleNewQ` joins at `MaterialContainer.TargetEntity`
   * with no relation for `MaterialContainer`; the alias implies it.
   *
   * We DECLINE such a query rather than synthesise the missing hop, because its
   * source/target properties are exactly what cannot be guessed — the same reason
   * this module transcribes instead of inferring. The caller then reports the
   * query as a gap, which is honest, instead of shipping a join we invented.
   */
  const declared = new Set(joins.map((j) => j.path));
  for (const j of joins) {
    const parts = j.path.split(".");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join(".");
      if (!declared.has(parent)) {
        throw new QueryReadError(
          `${name}: join "${j.path}" needs its parent hop "${parent}", which this export ` +
          `does not declare as a relation. Its key properties cannot be recovered, and ` +
          `guessing them would produce a query that runs and returns the wrong rows.`,
        );
      }
    }
  }

  const def: QueryDefinitionType = { name, entity, fields, filters };
  if (joins.length) def.joins = joins;
  return def;
}

export interface FoundQuery {
  def: QueryDefinitionType;
  /** the file it was transcribed from — recorded so provenance reaches the gap report */
  source: string;
}

/**
 * Find a delivered export for each named query, by reading every candidate file
 * and matching on the query's OWN `Name` — never on the filename, which carries
 * load-order prefixes (`100_CustomRetrieveProductionOrders.xml`) and varies
 * between feature folders.
 */
export function findQueryDefinitions(
  roots: readonly string[], wanted: readonly string[],
): Map<string, FoundQuery> {
  const out = new Map<string, FoundQuery>();
  if (!wanted.length) return out;
  const want = new Set(wanted);
  for (const [name, source] of scanQueries(roots)) {
    if (!want.has(name) || out.has(name)) continue;
    let def: QueryDefinitionType;
    try { def = readQueryDefinition(readFileSync(source, "utf-8")); } catch { continue; }
    out.set(name, { def, source });
  }
  return out;
}

/**
 * EVERY query name the corpus holds, and where each was read from.
 *
 * `findQueryDefinitions` answers "is this exact name delivered". It cannot
 * answer "do your own exports disagree about what this query is called" — and
 * they do: v2.28.0 ships `CustomLoadFeederResource`, v2.39.0 ships
 * `CustomLoadFeederResources`, and a requirement naming one of them is naming
 * one of two real things.
 *
 * Matched on the query's OWN `Name`, never the filename, for the same reason
 * the function above gives: filenames carry load-order prefixes and vary
 * between feature folders.
 */
export function scanQueries(roots: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();

  const walk = (dir: string, acc: string[]): string[] => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return acc; }
    for (const e of entries) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, acc);
      else if (extname(p).toLowerCase() === ".xml") acc.push(p);
    }
    return acc;
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of walk(root, [])) {
      let xml: string;
      try { xml = readFileSync(file, "utf-8"); } catch { continue; }
      // cheap reject before the full parse — most files are pages, not queries
      if (!xml.includes("QueryObject")) continue;
      let def: QueryDefinitionType;
      try { def = readQueryDefinition(xml); } catch { continue; }
      if (!found.has(def.name)) found.set(def.name, file);
    }
  }
  return found;
}
