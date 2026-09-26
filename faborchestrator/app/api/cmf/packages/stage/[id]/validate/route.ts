import { NextRequest, NextResponse } from "next/server";

import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { getStagedUpload, updateStagedUpload } from "@/modules/master-data-load/lib/repo-cmf/validation";
import { validateSheetsComprehensive, readUploadSheets } from "@/modules/master-data-load/lib/validation/template-check";
import { explainErrors } from "@/modules/master-data-load/lib/validation/llm-advisor";
import { friendlyErrorPayload } from "@/modules/master-data-load/lib/cmf/cmf-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Validate a staged file against the master-data template (structure / columns).
 * Template-conformance check only — no CMF round-trips, no rule-engine R1–R6,
 * no cross-checks. Returns exact errors. The flow blocks Load/register
 * until this returns ok=true.
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

    const { id } = await params;
    const staged = await getStagedUpload(id, userId);
    if (!staged) {
      return NextResponse.json(
        { error: { title: "File not found", description: "Re-upload the file and try again." } },
        { status: 404 },
      );
    }

    // Read once (streaming), reuse the sheets for validation and LLM explanations.
    let sheets;
    try {
      sheets = await readUploadSheets(staged.bytes);
    } catch (parseErr) {
      console.error("[api/cmf/packages/stage/:id/validate] could not parse workbook", parseErr);
      // Say what the reader objected to: a password-protected or truncated
      // file and an .xls renamed to .xlsx each fail differently.
      const reason = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return NextResponse.json({
        ok: false,
        errorCount: 1,
        warningCount: 0,
        infoCount: 0,
        errorsByType: {
          File: [
            {
              objectType: "File",
              row: null,
              column: null,
              severity: "error",
              message: `The file could not be read as an Excel workbook (${reason.slice(0, 200)}). Re-export it as .xlsx and try again.`,
            },
          ],
        },
        explanations: [],
      });
    }
    // Comprehensive check in ONE pass — empty-file, no-data, and EVERY required
    // field across every sheet/row (all mandatory fields from CMF metadata, not
    // just Name), so the user sees all problems at once. Everything else
    // (order, referential integrity) is left to CMF's own dry-run, which runs next.
    const result = await validateSheetsComprehensive(sheets);

    // Record progress so an interrupted flow resumes at the right step.
    await updateStagedUpload(id, userId, { status: result.ok ? "VALIDATED" : "UPLOADED" });

    // When there are errors, ask the LLM to explain each one with its exact
    // location and a concrete fix — best-effort, never gates the block.
    let explanations: Awaited<ReturnType<typeof explainErrors>>["errors"] = [];
    if (!result.ok) {
      try {
        explanations = (await explainErrors(sheets, result.errorsByType)).errors;
      } catch (err) {
        console.error("[api/cmf/packages/stage/:id/validate] explanation failed", err);
      }
    }

    return NextResponse.json({
      ok: result.ok,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      infoCount: result.infoCount,
      errorsByType: result.errorsByType,
      explanations,
    });
  } catch (err) {
    // The staged file is read back from S3 and the required-field check reads
    // CMF metadata over SQL: either can fail, and "Please try again" said
    // nothing about which. The capture names the system; relay it.
    console.error("[api/cmf/packages/stage/:id/validate] failed", err);
    const { status, body } = friendlyErrorPayload(err);
    return NextResponse.json(body, { status });
  }
}
