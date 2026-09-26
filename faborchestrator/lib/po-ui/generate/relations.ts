/**
 * ENTITY RELATIONS — the join graph, read from CMF's own schema.
 *
 * WHAT THIS SOLVES
 *   `query.ts` refuses to build a join it cannot transcribe:
 *
 *     path "Material.ProductionOrder.Name" crosses into "Material.ProductionOrder"
 *     but no join declares it — the foreign-key columns cannot be guessed.
 *
 *   That refusal was right. F-125 measured that `ProductionOrder -> Product` joins
 *   `ProductId -> DefinitionId`, which no naming rule predicts, and a query that
 *   joins on the wrong column RUNS and returns the wrong rows. So the builder
 *   declined, and a descriptor that named its queries without describing their
 *   joins produced nothing (the live 3-page run: `queries: 0/2 generated`).
 *
 *   It turns out the foreign key was never a guess — it is a schema fact we had
 *   simply never read (F-158):
 *
 *     ReferenceType 1  ->  the target entity's `Id`
 *     ReferenceType 7  ->  the target entity's `DefinitionId`  (a VERSIONED entity)
 *
 *   `DefinitionId` exists on 21 of 340 entity types, and those are exactly the
 *   entities that appear as ReferenceType 7 targets.
 *
 * HOW FAR IT IS TRUSTED
 *   Tested against every join Athena delivered: **5 of 5** predicted, including
 *   both cases F-125 called unpredictable. Across the whole schema: 417 hold, 13
 *   break, the exceptions concentrated in the Planning and ML modules.
 *
 *   So this is NOT applied blindly. A join is derived only when the schema says
 *   so UNAMBIGUOUSLY:
 *     - the source entity is in the captured graph, and
 *     - it has a reference property of that name, and
 *     - that property's ReferenceType is 1 or 7, and
 *     - the target entity is also in the graph and carries the key the rule
 *       requires.
 *   Anything else keeps the old refusal. Declining less often is the goal;
 *   guessing is still not.
 *
 * THE TARGET IS EXACT, NOT GUESSED FROM THE NAME
 *   Each reference carries the entity its `ReferencedObjectId` resolves to. That
 *   matters more than it looks: **457 of 885** reference properties have a name
 *   that differs from their target — `Material.LastProcessedResource` targets
 *   `Resource`, `Area.PickingStrategy` targets `SortRuleSet`. Matching by name
 *   would have silently declined every one of them.
 */
import { existsSync, readFileSync } from "node:fs";

export interface RelationEntity {
  hasId: boolean;
  hasDefinitionId: boolean;
  references: Array<{ name: string; referenceType: number; target?: string | null }>;
  enums: string[];
}

export interface RelationGraph {
  entityCount?: number;
  capturedAt?: string;
  entities: Record<string, RelationEntity>;
}

/** A join the schema is willing to state. */
export interface DerivedJoin {
  entity: string;
  sourceProperty: string;
  targetProperty: string;
  /** why it is what it is, for the run log and the gap report */
  because: string;
}

export function loadRelations(path: string | undefined): RelationGraph | null {
  if (!path || !existsSync(path)) return null;
  try {
    const g = JSON.parse(readFileSync(path, "utf-8")) as RelationGraph;
    return g && typeof g === "object" && g.entities ? g : null;
  } catch {
    return null;
  }
}

/**
 * The join for `<sourceEntity>.<reference>`, or null when the schema does not
 * state one unambiguously.
 *
 * Returning null is a normal outcome, not an error: the caller keeps its
 * existing refusal, which is the behaviour that has always been correct.
 */
export function deriveJoin(
  graph: RelationGraph | null, sourceEntity: string, reference: string,
): DerivedJoin | null {
  if (!graph) return null;
  const src = graph.entities[sourceEntity];
  if (!src) return null;

  const ref = src.references.find((r) => r.name === reference);
  if (!ref) return null;
  if (ref.referenceType !== 1 && ref.referenceType !== 7) return null;

  // The target the schema states, not the property's name.
  const targetName = ref.target ?? reference;
  const target = graph.entities[targetName];
  if (!target) return null;

  const targetProperty = ref.referenceType === 7 ? "DefinitionId" : "Id";
  // The rule only applies if the target actually carries that key. A mismatch
  // means this is one of the thirteen exceptions, and it must not be guessed at.
  if (targetProperty === "DefinitionId" && !target.hasDefinitionId) return null;
  if (targetProperty === "Id" && !target.hasId) return null;
  // A versioned target reached through ReferenceType 1 is equally suspect.
  if (ref.referenceType === 1 && target.hasDefinitionId) return null;

  return {
    entity: targetName,
    sourceProperty: `${reference}Id`,
    targetProperty,
    because: `schema: ${sourceEntity}.${reference} is ReferenceType ${ref.referenceType}` +
             `, so the foreign key targets ${targetName}.${targetProperty}`,
  };
}

/** Is `entity.property` an enum, in CMF's sense (ReferenceType 6)? */
export function isEnumProperty(
  graph: RelationGraph | null, entity: string, property: string,
): boolean {
  return Boolean(graph?.entities[entity]?.enums.includes(property));
}
