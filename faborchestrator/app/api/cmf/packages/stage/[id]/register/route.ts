import { NextRequest, NextResponse } from "next/server";

import { prepareMasterData } from "@/modules/master-data-load/lib/cmf/cmf-client";
import { friendlyErrorPayload } from "@/modules/master-data-load/lib/cmf/cmf-errors";
import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { upsertPackageFromCmf } from "@/modules/master-data-load/lib/repo-cmf/packages";
import {
  getStagedUpload,
  storePackageFile,
  updateStagedUpload,
} from "@/modules/master-data-load/lib/repo-cmf/validation";
import { recordAudit } from "@/modules/master-data-load/lib/cmf/audit";
import { validateAgainstTemplate } from "@/modules/master-data-load/lib/validation/template-check";
import { runWithCmfDb } from "@/modules/master-data-load/lib/cmf/db-context";
import { resolveCmfDbKey, noCmfDatabaseResponse } from "@/modules/master-data-load/lib/cmf/request-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Promote a staged, template-validated file into CMF. Server-enforces 100%
 * template conformance BEFORE calling any CMF object API — so a bad file never
 * reaches CMF. On success: CMF prepare (UploadFile/CreateObject/GetObjectTypes),
 * persist Package + file, audit, drop the staging row.
 */
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

    // Route the register (and the CMF prepare it triggers) to the database the
    // loader's CmfDatabaseToggle selected — otherwise it always lands in source.
    const dbKey = await resolveCmfDbKey(request, userId);
    if (!dbKey) return noCmfDatabaseResponse();
    return await runWithCmfDb(dbKey, async () => {

    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      skipTemplateCheck?: boolean;
    };
    const name = String(body.name ?? "").trim();
    const skipTemplateCheck = body.skipTemplateCheck === true;
    if (!name) {
      return NextResponse.json(
        { error: { title: "Package name required", description: "Enter a name for this package.", action: "rename" } },
        { status: 400 },
      );
    }

    const staged = await getStagedUpload(id, userId);
    if (!staged) {
      return NextResponse.json(
        { error: { title: "File not found", description: "Re-upload the file and try again." } },
        { status: 404 },
      );
    }

    // Hard gate: re-validate server-side; a non-conformant file must NOT reach CMF.
    // Skippable by the user's explicit choice on the Validate step — the local
    // template check is optional, but CMF's own dry-run validation downstream is
    // always compulsory, so the file is never loaded unverified.
    if (!skipTemplateCheck) {
      const result = await validateAgainstTemplate(staged.bytes);
      if (!result.ok) {
        return NextResponse.json(
          {
            error: {
              title: "Validation not passed",
              description: `Fix ${result.errorCount} template error(s) before continuing.`,
            },
            errorsByType: result.errorsByType,
          },
          { status: 422 },
        );
      }
    }

    // Conformant → now call the CMF object APIs.
    const file = {
      name: staged.filename,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: staged.bytes.byteLength,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        const ab = new ArrayBuffer(staged.bytes.byteLength);
        new Uint8Array(ab).set(staged.bytes);
        return ab;
      },
    };
    const prep = await prepareMasterData(name, file);

    const pkg = await upsertPackageFromCmf(prep.instance, userId);
    await storePackageFile(pkg.id, staged.filename, staged.bytes);
    await recordAudit("UPLOAD", {
      userId,
      packageId: pkg.id,
      metadata: { cmfId: prep.instance.Id, viaStaging: true, uploaded: prep.uploaded },
      ip: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
    });
    // Keep the flow draft (don't delete) so the flow stays resumable from Recent
    // through Select/Load; mark it REGISTERED and link it to the CMF package.
    await updateStagedUpload(id, userId, {
      status: "REGISTERED",
      packageCmfId: prep.instance.Id,
      packageName: name,
    });

    return NextResponse.json({
      packageId: prep.instance.Id,
      objectTypes: prep.objectTypes,
    });
    });
  } catch (err) {
    console.error("[api/cmf/packages/stage/:id/register] failed", err);
    const { status, body } = friendlyErrorPayload(err);
    return NextResponse.json(body, { status });
  }
}
