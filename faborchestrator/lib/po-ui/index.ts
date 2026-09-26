/**
 * VALIDATOR — deterministic checks on a generated CMF UI Page artifact.
 *
 * FAIL  the artifact is broken or unsafe; must be fixed
 * WARN  suspicious; a human should look
 * PASS  verified
 *
 * Designed to run in a loop: feed failures back to the generator and regenerate.
 */
import { loadConventions } from "./conventions";
import { load } from "./load";
import {
  checkButtonInputs, checkColumnTypes, checkDataSourceUse, checkEnvelope,
  checkFilterCoverage, checkTermPaths, checkHostedCopies, checkIds, checkLabels,
  checkLayoutPlacement, checkPaths,
  checkReferences, checkSelection, checkSpecCoverage, checkPageIsWired,
  applyOrigin, type Origin,
} from "./checks";
import type { EffectiveSpec } from "./descriptor";
import type { Level, Result } from "./types";

export interface Report {
  results: Result[];
  counts: Record<Level, number>;
  ok: boolean;
}

export function validate(
  artifactPath: string,
  dictionaryPath?: string,
  /** the page the artifact is graded against; without it, spec coverage is skipped */
  spec?: EffectiveSpec,
  /**
   * Where the artifact came from (T-09). Defaults to "generated" — strict, and
   * byte-identical to the behaviour the Python oracle mirrors. Pass "external"
   * to validate a file CMF or the client produced, where a convention breach is
   * a WARN rather than a rejection.
   */
  opts?: { origin?: Origin },
): Report {
  const results: Result[] = [];

  const { root, rootTag, settings } = load(artifactPath, results);
  const conv = loadConventions();
  if (rootTag !== undefined) checkEnvelope(root, rootTag, conv, results);
  if (settings !== undefined) {
    checkIds(settings, results);
    checkReferences(settings, results);
    checkLabels(settings, results);
    checkPaths(settings, dictionaryPath, results);
    if (spec) {
      checkSpecCoverage(settings, spec, results);
      checkFilterCoverage(settings, spec, results);
      checkTermPaths(settings, spec, results);
      checkSelection(settings, spec, results);
    } else {
      results.push({ level: "WARN", name: "spec coverage not checked",
                     detail: "no descriptor supplied" });
    }

    checkColumnTypes(settings, results);
    checkButtonInputs(settings, results);
    checkDataSourceUse(settings, results);
    checkPageIsWired(settings, results);
    checkLayoutPlacement(settings, results);
    checkHostedCopies(settings, results);
  }

  const graded = applyOrigin(results, opts?.origin ?? "generated");

  const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of graded) counts[r.level] += 1;

  return { results: graded, counts, ok: counts.FAIL === 0 };
}

const ORDER: Record<Level, number> = { FAIL: 0, WARN: 1, PASS: 2 };
const MARK: Record<Level, string> = { FAIL: "[FAIL]", WARN: "[WARN]", PASS: "[ ok ]" };

/** stable sort by severity, matching the Python original's output order */
export function format(
  report: Report, artifact: string, dictionary: string,
  descriptor?: string, pageName?: string,
): string {
  const bar = "=".repeat(78);
  const lines = [bar, "VALIDATOR", `  artifact  : ${artifact}`, `  dictionary: ${dictionary}`];
  if (descriptor) lines.push(`  descriptor: ${descriptor} -> ${pageName ?? "?"}`);
  lines.push(bar, "");

  const sorted = report.results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ORDER[a.r.level] - ORDER[b.r.level] || a.i - b.i)
    .map(({ r }) => r);

  for (const { level, name, detail } of sorted) {
    lines.push(`  ${MARK[level]} ${name.padEnd(44)} ${detail.slice(0, 70)}`);
  }

  const { PASS, WARN, FAIL } = report.counts;
  lines.push("", bar, `  PASS ${PASS}   WARN ${WARN}   FAIL ${FAIL}`, bar);
  return lines.join("\n");
}
