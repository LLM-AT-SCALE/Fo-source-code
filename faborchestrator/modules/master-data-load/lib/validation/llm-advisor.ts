import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { ParsedSheet, ValidationError } from "@/modules/master-data-load/lib/validation/types";

/**
 * Advisory LLM config. These are best-effort, non-blocking calls, so they must
 * fail fast rather than hang the validation response:
 *  - MODEL: a current, fast model (the old claude-opus-4-20250514 is deprecated
 *    and slow). Override with VALIDATION_LLM_MODEL — e.g. claude-haiku-4-5 for
 *    the fastest explanations, or claude-sonnet-4-6 for a balance.
 *  - MAX_OUTPUT_TOKENS: capped well below the provider default (~32k) — error
 *    explanations are short, and a high cap inflates latency.
 *  - TIMEOUT_MS: a hard AbortSignal so a slow/unreachable API (e.g. blocked
 *    egress to api.anthropic.com on the VPN) can't stall the request.
 */
const MODEL = process.env.VALIDATION_LLM_MODEL ?? "claude-opus-4-8";
const MAX_OUTPUT_TOKENS = Number(process.env.VALIDATION_LLM_MAX_TOKENS ?? "8192");
const TIMEOUT_MS = Number(process.env.VALIDATION_LLM_TIMEOUT_MS ?? "20000");

/**
 * ADVISORY ONLY — never blocks. Uses Claude (via the Vercel AI SDK) to explain
 * the deterministic rule-engine failures in plain English and to surface soft
 * anomalies the rules don't cover. The rule engine remains the source of truth;
 * this layer is non-deterministic and must not gate Load. Any failure here is
 * swallowed and returns an empty advisory.
 */

/**
 * Per-error, location-pinpointed explanations. The deterministic checks already
 * know the exact sheet/row/column; this turns each into plain-English guidance a
 * data preparer can act on — the thing CMF's own portal never gives them.
 */
const explanationSchema = z.object({
  errors: z
    .array(
      z.object({
        objectType: z.string().describe("The sheet / object type the error is on"),
        row: z.number().nullable().describe("1-based data row, or null for a sheet-level issue"),
        column: z.string().nullable().describe("The column, or null for a sheet-level issue"),
        problem: z.string().describe("What is wrong — 1-2 clear sentences naming the exact location"),
        expected: z
          .string()
          .nullable()
          .describe("What the template requires here (e.g. the correct sheet name, column, position). null if not applicable"),
        found: z
          .string()
          .nullable()
          .describe("What the file actually has here (e.g. the wrong value/name). null if not applicable"),
        why: z.string().describe("Why it matters / why CMF would reject the load — 1-2 sentences"),
        howToFix: z.string().describe("A short summary line of the fix"),
        steps: z
          .array(z.string())
          .describe("Concrete ordered steps the preparer follows in Excel to fix this exact cell/sheet (1-4 steps)"),
      }),
    )
    .describe("One entry per validation error, in the same order, pinpointing its exact location"),
});

export type ErrorExplanations = z.infer<typeof explanationSchema>;

const EMPTY_EXPLANATIONS: ErrorExplanations = { errors: [] };

function summarize(sheets: ParsedSheet[]) {
  return sheets.map((s) => ({
    objectType: s.objectType,
    columns: s.headers,
    rowCount: s.rows.length,
    sample: s.rows.slice(0, 3),
  }));
}

/**
 * Explain each BLOCKING validation error with its exact location and a concrete
 * fix. Advisory-quality (best-effort): any failure returns empty so the
 * deterministic block still stands on its own. Requires ANTHROPIC_API_KEY.
 */
export async function explainErrors(
  sheets: ParsedSheet[],
  errorsByType: Record<string, ValidationError[]>,
): Promise<ErrorExplanations> {
  const flat = Object.values(errorsByType).flat().filter((e) => e.severity === "error");
  if (flat.length === 0) return EMPTY_EXPLANATIONS;
  if (!process.env.ANTHROPIC_API_KEY) return EMPTY_EXPLANATIONS;
  const model = MODEL;

  try {
    const { object } = await generateObject({
      model: anthropic(model),
      schema: explanationSchema,
      maxRetries: 1,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      prompt: [
        "You help a data preparer fix a Critical Manufacturing (CMF) master-data Excel file BEFORE it is loaded.",
        "CMF's own portal returns vague errors that don't say WHERE the problem is — your job is the opposite.",
        "A deterministic validator (the source of truth) already found the exact errors below, each with its sheet (objectType), row, and column.",
        "For EVERY error, in the SAME order, fill all fields: problem (plain language, naming the exact location), expected (what the template requires) vs found (what the file has) when applicable, why CMF would reject the load, a one-line howToFix summary, and an ordered list of concrete Excel steps the preparer should follow.",
        "Be specific and genuinely helpful — reference real sheet/column/position names and values from the data below. Thorough but not padded: no filler, no repeating the same sentence across fields.",
        "Do NOT invent new errors, change the verdict, or drop any.",
        "",
        "FILE SUMMARY (per object type):",
        JSON.stringify(summarize(sheets), null, 2),
        "",
        "VALIDATION ERRORS (exact locations — explain each one):",
        JSON.stringify(flat, null, 2),
      ].join("\n"),
    });
    return object;
  } catch (err) {
    console.error("[llm-advisor] error explanation failed (non-blocking)", err);
    return EMPTY_EXPLANATIONS;
  }
}

/**
 * Explain CMF's OWN validation errors (from `PerformMasterDataPackage` op=1).
 * CMF returns terse messages (type + reason, no row/fix); here we translate each
 * into exact location + why + concrete steps, **cross-referencing the file** so
 * we can spot things like a DataCollection whose parameter rows point at the
 * wrong name. Best-effort: returns empty on any failure.
 */
export async function explainCmfErrors(
  sheets: ParsedSheet[],
  cmfErrors: { objectType: string; message: string }[],
): Promise<ErrorExplanations> {
  if (cmfErrors.length === 0) return EMPTY_EXPLANATIONS;
  if (!process.env.ANTHROPIC_API_KEY) return EMPTY_EXPLANATIONS;
  const model = MODEL;

  // Include the sheets that actually have data (capped) so the LLM can
  // cross-reference values across sheets without an oversized prompt.
  const fileCtx = sheets
    .filter((s) => s.rows.length > 0)
    .map((s) => ({ objectType: s.objectType, columns: s.headers, rows: s.rows.slice(0, 50) }));

  try {
    const { object } = await generateObject({
      model: anthropic(model),
      schema: explanationSchema,
      maxRetries: 1,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      prompt: [
        "You help a data preparer fix a Critical Manufacturing (CMF) master-data Excel file.",
        "CMF's loader VALIDATE (a dry-run) returned the terse errors below — each names an object type and a reason, but NOT the offending row or how to fix it.",
        "Using the FILE CONTENTS, explain EACH error precisely: the exact sheet / row / column, the problem in plain language, why CMF rejects it, expected-vs-found where applicable, and concrete ordered steps to fix it in Excel.",
        "Cross-reference related sheets. Key cases: a `DataCollection` requires at least one row in the `DataCollectionParameters` sheet matched by name — 'Missing value for mandatory property DataCollectionParameters' usually means the DataCollection has no matching parameter rows (often a NAME MISMATCH between the DataCollection's Name and the DataCollection column in DataCollectionParameters). References (e.g. Product→ProductGroup) must exist.",
        "Be specific — reference the real names/values from the data. Do NOT invent or drop errors; one entry per CMF error, in the same order.",
        "",
        "CMF VALIDATION ERRORS:",
        JSON.stringify(cmfErrors, null, 2),
        "",
        "FILE CONTENTS (sheets that have data):",
        JSON.stringify(fileCtx, null, 2),
      ].join("\n"),
    });
    return object;
  } catch (err) {
    console.error("[llm-advisor] CMF error explanation failed (non-blocking)", err);
    return EMPTY_EXPLANATIONS;
  }
}
