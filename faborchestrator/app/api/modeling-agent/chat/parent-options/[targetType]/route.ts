import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/shared/lib/auth-middleware";
import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { loadRuleset } from "@/modules/master-data-load/lib/validation/metadata";
import { toFriendly } from "@/modules/master-data-load/lib/cmf/cmf-errors";
import { runWithCmfDb } from "@/modules/master-data-load/lib/cmf/db-context";
import { resolveCmfDbKey } from "@/modules/master-data-load/lib/cmf/request-db";
import { NO_DATABASE_MESSAGE } from "@/modules/master-data-load/lib/cmf/db-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List existing parent-record names for a given object type. Used by the
 * inline EntryForm component to populate FK column dropdowns (Facility,
 * Product, ProductGroup, etc.) with what's already in CMF.
 *
 * Read-only. Capped at MAX_OPTIONS rows to keep dropdowns responsive — when a
 * parent table has more rows than the cap, the response includes `truncated:
 * true` so the UI can fall back to a typeable input.
 */
const MAX_OPTIONS = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ targetType: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { targetType } = await params;
  // The dropdown reads the database the user's toggle/preference selects. With
  // no database the form falls back to a typeable input and says why.
  const dbKey = await resolveCmfDbKey(request, auth.user.id);
  if (!dbKey) {
    return NextResponse.json({ options: [], reason: "no-database", error: NO_DATABASE_MESSAGE, targetType }, { status: 200 });
  }
  try {
    return await runWithCmfDb(dbKey, async () => {
    const ruleset = await loadRuleset(targetType);
    if (!ruleset?.table) {
      return NextResponse.json({ options: [], reason: "no-table" }, { status: 200 });
    }

    // Order by Name so the dropdown is alphabetical; cap at MAX_OPTIONS+1 so we
    // can detect truncation cheaply.
    const rows = await cmfQuery<{ Name: string }>(
      `select top ${MAX_OPTIONS + 1} Name from [${ruleset.table.schema}].[${ruleset.table.name}] order by Name`,
    );
    const truncated = rows.length > MAX_OPTIONS;
    const options = rows.slice(0, MAX_OPTIONS).map((r) => String(r.Name));
    return NextResponse.json({ options, truncated, targetType });
    });
  } catch (err) {
    // The form falls back to a typeable input and shows `error` as the reason
    // the dropdown is empty — so it must say what failed (the CMF database
    // over the VPN, nearly always), not just that it failed. cmfQuery captures
    // and records the failure; toFriendly keeps its real message.
    console.error(`[api/cmf/chat/parent-options/${targetType}] failed`, err);
    const f = toFriendly(err);
    return NextResponse.json(
      { error: `${f.title}: ${f.description}`, errorId: f.errorId, options: [] },
      { status: f.httpStatus },
    );
  }
}
