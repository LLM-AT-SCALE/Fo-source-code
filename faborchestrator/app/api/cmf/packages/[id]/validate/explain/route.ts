import { NextRequest, NextResponse } from "next/server";

import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { getPackageByCmfId } from "@/modules/master-data-load/lib/repo-cmf/packages";
import { getPackageFileBytes } from "@/modules/master-data-load/lib/repo-cmf/validation";
import { readUploadSheets } from "@/modules/master-data-load/lib/validation/template-check";
import { explainCmfErrors } from "@/modules/master-data-load/lib/validation/llm-advisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enrich CMF's terse validation errors into pinpointed problem / why / fix,
 * cross-referenced with the uploaded file. Best-effort: returns an empty
 * `explanations` array on any failure (never blocks the gate).
 */
export async function POST(
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
    errors?: { objectType: string; message: string }[];
  };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length === 0) return NextResponse.json({ explanations: [] });

  try {
    const pkg = await getPackageByCmfId(id);
    if (!pkg) return NextResponse.json({ explanations: [] });
    const bytes = await getPackageFileBytes(pkg.id);
    if (!bytes) return NextResponse.json({ explanations: [] });
    const sheets = await readUploadSheets(bytes);
    const { errors: explanations } = await explainCmfErrors(sheets, errors);
    return NextResponse.json({ explanations });
  } catch (err) {
    console.error("[api/cmf/packages/:id/validate/explain] failed", err);
    return NextResponse.json({ explanations: [] });
  }
}
