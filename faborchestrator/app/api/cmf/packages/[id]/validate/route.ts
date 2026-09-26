import { NextRequest, NextResponse } from "next/server";

import { getObjectById, queueMasterDataExecution } from "@/modules/master-data-load/lib/cmf/cmf-client";
import { friendlyErrorPayload } from "@/modules/master-data-load/lib/cmf/cmf-errors";
import type { UserFriendlyObjectType } from "@/modules/master-data-load/lib/cmf/types";
import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { upsertPackageFromCmf } from "@/modules/master-data-load/lib/repo-cmf/packages";
import {
  createRun,
  failRun,
  expireStaleRuns,
  getOpenRunForPackage,
  isOpenRunConflict,
} from "@/modules/master-data-load/lib/repo-cmf/runs";
import { recordAudit } from "@/modules/master-data-load/lib/cmf/audit";
import { runWithCmfDb } from "@/modules/master-data-load/lib/cmf/db-context";
import { resolveCmfDbKey, noCmfDatabaseResponse } from "@/modules/master-data-load/lib/cmf/request-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getSessionUserId(request);
    if (!userId) {
      return NextResponse.json(
        { error: { title: "Not signed in", description: "Sign in to continue." } },
        { status: 401 },
      );
    }

    // Dry-run (op=1) against the database the loader toggle selected.
    const dbKey = await resolveCmfDbKey(request, userId);
    if (!dbKey) return noCmfDatabaseResponse();
    return await runWithCmfDb(dbKey, async () => {

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as
      | { selectedTypes?: UserFriendlyObjectType[] }
      | null;
    const selectedTypes = body?.selectedTypes;

    if (!Array.isArray(selectedTypes) || selectedTypes.length === 0) {
      return NextResponse.json(
        {
          error: {
            title: "No object types selected",
            description:
              "Choose at least one object type from the list before running Validate.",
            action: "select-types",
          },
        },
        { status: 400 },
      );
    }

    // Fetch current CMF state to mirror the package and capture the
    // completion baseline before this run starts.
    const instance = await getObjectById(id);
    const pkg = await upsertPackageFromCmf(instance, userId);

    // Guard against concurrent runs on the same package. Fast pre-check, then
    // the DB partial-unique index is the atomic backstop against same-instant
    // duplicate submits (catch the unique violation below).
    const conflict = NextResponse.json(
      {
        error: {
          title: "A run is already in progress",
          description:
            "Wait for the current validate or load on this package to finish before starting another.",
        },
      },
      { status: 409 },
    );
    await expireStaleRuns();
    if (await getOpenRunForPackage(pkg.id)) return conflict;

    let run;
    try {
      run = await createRun({
        packageId: pkg.id,
        userId,
        operation: "VALIDATE",
        selectedTypes,
        cmfBaselineEndDate: instance.LastExecutionEndDate ?? null,
      });
    } catch (e) {
      if (isOpenRunConflict(e)) return conflict;
      throw e;
    }

    try {
      // op=1 is the non-committing (validate/dry-run) operation in this CMF
      // deployment — it reports counts without persisting. op=0 commits (Load).
      // See ExecutionOperation in lib/types.ts.
      await queueMasterDataExecution(id, 1, selectedTypes);
    } catch (queueErr) {
      await failRun(
        run.id,
        queueErr instanceof Error ? queueErr.message : String(queueErr),
      );
      throw queueErr;
    }

    await recordAudit("VALIDATE", {
      userId,
      packageId: pkg.id,
      runId: run.id,
      metadata: { selectedCount: selectedTypes.length },
    });

    return NextResponse.json(
      { packageId: id, runId: run.id, queued: true },
      { status: 202 },
    );
    });
  } catch (err) {
    console.error("[api/cmf/packages/:id/validate] failed", err);
    const { status, body } = friendlyErrorPayload(err);
    return NextResponse.json(body, { status });
  }
}
