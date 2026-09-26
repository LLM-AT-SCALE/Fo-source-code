import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";

/**
 * Map a free-text request ("I want to load production orders") to a real CMF
 * object type from the master-data template. Pure, in-process fuzzy match over
 * the 246 template-schema keys (and their `<XX>`-prefixed `raw` sheet names) —
 * no DB. The chatbot confirms the chosen type with the user before doing any
 * DB work, so this only needs to surface good candidates.
 */

export type ObjectTypeCandidate = {
  objectType: string;
  /** The template sheet name, e.g. `<DM>ProductionOrder`. */
  raw: string;
  /** 0–1 relevance score (1 = exact). */
  score: number;
};

const RESERVED = new Set(["$order", "$ambiguous"]);

type Entry = { objectType: string; raw: string; norm: string; words: string[] };

/** Split a CamelCase / spaced identifier into lowercase word tokens. */
function tokenize(s: string): string[] {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Lowercase, alphanumerics only — for prefix/substring comparison. */
function normalize(s: string): string {
  return s.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ENTRIES: Entry[] = Object.entries(
  templateSchema as Record<string, { raw?: string }>,
)
  .filter(([k]) => !RESERVED.has(k))
  .map(([objectType, v]) => ({
    objectType,
    raw: v.raw ?? objectType,
    norm: normalize(objectType),
    words: tokenize(objectType),
  }));

function scoreEntry(qNorm: string, qWords: string[], e: Entry): number {
  if (!qNorm) return 0;
  if (e.norm === qNorm) return 1;

  // Whole-string prefix / containment (e.g. "productionorder" vs "productionordertype").
  if (e.norm.startsWith(qNorm) || qNorm.startsWith(e.norm)) {
    const longer = Math.max(e.norm.length, qNorm.length);
    const shorter = Math.min(e.norm.length, qNorm.length);
    return 0.78 + 0.12 * (shorter / longer);
  }
  if (e.norm.includes(qNorm)) return 0.6 + 0.1 * (qNorm.length / e.norm.length);

  // Token overlap (e.g. "production order" → ["production","order"]).
  if (qWords.length) {
    let hit = 0;
    for (const w of qWords) {
      if (e.words.some((ew) => ew === w || ew.startsWith(w) || w.startsWith(ew))) hit++;
    }
    if (hit > 0) {
      const coverage = hit / qWords.length;
      const completeness = hit / e.words.length;
      return 0.3 + 0.4 * coverage + 0.15 * completeness;
    }
  }
  return 0;
}

/**
 * Return the best-matching object types for a free-text query, highest score
 * first. `limit` caps the candidate count (default 6); scores below `minScore`
 * (default 0.2) are dropped.
 */
export function resolveObjectType(
  query: string,
  { limit = 6, minScore = 0.2 }: { limit?: number; minScore?: number } = {},
): ObjectTypeCandidate[] {
  const qNorm = normalize(query);
  const qWords = tokenize(query);

  return ENTRIES.map((e) => ({
    objectType: e.objectType,
    raw: e.raw,
    score: Number(scoreEntry(qNorm, qWords, e).toFixed(3)),
  }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.objectType.length - b.objectType.length)
    .slice(0, limit);
}
