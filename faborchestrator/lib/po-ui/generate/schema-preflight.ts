/**
 * STRUCTURED-OUTPUT SCHEMA PREFLIGHT — catch at build time what the API rejects
 * at run time.
 *
 * Three separate 400s shipped green on 2026-08-27, each discoverable only by
 * making a live call. Every one of them broke a whole code path silently:
 *
 *   Invalid regex in pattern field: Quantifier '?' without preceding element
 *       — an ISO 8601 duration regex using lookahead. Killed every `--story`
 *         run at call 1 for a day (F-167).
 *
 *   The compiled grammar is too large, which would cause performance issues.
 *       — the descriptor's schema spliced inside another schema. Killed every
 *         PRD revision.
 *
 *   For 'object' type, 'additionalProperties' must be explicitly set to false
 *       — an unconstrained `{ type: "object" }`, which is not expressible in
 *         structured output at all.
 *
 * WHY THE SUITE COULD NOT SEE ANY OF THEM
 *   The only proof is a request the API accepts, and the tests are offline. So
 *   the rules the API enforces are written down HERE, from observed failures, and
 *   checked against every schema we send.
 *
 * ONLY OBSERVED RULES. Nothing here is a guess about what the validator might
 * also dislike — a preflight that rejects valid schemas is worse than none,
 * because it gets switched off.
 */

export type PreflightLevel = "error" | "warn";

export interface PreflightFinding {
  level: PreflightLevel;
  /** dotted path to the offending node, e.g. `properties.pages.items` */
  where: string;
  message: string;
}

/**
 * Lookahead and lookbehind. The structured-output regex engine has neither and
 * rejects the WHOLE request, not just the pattern — so one guard clause in one
 * field takes down every call that sends the schema.
 */
const LOOKAROUND = /\((\?=|\?!|\?<=|\?<!)/;

/** Walk a JSON Schema, reporting what the API is known to reject. */
export function preflight(schema: unknown, rootName = "schema"): PreflightFinding[] {
  const out: PreflightFinding[] = [];

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    if (typeof o["pattern"] === "string" && LOOKAROUND.test(o["pattern"])) {
      out.push({
        level: "error", where: `${path}.pattern`,
        message:
          `regex uses lookahead/lookbehind, which the structured-output validator ` +
          `cannot compile — it rejects the entire request: ${o["pattern"]}`,
      });
    }

    /*
     * `additionalProperties: false` is REQUIRED on every object. The corollary
     * is the part that matters: there is no way to say "any object", so a schema
     * cannot leave a sub-object unconstrained. Both halves are reported, because
     * the second one is what makes people reach for `{ type: "object" }`.
     */
    if (o["type"] === "object") {
      if (o["additionalProperties"] !== false) {
        out.push({
          level: "error", where: path,
          message:
            `an object must set additionalProperties: false. There is no way to ` +
            `express "any object" in structured output — if the shape is genuinely ` +
            `open, send no schema and validate the reply instead.`,
        });
      }
      if (!o["properties"] || Object.keys(o["properties"] as object).length === 0) {
        out.push({
          level: "warn", where: path,
          message:
            `an object with no properties and additionalProperties: false can only ` +
            `ever match {}. That is almost never what was meant.`,
        });
      }
    }

    for (const [k, v] of Object.entries(o)) {
      if (k === "pattern" || k === "additionalProperties") continue;
      visit(v, path ? `${path}.${k}` : k);
    }
  };

  visit(schema, rootName);

  /*
   * SIZE — reported, never failed.
   *
   * "The compiled grammar is too large" is about the compiled state space, not
   * bytes, and we have exactly two data points: the descriptor schema alone
   * (~9.6 KB) is accepted; the same schema nested inside another is not. We
   * cannot derive a threshold from two points, and a made-up one would reject
   * working schemas. So this warns near the only size we have ever seen fail,
   * and says what it does not know.
   */
  /*
   * OPTIONAL PARAMETERS — a HARD limit, and the fourth 400 this file has learned
   * from. Measured 2026-08-28, on the first live call after the descriptor gained
   * the filter and button-control fields:
   *
   *   Schemas contains too many optional parameters (30), which would make
   *   grammar compilation inefficient. Reduce the number of optional parameters
   *   in your tool schemas (limit: 24).
   *
   * The API states the limit outright, so unlike size this is a rule and not a
   * guess — it is an `error`, and the count is exact rather than approximate.
   *
   * The WARN band matters as much as the limit. The descriptor sat at 22 of 24
   * for months with nobody aware there was a ceiling at all; a field added
   * innocently took it to 30 and killed every `--story` run at call 1. Warning
   * from 22 onward means the next person meets the cliff in a test rather than
   * in a 400.
   */
  const OPTIONAL_LIMIT = 24;
  const optionals: string[] = [];
  const countOptionals = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((n, i) => countOptionals(n, `${path}[${i}]`)); return; }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o["type"] === "object" && o["properties"] && typeof o["properties"] === "object") {
      const required = new Set((o["required"] as string[] | undefined) ?? []);
      for (const key of Object.keys(o["properties"] as object)) {
        if (!required.has(key)) optionals.push(`${path}.${key}`);
      }
    }
    for (const [k, v] of Object.entries(o)) countOptionals(v, path ? `${path}.${k}` : k);
  };
  countOptionals(schema, rootName);
  const optionalCount = new Set(optionals).size;

  if (optionalCount > OPTIONAL_LIMIT) {
    out.push({
      level: "error", where: rootName,
      message:
        `${optionalCount} optional parameters; the structured-output API rejects ` +
        `more than ${OPTIONAL_LIMIT} and refuses the whole request. Make a field ` +
        `required (an empty array or an explicit value often says more than an ` +
        `absent key anyway), or carry two related facts in one optional object.`,
    });
  } else if (optionalCount >= OPTIONAL_LIMIT - 2) {
    out.push({
      level: "warn", where: rootName,
      message:
        `${optionalCount} of ${OPTIONAL_LIMIT} optional parameters — at or near the ` +
        `hard limit. The next optional field added will break every call that ` +
        `sends this schema, at call 1, with a 400.`,
    });
  }

  const bytes = JSON.stringify(schema)?.length ?? 0;
  if (bytes > 9_000) {
    out.push({
      level: "warn", where: rootName,
      message:
        `${bytes} bytes. The only schema we have seen rejected as "compiled grammar ` +
        `too large" was the descriptor schema NESTED inside another; the descriptor ` +
        `schema alone (~9.6 KB) is accepted. The real limit is unknown — treat ` +
        `nesting a large schema inside another as the risk, not size alone.`,
    });
  }

  return out;
}

/** True when nothing the API is known to reject is present. */
export function isSendable(schema: unknown): boolean {
  return !preflight(schema).some((f) => f.level === "error");
}

export function formatFindings(findings: PreflightFinding[]): string {
  return findings
    .map((f) => `  [${f.level.toUpperCase()}] ${f.where}\n      ${f.message}`)
    .join("\n");
}
