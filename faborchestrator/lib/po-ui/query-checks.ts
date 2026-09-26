/**
 * VALIDATOR — deterministic checks on a generated CMF Query export.
 *
 * WHY THIS EXISTS
 *   `IMPORT-VALIDATION-RESULT.md` established that CMF's own import validator does
 *   not inspect a page's definition — it treats the payload as an opaque string.
 *   The same is true of a query: import will accept a query whose filter references
 *   an alias nothing declares, and the query will simply fail or return the wrong
 *   rows at execution time. So, exactly as for UI Pages, **our validator is the
 *   only thing between a generated query and a silent failure.**
 *
 * NOT PART OF THE PYTHON ORACLE, DELIBERATELY
 *   `checks.ts` is a literal port of `validate.py` so the two can be diffed —
 *   that discipline exists because Python was the original. There is no Python
 *   original for queries, so a second implementation would be duplicated effort
 *   with nothing to prove. This module is TypeScript-only by design. Do not add a
 *   Python mirror expecting the oracle to cover it; the oracle corpus is UI Pages.
 *
 * THE GROUND TRUTH
 *   Athena delivered three real query exports. Every rule below must accept all
 *   three — a rule that rejects a file CMF itself produced is a wrong rule, not a
 *   finding. test/query-validate.test.ts enforces that.
 */
import { readFileSync, existsSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { CMF_VERSION, EXPORT_ROOT } from "./platform";
import { rule, type Conventions } from "./conventions";
import type { Level, Result } from "./types";
import type { QueryDefinitionType } from "./descriptor";

const ATTR = "@_";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  allowBooleanAttributes: true,
  parseAttributeValue: false,   // ids are 19 digits; keep everything a string
  trimValues: false,
});

type Node = Record<string, unknown>;

const asArray = (v: unknown): Node[] =>
  v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]) as Node[];

/** the `value` attribute of a child element, or undefined when absent/isNull */
function val(node: Node | undefined, tag: string): string | undefined {
  const child = node?.[tag];
  const item = Array.isArray(child) ? child[0] : child;
  if (item === null || item === undefined || typeof item !== "object") return undefined;
  const v = (item as Node)[ATTR + "value"];
  return typeof v === "string" ? v : undefined;
}

/** Items of a `<X type="Collection">` child. */
function items(node: Node | undefined, tag: string): Node[] {
  const child = node?.[tag];
  const holder = Array.isArray(child) ? child[0] : child;
  if (!holder || typeof holder !== "object") return [];
  return asArray((holder as Node)["Item"]);
}

/**
 * Valid filter operators.
 *
 * The first twelve are the builder's dropdown labels with spaces removed, taken
 * from the step-by-step build document. **`IsNull` and `IsNotNull` were added
 * 2026-08-19**: they appear on three filters across Athena's 17 real query
 * exports, and our list rejected every query using them.
 *
 * The list is evidence, not a specification — it may still be incomplete. It grows
 * when a real export shows an operator we do not have, never by guessing at what
 * a builder dropdown might contain.
 */
export const QUERY_OPERATORS = new Set([
  "IsEqualTo", "IsNotEqualTo", "Contains", "StartsWith",
  "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo",
  "Like", "NotLike", "In", "NotIn",
  "IsNull", "IsNotNull",
]);

export interface QueryReport {
  results: Result[];
  counts: Record<Level, number>;
  ok: boolean;
}

export function validateQuery(
  artifactPath: string,
  conv: Conventions,
  /** the definition it was generated from; without it, structural checks only */
  def?: QueryDefinitionType,
): QueryReport {
  const r: Result[] = [];
  const push = (level: Level, name: string, detail = ""): void => { r.push({ level, name, detail }); };

  if (!existsSync(artifactPath)) {
    push("FAIL", "file exists", artifactPath);
    return finish(r);
  }
  const raw = readFileSync(artifactPath, "utf-8");

  const wf = XMLValidator.validate(raw, { allowBooleanAttributes: true });
  if (wf !== true) {
    push("FAIL", "well-formed XML", wf.err.msg);
    return finish(r);
  }
  push("PASS", "well-formed XML");

  const doc = parser.parse(raw) as Node;
  const rootTag = Object.keys(doc).find((k) => !k.startsWith("?") && !k.startsWith(ATTR));
  if (rootTag !== EXPORT_ROOT) {
    push("FAIL", `root is ${EXPORT_ROOT}`, rootTag ?? "");
    return finish(r);
  }
  const root = doc[rootTag] as Node;
  const obj = (Array.isArray(root["Object"]) ? root["Object"][0] : root["Object"]) as Node | undefined;
  if (!obj) { push("FAIL", "Object element present"); return finish(r); }

  const objType = String(obj[ATTR + "type"] ?? "");
  if (!objType.includes("QueryObject.QueryObject")) {
    push("FAIL", "Object type is QueryObject", objType.slice(0, 60));
    return finish(r);
  }
  if (!objType.includes(CMF_VERSION)) {
    push("WARN", `CMF version ${CMF_VERSION} in type string`, objType.slice(0, 60));
  } else {
    push("PASS", "envelope + version string");
  }

  // client convention: the Custom prefix
  const pr = rule(conv, "namePrefix");
  const name = val(obj, "Name") ?? "";
  if (pr) {
    if (name && !name.startsWith(pr.value)) {
      push(pr.severity, `name carries ${pr.value} prefix`, name);
    } else {
      push("PASS", `name carries ${pr.value} prefix`);
    }
  }

  const entity = val(obj, "EntityTypeName") ?? "";
  if (!entity) push("FAIL", "EntityTypeName is set", "a query with no root entity returns nothing");
  else push("PASS", `root entity is ${entity}`);

  const query = (Array.isArray(obj["Query"]) ? obj["Query"][0] : obj["Query"]) as Node | undefined;
  if (!query) { push("FAIL", "Query body present"); return finish(r); }

  const relations = items(query, "Relations");
  const params = items(query, "QueryParameters");
  const fields = items(query, "Fields");
  const filters = items(query, "Filters");

  // ---------------------------------------------------------------- fields
  if (fields.length === 0) {
    push("FAIL", "query returns at least one field", "a query with no fields returns nothing");
  } else {
    push("PASS", `query returns ${fields.length} field(s)`);
  }

  /**
   * Positions must be present, non-negative and UNIQUE — but NOT contiguous.
   *
   * An earlier draft required contiguity from 0 and was wrong: all three of
   * Athena's real exports have gaps (`0,1,2,3,4,5,6,7,9,10` and `0,1,2,3,5`),
   * which is what a column removed from a query leaves behind. CMF plainly does
   * not care. Duplicates are a different matter — two fields claiming the same
   * ordinal is genuinely ambiguous — and every field needing *a* position is a
   * real requirement.
   */
  const positions = fields.map((f) => Number(val(f, "Position")));
  const valid = positions.filter((n) => Number.isFinite(n) && n >= 0);
  const dupes = valid.length - new Set(valid).size;
  if (valid.length !== fields.length) {
    push("FAIL", "every field has a non-negative Position",
      `${valid.length} of ${fields.length}`);
  } else if (dupes > 0) {
    const counted = new Map<number, number>();
    for (const p of valid) counted.set(p, (counted.get(p) ?? 0) + 1);
    const clashes = [...counted].filter(([, n]) => n > 1).map(([p]) => p);
    push("FAIL", "field positions are unique",
      `${dupes} duplicate(s) at position ${clashes.join(", ")}`);
  } else {
    push("PASS", `all ${fields.length} field positions present and unique`);
  }

  // ---------------------------------------------------------------- aliases
  //
  // A Field or Filter names the alias it reads from. Every such alias must be
  // declared — by the root entity or by a Relation. A dangling alias produces a
  // query that imports cleanly and fails (or worse, silently returns wrong rows).
  const declared = new Set<string>();
  for (const rel of relations) {
    const s = val(rel, "SourceEntityAlias");
    const t = val(rel, "TargetEntityAlias");
    if (s) declared.add(s);
    if (t) declared.add(t);
  }
  // the root alias appears as a Relation source, or — when there are no joins —
  // only on the fields themselves; accept whatever the fields agree on as root.
  if (relations.length === 0) {
    for (const f of fields) { const a = val(f, "ObjectAlias"); if (a) declared.add(a); }
  }

  /**
   * An alias resolves when a Relation declares it — OR when its path is a PREFIX
   * of a declared alias's path.
   *
   * CMF collapses a multi-hop join into a single Relation but still references the
   * intermediate alias from fields and filters. `001_TransferToteGridQuery` joins
   * `Material_1` straight to `Material_MaterialContainer_TargetEntity_3`, and then
   * filters on `Material_MaterialContainer_2` — an alias no Relation declares and
   * which is nonetheless correct.
   *
   * Measured 2026-08-19: **3 undeclared aliases across 17 real query exports, and
   * all 3 are path prefixes of a declared one.** Requiring an exact declaration
   * rejected those files — a wrong rule, not a finding, exactly as with the
   * contiguity assumption in F-89.
   */
  const stem = (a: string): string => a.replace(/_\d+$/, "");
  const declaredStems = [...declared].map(stem);
  const resolves = (a: string): boolean => {
    if (declared.has(a)) return true;
    const s = stem(a);
    return declaredStems.some((d) => d === s || d.startsWith(s + "_"));
  };

  const dangling: string[] = [];
  const seen = (n: Node, kind: string, label: string): void => {
    const a = val(n, "ObjectAlias");
    if (a && !resolves(a)) dangling.push(`${kind} ${label} -> ${a}`);
  };
  fields.forEach((f) => seen(f, "field", val(f, "Name") ?? "?"));
  filters.forEach((f) => seen(f, "filter", val(f, "Name") ?? "?"));

  if (dangling.length) {
    push("FAIL", "all field/filter aliases resolve",
      `${dangling.length} dangling: ${dangling.slice(0, 5).join("; ")}`);
  } else {
    push("PASS", `all ${fields.length + filters.length} field/filter aliases resolve`);
  }

  // a Relation must join FROM an alias that already exists
  const orderIssues: string[] = [];
  const built = new Set<string>();
  if (relations.length) {
    const firstSource = val(relations[0], "SourceEntityAlias");
    if (firstSource) built.add(firstSource);
    for (const rel of relations) {
      const s = val(rel, "SourceEntityAlias");
      const t = val(rel, "TargetEntityAlias");
      if (s && !built.has(s)) orderIssues.push(`${s} joined from before it is defined`);
      if (t) built.add(t);
    }
    if (orderIssues.length) {
      push("FAIL", "joins are declared in dependency order", orderIssues.slice(0, 4).join("; "));
    } else {
      push("PASS", `all ${relations.length} join(s) declared in dependency order`);
    }
  }

  // ---------------------------------------------------------------- parameters
  const declaredParams = new Set(params.map((p) => val(p, "Name") ?? "").filter(Boolean));
  const referenced = new Set<string>();
  const badRefs: string[] = [];
  for (const f of filters) {
    const v = val(f, "Value") ?? "";
    if (!v.startsWith("@")) continue;
    const pname = v.slice(1);
    referenced.add(pname);
    if (!declaredParams.has(pname)) badRefs.push(`${val(f, "Name") ?? "?"} -> ${v}`);
  }
  if (badRefs.length) {
    push("FAIL", "every @parameter reference is declared",
      `${badRefs.length} undeclared: ${badRefs.slice(0, 5).join("; ")}`);
  } else {
    push("PASS", `all ${referenced.size} @parameter reference(s) declared`);
  }

  const unused = [...declaredParams].filter((p) => !referenced.has(p));
  if (unused.length) {
    push("WARN", "every declared parameter is used by a filter",
      `${unused.length} unused: ${unused.slice(0, 5).join(", ")}`);
  }

  const hasParams = (val(query, "HasParameters") ?? "").toLowerCase();
  const expected = params.length > 0 ? "true" : "false";
  if (hasParams !== expected) {
    push("FAIL", `HasParameters == ${expected}`,
      `found ${hasParams || "(absent)"} with ${params.length} parameter(s)`);
  } else {
    push("PASS", `HasParameters == ${expected}`);
  }

  // ---------------------------------------------------------------- operators
  const badOps = filters
    .map((f) => val(f, "Operator") ?? "")
    .filter((o) => o && !QUERY_OPERATORS.has(o));
  if (badOps.length) {
    push("FAIL", "filter operators are valid", `${[...new Set(badOps)].join(", ")}`);
  } else if (filters.length) {
    push("PASS", `all ${filters.length} filter operator(s) valid`);
  }

  // ---------------------------------------------------------------- spec coverage
  if (def) {
    const wantFields = def.fields.map((p) => p.split(".").pop() ?? p);
    const gotFields = fields.map((f) => val(f, "Name") ?? "");
    const missing = wantFields.filter((w) => !gotFields.includes(w));

    /*
     * A MATERIALISED REFERENCE FIELD IS NOT AN UNREQUESTED ONE  (T-49).
     *
     * A declared reference column `Step.Id` is emitted as three fields, not one:
     * `__cmf_html_Step_Id`, `__cmf_html_Step_Name` and — where the entity has
     * one — `__cmf_html_Step_Revision`. That is what makes the column render a
     * name instead of a row id, and it is what their own exports carry (32 of 36
     * joined fields).
     *
     * Counted against the spec, those extras look like invention, and this check
     * failed a rebuild of the client's own `CustomLoadMaterialsTofeeder` for
     * exactly that reason. They are attributable: each is accounted for by a
     * declared `<Hop>.Id`. Anything NOT so accounted for is still a FAIL, so the
     * check keeps the property it exists for.
     */
    const declaredRefs = new Set(
      def.fields.filter((p) => p.split(".").length === 2 && p.endsWith(".Id"))
        .map((p) => p.split(".")[0]!),
    );
    const attributable = (alias: string): boolean => {
      const m = /^__cmf_html_(.+)_(Id|Name|Revision)$/.exec(alias);
      return Boolean(m && declaredRefs.has(m[1]!));
    };
    const extras = fields
      .map((f) => val(f, "Alias") ?? "")
      .filter((a) => !attributable(a));

    if (missing.length) {
      push("FAIL", "all spec fields present", `missing ${missing.join(", ")}`);
    } else if (extras.length > wantFields.length) {
      push("FAIL", "no unrequested fields",
        `${extras.length} unattributable field(s), spec asks for ${wantFields.length}` +
        `${gotFields.length !== extras.length
          ? ` (${gotFields.length - extras.length} materialised reference field(s) excluded)` : ""}`);
    } else {
      push("PASS", `all ${wantFields.length} spec fields present`);
    }

    if (filters.length !== def.filters.length) {
      push("FAIL", `filter count == ${def.filters.length} (spec)`, `found ${filters.length}`);
    } else {
      push("PASS", `filter count == ${def.filters.length} (spec)`);
    }

    if (entity && entity !== def.entity) {
      push("FAIL", `root entity == ${def.entity} (spec)`, `found ${entity}`);
    }
  } else {
    push("WARN", "spec coverage not checked", "no query definition supplied");
  }

  return finish(r);
}

function finish(results: Result[]): QueryReport {
  const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const x of results) counts[x.level] += 1;
  return { results, counts, ok: counts.FAIL === 0 };
}
