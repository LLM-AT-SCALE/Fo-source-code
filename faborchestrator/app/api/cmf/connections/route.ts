import { NextRequest, NextResponse } from "next/server";

import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { listEnabledConnections } from "@/modules/master-data-load/lib/cmf/db-registry";
import { getUserCmfAccess } from "@/modules/master-data-load/lib/cmf/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List the selectable CMF databases for the `CmfDatabaseToggle` and the
 * Master Data Load agent's health pill.
 *
 * Returns the ENABLED admin-managed connections (`cmf_connections`) the user is
 * granted (admins see all) as `{ key, label }`, plus `available` — how many
 * enabled connections exist at all — so the UI can tell "an admin has not added
 * any database yet" from "none is granted to you". There is no built-in
 * fallback: an empty table is an empty list.
 */
export async function GET(req: NextRequest) {
  const userId = await getSessionUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const [all, access] = await Promise.all([listEnabledConnections(), getUserCmfAccess(userId)]);
    const connections = access.all ? all : all.filter((c) => access.keys.has(c.key));
    return NextResponse.json({ connections, available: all.length });
  } catch (e) {
    console.error("[api/cmf/connections] list failed", e);
    return NextResponse.json(
      { error: "The database connections could not be loaded. Try again in a moment." },
      { status: 503 },
    );
  }
}
