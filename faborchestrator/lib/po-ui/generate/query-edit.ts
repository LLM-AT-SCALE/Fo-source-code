/**
 * SURGICAL EDITS TO A DELIVERED QUERY EXPORT  (T-47)
 *
 * WHY NOT PARSE AND REBUILD
 *   Because a round trip loses what our reader does not model, and on this very
 *   story that loss would have broken a column that currently works.
 *
 *   Their `CustomRetrievePOMaterials` selects `__cmf_html_Step_Id` and
 *   `__cmf_html_Step_Name`. That prefix is how CMF materialises a reference so
 *   the grid renders it as a navigable name — it is why their Step column reads
 *   "SCCO2 Cleaning" and not a row id. Re-assembling from the parsed definition
 *   rewrote those aliases to `Step.Id` / `Step.Name`, which would have traded
 *   six blank columns for one newly-broken one.
 *
 *   The same applies to their `CustomRetrieveProductionOrders`, where the only
 *   change needed is a single boolean and a rebuild would have rewritten three
 *   `__cmf_html_Product_*` aliases to get it.
 *
 * SO: EDIT THE TEXT, AND TOUCH NOTHING ELSE.
 *   Every byte the change does not need is the byte their tenant already runs.
 *   Same reasoning as `format-for-reading.ts`: when the input is known-good and
 *   the change is small, a textual edit is safer than a full re-serialisation.
 *
 * WHAT THESE FUNCTIONS WILL NOT DO
 *   Add a field that needs a JOIN. That means a new Relation, a new alias and a
 *   foreign key, which is a structural change and belongs to the assembler with
 *   the relation graph behind it. Here it is refused, and refusing is reported,
 *   because a wrong join produces a query that runs and returns the wrong rows.
 */

/** The CMF type strings these edits have to reproduce exactly. */
const T = {
  field: "Cmf.Foundation.BusinessObjects.QueryObject.Field, Cmf.Foundation.BusinessObjects, " +
    "Version=10.2.0.0, Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  string: "System.String, System.Private.CoreLib, Version=6.0.0.0, Culture=neutral, " +
    "PublicKeyToken=7cec85d7bea7798e",
  int: "System.Int32, System.Private.CoreLib, Version=6.0.0.0, Culture=neutral, " +
    "PublicKeyToken=7cec85d7bea7798e",
  bool: "System.Boolean, System.Private.CoreLib, Version=6.0.0.0, Culture=neutral, " +
    "PublicKeyToken=7cec85d7bea7798e",
  sort: "Cmf.Foundation.Common.FieldSort, Cmf.Foundation.Common, Version=10.2.0.0, " +
    "Culture=neutral, PublicKeyToken=6bbf07329f6aa8df",
  aggregate: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.FieldAggregateFunction, " +
    "Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, " +
    "PublicKeyToken=6bbf07329f6aa8df",
  objectType: "Cmf.Foundation.BusinessObjects.QueryObject.Enums.QueryObjectType, " +
    "Cmf.Foundation.BusinessObjects, Version=10.2.0.0, Culture=neutral, " +
    "PublicKeyToken=6bbf07329f6aa8df",
} as const;

const el = (tag: string, value: string, type: string): string =>
  `<${tag} value="${value}" type="${type}" />`;

/**
 * The `Fields` collection that belongs to the QUERY, not to a Relation.
 *
 * A Relation `Item` carries its own self-closing `<Fields … />`, so the first
 * match of the tag name is the wrong one. The query's is the one that is opened
 * and later closed; locating it from `</Fields>` backwards is unambiguous.
 */
function fieldsRange(xml: string): { open: number; close: number } | null {
  const close = xml.indexOf("</Fields>");
  if (close < 0) return null;
  const open = xml.lastIndexOf("<Fields", close);
  if (open < 0) return null;
  const contentStart = xml.indexOf(">", open) + 1;
  if (contentStart <= 0 || contentStart > close) return null;
  return { open: contentStart, close };
}

/** The highest `Position` any field currently holds, so new ones come after. */
function lastPosition(fieldsXml: string): number {
  let max = -1;
  const re = /<Position value="(\d+)"/g;
  for (let m = re.exec(fieldsXml); m !== null; m = re.exec(fieldsXml)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

export interface FieldAddition {
  /** the property name on the entity, e.g. "HoldCount" */
  name: string;
  /** the alias the row will carry — the grid's column path reads this */
  alias: string;
  /** the query alias of the entity it belongs to, e.g. "Material_1" */
  objectAlias: string;
  /** the entity's own name, e.g. "Material" */
  objectName: string;
}

/**
 * Append scalar fields to a query's `Fields` collection.
 *
 * Written as an insertion immediately before `</Fields>` so every existing Item
 * keeps its bytes and its order. New Items take positions after the last one in
 * use, which is what CMF does when a field is added in its own editor.
 */
export function addFields(xml: string, fields: readonly FieldAddition[]): {
  xml: string; added: string[];
} {
  if (fields.length === 0) return { xml, added: [] };
  const range = fieldsRange(xml);
  if (!range) return { xml, added: [] };

  const existing = xml.slice(range.open, range.close);
  let position = lastPosition(existing);
  const added: string[] = [];
  let insert = "";

  for (const f of fields) {
    // already selected under this alias — adding it twice would be a defect
    if (new RegExp(`<Alias value="${f.alias}"`).test(existing)) continue;
    position += 1;
    added.push(f.alias);
    insert +=
      `<Item type="${T.field}">` +
      el("Name", f.name, T.string) +
      el("Alias", f.alias, T.string) +
      el("Position", String(position), T.int) +
      el("Sort", "NoSort", T.sort) +
      el("IsUserAttribute", "False", T.bool) +
      `<DisplayFormatName isNull="True" />` +
      `<DisplayStyleName isNull="True" />` +
      `<DisplayConditionalStyleName isNull="True" />` +
      el("AggregateFunction", "NoFunction", T.aggregate) +
      el("ObjectType", "EntityType", T.objectType) +
      el("ObjectAlias", f.objectAlias, T.string) +
      el("ObjectName", f.objectName, T.string) +
      `</Item>`;
  }

  if (!insert) return { xml, added: [] };
  return { xml: xml.slice(0, range.close) + insert + xml.slice(range.close), added };
}

/**
 * Make the filter that reads `@<parameter>` optional.
 *
 * Located by its `Value`, which is the only field that names the parameter, and
 * edited within that Item alone: `IsOptional` appears on every filter, so a
 * global replace would relax all of them.
 */
export function relaxFilter(xml: string, parameter: string): {
  xml: string; changed: boolean;
} {
  const marker = `<Value value="@${parameter}"`;
  const at = xml.indexOf(marker);
  if (at < 0) return { xml, changed: false };

  const itemStart = xml.lastIndexOf("<Item", at);
  const itemEnd = xml.indexOf("</Item>", at);
  if (itemStart < 0 || itemEnd < 0) return { xml, changed: false };

  const item = xml.slice(itemStart, itemEnd);
  const relaxed = item.replace(
    /<IsOptional value="False"/,
    `<IsOptional value="True"`,
  );
  if (relaxed === item) return { xml, changed: false };

  return { xml: xml.slice(0, itemStart) + relaxed + xml.slice(itemEnd), changed: true };
}
