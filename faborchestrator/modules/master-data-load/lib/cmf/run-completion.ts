export type RunCompletion = {
  status: "SUCCESS" | "FAILURE";
  result: number | null;
  log: unknown;
};

type CmfExecutionState = {
  LastExecutionEndDate?: string | null;
  LastExecutionResult?: number;
  LastExecutionLog?: string;
};

const norm = (v?: string | null): string | null =>
  v == null || v === "" ? null : v;

/**
 * Decide whether an open run has completed, based purely on CMF-reported
 * state vs the end-date captured when the run was queued. Server-relative
 * (no client clock), so clock skew can't cause false positives/negatives.
 * Returns null while the run is still in flight.
 */
export function decideRunCompletion(
  baselineEndDate: string | null,
  instance: CmfExecutionState,
): RunCompletion | null {
  const end = norm(instance.LastExecutionEndDate);
  if (end == null || end === norm(baselineEndDate)) return null;

  const result = instance.LastExecutionResult ?? null;
  const status = result === 0 ? "SUCCESS" : "FAILURE";

  let log: unknown = [];
  try {
    const parsed = JSON.parse(instance.LastExecutionLog ?? "[]");
    log = Array.isArray(parsed) ? parsed : [];
  } catch {
    log = [];
  }
  return { status, result, log };
}
