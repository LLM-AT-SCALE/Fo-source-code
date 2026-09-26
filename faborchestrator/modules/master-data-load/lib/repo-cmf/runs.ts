import { Prisma } from "@/lib/generated/prisma/client";
import type { Operation } from "@/lib/generated/prisma/client";
import { prisma } from "@/shared/lib/db";
import type { RunCompletion } from "@/modules/master-data-load/lib/cmf/run-completion";

export function createRun(input: {
  packageId: string;
  userId: string;
  operation: Operation;
  selectedTypes: unknown;
  cmfBaselineEndDate: string | null;
}) {
  return prisma.run.create({
    data: {
      packageId: input.packageId,
      userId: input.userId,
      operation: input.operation,
      status: "QUEUED",
      selectedTypes: (input.selectedTypes ?? []) as Prisma.InputJsonValue,
      cmfBaselineEndDate: input.cmfBaselineEndDate,
    },
  });
}

/**
 * True if `err` is the unique-violation from the partial index that allows only
 * one in-flight (QUEUED/RUNNING) run per package — i.e. a concurrent duplicate
 * submit lost the race.
 */
export function isOpenRunConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export function getOpenRunForPackage(packageId: string) {
  return prisma.run.findFirst({
    where: { packageId, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Runs that never observed a completion (CMF never finished, or nobody polled)
 * are swept to FAILURE after this TTL so they don't block new runs forever.
 */
const STALE_RUN_TTL_MS = 15 * 60 * 1000;

/**
 * Mark any QUEUED/RUNNING run older than STALE_RUN_TTL_MS as FAILURE. Returns
 * the number of runs expired. Cheap and idempotent — safe to call on polls and
 * before queuing a new run.
 */
export async function expireStaleRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_TTL_MS);
  const { count } = await prisma.run.updateMany({
    where: { status: { in: ["QUEUED", "RUNNING"] }, startedAt: { lt: cutoff } },
    data: {
      // EXPIRED (not FAILURE) — a timeout is an operational outcome, not a
      // data-load failure, so it must not skew the success-rate metric.
      status: "EXPIRED",
      error: "Run timed out — no completion observed within the allowed window.",
      endedAt: now,
    },
  });
  return count;
}

export function failRun(runId: string, message: string) {
  return prisma.run.update({
    where: { id: runId },
    data: {
      status: "FAILURE",
      error: message,
      endedAt: new Date(),
    },
  });
}

export function completeRun(runId: string, patch: RunCompletion) {
  return prisma.run.update({
    where: { id: runId },
    data: {
      status: patch.status,
      result: patch.result,
      log: (patch.log ?? []) as Prisma.InputJsonValue,
      endedAt: new Date(),
    },
  });
}
