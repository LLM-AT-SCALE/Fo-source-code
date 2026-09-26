import { prisma } from "@/shared/lib/db";
import type { MasterDataPackage } from "@/modules/master-data-load/lib/cmf/types";
import { decideRunCompletion } from "@/modules/master-data-load/lib/cmf/run-completion";
import { getPackageByCmfId } from "@/modules/master-data-load/lib/repo-cmf/packages";
import { getOpenRunForPackage, completeRun, expireStaleRuns } from "@/modules/master-data-load/lib/repo-cmf/runs";
import { markFlowLoaded } from "@/modules/master-data-load/lib/repo-cmf/validation";

/**
 * Best-effort: given a freshly-fetched CMF instance, if we have a local
 * package with an open run and CMF now reports a *new* completion, close the
 * run and stamp the package. Safe to call on every GET poll; a no-op once the
 * run is closed. Never throws into the caller.
 */
export async function reconcileRunFromCmf(
  instance: MasterDataPackage,
): Promise<void> {
  try {
    await expireStaleRuns();

    const pkg = await getPackageByCmfId(instance.Id);
    if (!pkg) return;

    const open = await getOpenRunForPackage(pkg.id);
    if (!open) return;

    const decision = decideRunCompletion(open.cmfBaselineEndDate, instance);
    if (!decision) return;

    await completeRun(open.id, decision);
    await prisma.package.update({
      where: { id: pkg.id },
      data: {
        lastResult: decision.result,
        lastOperation: open.operation,
        lastRunAt: new Date(),
      },
    });

    // A successful LOAD completes the flow → drop its draft out of "in progress".
    if (open.operation === "LOAD" && decision.result === 0) {
      await markFlowLoaded(instance.Id);
    }
  } catch (err) {
    console.error("[reconcile] failed", err);
  }
}
