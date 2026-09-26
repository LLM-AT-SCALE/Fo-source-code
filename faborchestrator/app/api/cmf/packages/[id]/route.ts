import { NextRequest, NextResponse } from "next/server";

import { getObjectById, getObjectTypes } from "@/modules/master-data-load/lib/cmf/cmf-client";
import { friendlyErrorPayload } from "@/modules/master-data-load/lib/cmf/cmf-errors";
import { reconcileRunFromCmf } from "@/modules/master-data-load/lib/repo-cmf/reconcile";
import { requireAuth } from "@/shared/lib/auth-middleware";
import { runWithCmfDb } from "@/modules/master-data-load/lib/cmf/db-context";
import { resolveCmfDbKey, noCmfDatabaseResponse } from "@/modules/master-data-load/lib/cmf/request-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Next.js 16: route-handler `params` is a Promise — must be awaited.
//
// We also return `objectTypes` alongside `instance` so the detail page can
// render the object-type selector from a single fetch. `getObjectTypes`
// requires the freshly-loaded MDP (concurrency stamps) — we already have it
// from the preceding `getObjectById` call, so this is one extra round-trip.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const dbKey = await resolveCmfDbKey(request, auth.user.id);
  if (!dbKey) return noCmfDatabaseResponse();
  try {
    return await runWithCmfDb(dbKey, async () => {
    const { id } = await params;
    const instance = await getObjectById(id);
    await reconcileRunFromCmf(instance);
    const objectTypes = await getObjectTypes(instance);
    return NextResponse.json({ instance, objectTypes });
    });
  } catch (err) {
    console.error("[api/cmf/packages/:id] failed", err);
    const { status, body } = friendlyErrorPayload(err);
    return NextResponse.json(body, { status });
  }
}
