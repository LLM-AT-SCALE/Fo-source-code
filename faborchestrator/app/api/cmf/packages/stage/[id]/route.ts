import { NextRequest, NextResponse } from "next/server";

import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { getStagedMeta, updateStagedUpload, type FlowStatus } from "@/modules/master-data-load/lib/repo-cmf/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fetch a flow draft's metadata so the wizard can resume it at the right step. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json(
      { error: { title: "Not signed in", description: "Sign in to continue." } },
      { status: 401 },
    );
  }
  const { id } = await params;
  const meta = await getStagedMeta(id, userId);
  if (!meta) {
    return NextResponse.json(
      { error: { title: "Flow not found", description: "It may have been completed or removed." } },
      { status: 404 },
    );
  }
  return NextResponse.json(meta);
}

/** Persist wizard progress on a flow draft (step status and chosen types). */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json(
      { error: { title: "Not signed in", description: "Sign in to continue." } },
      { status: 401 },
    );
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    status?: FlowStatus;
    selectedTypes?: string[];
  };
  await updateStagedUpload(id, userId, {
    status: body.status,
    selectedTypes: Array.isArray(body.selectedTypes) ? body.selectedTypes : undefined,
  });
  return NextResponse.json({ ok: true });
}
