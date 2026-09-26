import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { currentDbKey } from "@/modules/master-data-load/lib/cmf/db-context";

/**
 * Pre-flight validation rulesets sourced from CMF's OWN metadata, so the rules
 * we enforce are exactly CMF's rules. Handles the three object-model types:
 * Smart Table, Generic Table, and Entity. Each property carries the mandatory
 * flag, scalar type/size, optional regex, key flag, and — for reference columns
 * — the target entity type (used for parent/child key existence checks).
 *
 * Metadata is loaded in BULK (`loadRulesets`): many object types are resolved in
 * a handful of round-trips instead of ~4 sequential CMF queries per type. This
 * kills the N+1 pattern that made large uploads (e.g. a 4 MB file with ~150
 * types ≈ ~600 serial VPN round-trips) slow. `loadRuleset` is a single-type
 * convenience that delegates to `loadRulesets`.
 */

export type PropertyRule = {
  name: string;
  mandatory: boolean;
  isKey: boolean;
  scalarType: string | null;
  scalarSize: number | null;
  validationRegex: string | null;
  /** Entity type this column references (parent), or null if not a reference. */
  referenceTargetType: string | null;
  /** CMF-declared default for this property (`T_*Property.DefaultValue`), or
   *  null when CMF declares none. Used to fill a mandatory field that came back
   *  NULL from an existing record with the SAME value CMF would apply on load —
   *  e.g. DataCollection.SPCPostMode defaults to "0". Smart tables carry no
   *  DefaultValue column, so it is always null for them. */
  defaultValue: string | null;
};

/**
 * True when a property is a GENUINE foreign-key reference to another object —
 * i.e. it is safe to validate its value against the target entity's records.
 *
 * CMF's `ReferencedObjectId` metadata is noisy: it decorates many plain SCALAR
 * columns with a bogus reference target (e.g. Step.Type → "DataCollectionPoint",
 * DataCollection.Type → "ShippingFacility", Parameter.Type → "SubRecipe"). Those
 * columns store a literal value ("Standard"), NOT an FK, so validating them as
 * references produces false "value not recognized" failures.
 *
 * The reliable discriminator: a real CMF FK column stores the target's numeric
 * id, so its scalar type is `BigInt` (or unset). A reference target attached to
 * a string/number/bit scalar (`NVarChar`, `Int`, `Bit`, …) is metadata noise.
 */
export function isFkReference(
  prop: PropertyRule,
): prop is PropertyRule & { referenceTargetType: string } {
  if (!prop.referenceTargetType) return false;
  return prop.scalarType == null || prop.scalarType === "BigInt";
}

type EntityModel = "smart" | "generic" | "entity";

export type EntityRuleset = {
  objectType: string;
  model: EntityModel;
  /** Physical table backing this object type, for live parent lookups. */
  table: { schema: string; name: string } | null;
  properties: PropertyRule[];
};

type RawProp = {
  ObjectType: string;
  Name: string;
  IsMandatory: boolean;
  IsKey: boolean | null;
  ScalarType: string | null;
  ScalarSize: number | null;
  ValidationRegex: string | null;
  RefTarget: string | null;
  DefaultValue: string | null;
};

// Bulk property queries — one per object-model family. Each returns rows for
// EVERY requested type at once (`Name in (…)`), tagged with the owning type via
// `ObjectType`, ordered by type then CMF's property order so `mapProps` yields
// the exact same PropertyRule sequence as the old per-type queries did.
const SMART_BULK = (inList: string) => `
  select st.Name as ObjectType, p.Name, p.IsMandatory, p.IsKey, sc.Name as ScalarType, p.ScalarSize,
         p.ValidationRegex, ref.Name as RefTarget, cast(null as nvarchar(max)) as DefaultValue
  from dbo.T_SmartTableProperty p
  join dbo.T_SmartTable st on st.SmartTableId = p.SmartTableId
  left join dbo.T_ScalarType sc on sc.ScalarTypeId = p.ScalarTypeId
  left join dbo.T_EntityType ref on ref.EntityTypeId = p.ReferenceTypeId
  where st.Name in (${inList}) order by st.Name, p.Position`;

const GENERIC_BULK = (inList: string) => `
  select gt.Name as ObjectType, p.Name, p.IsMandatory, p.IsKey, sc.Name as ScalarType, p.ScalarSize,
         p.ValidationRegex, ref.Name as RefTarget, p.DefaultValue
  from dbo.T_GenericTableProperty p
  join dbo.T_GenericTable gt on gt.GenericTableId = p.GenericTableId
  left join dbo.T_ScalarType sc on sc.ScalarTypeId = p.ScalarTypeId
  left join dbo.T_EntityType ref on ref.EntityTypeId = p.ReferenceTypeId
  where gt.Name in (${inList}) order by gt.Name, p.Position`;

const ENTITY_BULK = (inList: string) => `
  select et.Name as ObjectType, p.Name, p.IsMandatory, cast(0 as bit) as IsKey, sc.Name as ScalarType, p.ScalarSize,
         p.ValidationRegex, ref.Name as RefTarget, p.DefaultValue
  from dbo.T_EntityTypeProperty p
  join dbo.T_EntityType et on et.EntityTypeId = p.EntityTypeId
  left join dbo.T_ScalarType sc on sc.ScalarTypeId = p.ScalarTypeId
  left join dbo.T_EntityType ref on ref.EntityTypeId = p.ReferencedObjectId
  where et.Name in (${inList}) and p.IsEnabled = 1 order by et.Name, p.[Order]`;

// SQL Server caps a statement at 2100 parameters; chunk name lists well under it.
const PARAM_CHUNK = 1000;

function mapProps(rows: RawProp[]): PropertyRule[] {
  return rows.map((r) => ({
    name: r.Name,
    mandatory: !!r.IsMandatory,
    isKey: !!r.IsKey,
    scalarType: r.ScalarType,
    scalarSize: r.ScalarSize,
    validationRegex: r.ValidationRegex && r.ValidationRegex.trim() ? r.ValidationRegex : null,
    referenceTargetType: r.RefTarget,
    defaultValue: r.DefaultValue != null && String(r.DefaultValue).trim() !== "" ? String(r.DefaultValue) : null,
  }));
}

/**
 * Run one family's bulk query for `names`, returning its property rows grouped
 * by lowercased type name (CMF collation is case-insensitive, so a value like
 * "site" resolves regardless of the caller's casing).
 */
async function queryFamilyBulk(
  sqlFor: (inList: string) => string,
  names: string[],
): Promise<Map<string, RawProp[]>> {
  const out = new Map<string, RawProp[]>();
  for (let i = 0; i < names.length; i += PARAM_CHUNK) {
    const chunk = names.slice(i, i + PARAM_CHUNK);
    const params: Record<string, string> = {};
    const ph = chunk.map((v, idx) => {
      params[`t${idx}`] = v;
      return `@t${idx}`;
    });
    const rows = await cmfQuery<RawProp>(sqlFor(ph.join(",")), params);
    for (const r of rows) {
      const lk = String(r.ObjectType).toLowerCase();
      const arr = out.get(lk);
      if (arr) arr.push(r);
      else out.set(lk, [r]);
    }
  }
  return out;
}

/**
 * Resolve every physical backing table in ONE INFORMATION_SCHEMA query (instead
 * of one lookup per type). `resolved` maps lowercased type -> its model + the
 * CMF-canonical name used to build the physical table name.
 */
async function resolveTablesBulk(
  resolved: Map<string, { model: EntityModel; canonicalName: string }>,
): Promise<Map<string, { schema: string; name: string }>> {
  const out = new Map<string, { schema: string; name: string }>();
  if (resolved.size === 0) return out;

  const physToKey = new Map<string, string>(); // physical name (lower) -> type key (lower)
  const physNames: string[] = [];
  for (const [lk, r] of resolved) {
    const prefix = r.model === "smart" ? "T_ST_" : r.model === "generic" ? "T_GT_" : "T_";
    const phys = `${prefix}${r.canonicalName}`;
    physToKey.set(phys.toLowerCase(), lk);
    physNames.push(phys);
  }

  for (let i = 0; i < physNames.length; i += PARAM_CHUNK) {
    const chunk = physNames.slice(i, i + PARAM_CHUNK);
    const params: Record<string, string> = {};
    const ph = chunk.map((v, idx) => {
      params[`t${idx}`] = v;
      return `@t${idx}`;
    });
    const rows = await cmfQuery<{ TABLE_SCHEMA: string; TABLE_NAME: string }>(
      `select TABLE_SCHEMA, TABLE_NAME from INFORMATION_SCHEMA.TABLES
       where TABLE_TYPE='BASE TABLE' and TABLE_NAME in (${ph.join(",")})`,
      params,
    );
    for (const row of rows) {
      const lk = physToKey.get(String(row.TABLE_NAME).toLowerCase());
      if (lk) out.set(lk, { schema: row.TABLE_SCHEMA, name: row.TABLE_NAME });
    }
  }
  return out;
}

// Persistent ruleset cache. Keyed by `${dbKey}::${lowercased objectType}` so
// rulesets from the two CMF databases (source/target) never alias — the same
// object type can have different physical tables per DB.
const cache = new Map<string, EntityRuleset | null>();
const ck = (lower: string): string => `${currentDbKey()}::${lower}`;

/**
 * Resolve rulesets for MANY object types at once. Round-trip count is ~O(1) in
 * the number of types: at most one query per model family (Smart → Generic →
 * Entity, preserving precedence — a later family only sees types no earlier one
 * resolved) plus one bulk physical-table lookup. Results are cached
 * (lowercased key), so repeat/overlapping calls hit memory.
 *
 * Returns a map keyed by LOWERCASED type name → ruleset (or null when the type
 * is unknown to CMF). Behaviour matches the old per-type loader: same
 * precedence, same property order, same null-for-unknown semantics.
 */
export async function loadRulesets(
  types: string[],
): Promise<Map<string, EntityRuleset | null>> {
  const result = new Map<string, EntityRuleset | null>();

  // Split into cache hits vs. the set we still need to fetch. `wanted` maps the
  // lowercased key to a representative original spelling (for the query params).
  const wanted = new Map<string, string>();
  for (const t of types) {
    const lower = t.toLowerCase();
    if (cache.has(ck(lower))) {
      result.set(lower, cache.get(ck(lower)) ?? null);
    } else if (!wanted.has(lower)) {
      wanted.set(lower, t);
    }
  }
  if (wanted.size === 0) return result;

  // Resolve properties per family, honouring Smart → Generic → Entity precedence:
  // each family only queries the types no earlier family already claimed.
  const resolved = new Map<string, { model: EntityModel; canonicalName: string; props: PropertyRule[] }>();
  const families: { model: EntityModel; sqlFor: (inList: string) => string }[] = [
    { model: "smart", sqlFor: SMART_BULK },
    { model: "generic", sqlFor: GENERIC_BULK },
    { model: "entity", sqlFor: ENTITY_BULK },
  ];
  for (const fam of families) {
    const remaining = [...wanted.keys()].filter((lk) => !resolved.has(lk));
    if (remaining.length === 0) break;
    const names = remaining.map((lk) => wanted.get(lk)!);
    const rowsByType = await queryFamilyBulk(fam.sqlFor, names);
    for (const [lk, rows] of rowsByType) {
      if (rows.length > 0 && !resolved.has(lk)) {
        resolved.set(lk, {
          model: fam.model,
          canonicalName: rows[0].ObjectType, // CMF's own casing → correct physical-table name
          props: mapProps(rows),
        });
      }
    }
  }

  // One bulk lookup for all physical tables.
  const tables = await resolveTablesBulk(
    new Map([...resolved].map(([lk, r]) => [lk, { model: r.model, canonicalName: r.canonicalName }])),
  );

  // Build rulesets (or null), cache, and return.
  for (const [lower, orig] of wanted) {
    const r = resolved.get(lower);
    const rs: EntityRuleset | null = r
      ? { objectType: orig, model: r.model, table: tables.get(lower) ?? null, properties: r.props }
      : null;
    cache.set(ck(lower), rs);
    result.set(lower, rs);
  }
  return result;
}

/**
 * Build the ruleset for a single object type (Smart → Generic → Entity).
 * Delegates to the bulk loader — one code path, one cache.
 */
export async function loadRuleset(objectType: string): Promise<EntityRuleset | null> {
  const map = await loadRulesets([objectType]);
  return map.get(objectType.toLowerCase()) ?? null;
}

/**
 * Columns to compare when deciding "is the incoming row an actual update or
 * a no-op?" — excludes the key (Name) and any column we can't meaningfully
 * diff (reference columns are kept; CMF stores parent's Name there too).
 * Returns the column names in the order CMF lists them.
 */
export function getDiffableColumns(ruleset: EntityRuleset): string[] {
  return ruleset.properties
    .filter((p) => p.name.toLowerCase() !== "name" && !p.isKey)
    .map((p) => p.name);
}
