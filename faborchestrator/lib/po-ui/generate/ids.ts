/**
 * $id ASSIGNMENT — deterministic, ours, not the model's.
 *
 * CMF's serialiser numbers every object in the settings JSON. The rule, verified
 * against the reference page (227 markers over 227 objects):
 *
 *   pre-order, document-order counter over every JSON object.
 *   Arrays are not counted, only objects. The root object is "1".
 *   Contiguous, no duplicates, no gaps.
 *
 * That is arithmetic over 200+ objects, not a judgement call — so our code does
 * it. Asking the model to renumber the whole document is how round 2 shipped a
 * file with 3 markers for 207 objects and still passed the contiguity check.
 */

export const ID_KEY = "$id";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Return a deep copy with $id assigned to every object in pre-order.
 * Any $id already present is renumbered; its VALUE is never trusted.
 *
 * Placement: CMF's serialiser does not put $id at a fixed index — across the
 * reference page it lands at index 0 through 15 depending on the object. Key
 * order carries no meaning in JSON, so we keep an existing key where it sits
 * (making a re-number of an exported file byte-exact, which is what proves the
 * counter rule) and prepend it on objects that don't have one yet.
 */
export function assignIds(root: unknown): unknown {
  let counter = 0;

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      // arrays are not numbered; their elements are visited in order
      return node.map(walk);
    }
    if (!isPlainObject(node)) return node;

    counter += 1;
    const id = String(counter);
    const hadKey = ID_KEY in node;

    const out: Record<string, unknown> = hadKey ? {} : { [ID_KEY]: id };
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === ID_KEY ? id : walk(v);
    }
    return out;
  }

  return walk(root);
}

/** How many objects a value contains — the number assignIds would emit. */
export function countObjects(root: unknown): number {
  let n = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isPlainObject(node)) return;
    n += 1;
    for (const [k, v] of Object.entries(node)) {
      if (k !== ID_KEY) walk(v);
    }
  };
  walk(root);
  return n;
}

export interface IdAudit {
  objects: number;
  markers: number;
  contiguous: boolean;
  duplicates: string[];
  missing: number;
}

/** Independent check of a numbered document — used to verify our own output. */
export function auditIds(root: unknown): IdAudit {
  const seen: string[] = [];
  let objects = 0;
  let missing = 0;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isPlainObject(node)) return;
    objects += 1;
    const id = node[ID_KEY];
    if (typeof id === "string") seen.push(id);
    else missing += 1;
    for (const [k, v] of Object.entries(node)) {
      if (k !== ID_KEY) walk(v);
    }
  };
  walk(root);

  const nums = seen.map(Number).sort((a, b) => a - b);
  const duplicates = seen.filter((v, i) => seen.indexOf(v) !== i);
  const contiguous =
    nums.length > 0 && nums.every((n, i) => n === i + 1) && duplicates.length === 0;

  return { objects, markers: seen.length, contiguous, duplicates, missing };
}
