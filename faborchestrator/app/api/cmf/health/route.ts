import { NextRequest, NextResponse } from "next/server";

import { getSessionUserId } from "@/modules/master-data-load/lib/cmf/session";
import { cmfQuery } from "@/modules/master-data-load/lib/cmf/cmf-sql";
import { runWithCmfDb } from "@/modules/master-data-load/lib/cmf/db-context";
import { listEnabledConnections, NO_DATABASE_MESSAGE, profileFor, type CmfDbKey } from "@/modules/master-data-load/lib/cmf/db-registry";
import { getUserCmfAccess, grantedKeys } from "@/modules/master-data-load/lib/cmf/access";
import { resolveCmfDbKey } from "@/modules/master-data-load/lib/cmf/request-db";
// Side-effect import: installs the global undici dispatcher with the
// HOST_RESOLVER lookup (pins the CMF REST host to its private IP over the VPN)
// and the CMF TLS policy, so the REST probe below behaves like a real CMF call.
import "@/modules/master-data-load/lib/cmf/cmf-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CMF connectivity probe for the Master Data Loader's status indicator. The
 * loader can only reach CMF over the (Site-to-Site or corporate) VPN, so this
 * tells the UI whether the two paths it depends on are actually reachable:
 *   • SQL  — metadata + parent-key lookups used by validation
 *   • REST — register / validate / load
 * Both are bounded by a short timeout so the indicator never hangs, and each is
 * reported separately (SQL can be up while the REST host is firewall-blocked).
 */

// CMF SQL is a named instance behind the VPN. A COLD connect pays SQL Browser
// (UDP 1434) discovery + a dynamic-port handshake — ~20s, per cmf-sql.ts (whose
// connectionTimeout defaults to 20000 and is deliberately NOT shortened). The
// probe must allow for that, or it reports a FALSE "SQL down" every time the pool
// is cold (e.g. right after a deploy). Once the pool is warm, `SELECT 1` returns
// in <1s, so steady-state checks are fast. REST is a plain HTTPS round-trip over
// the VPN, so a shorter budget is fine.
const SQL_TIMEOUT_MS = Number(process.env.CMF_HEALTH_SQL_TIMEOUT_MS ?? "23000");
const REST_TIMEOUT_MS = Number(process.env.CMF_HEALTH_REST_TIMEOUT_MS ?? "12000");

type Probe = { ok: boolean; ms: number; status?: number; error?: string };

function shortErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function probeSql(): Promise<Probe> {
  const started = Date.now();
  try {
    await withTimeout(cmfQuery("SELECT 1 AS ok"), SQL_TIMEOUT_MS, "CMF SQL");
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: shortErr(e) };
  }
}

async function probeRest(dbKey: CmfDbKey): Promise<Probe> {
  const started = Date.now();
  try {
    const base = profileFor(dbKey).baseUrl;
    if (!base) return { ok: false, ms: 0, error: `CMF base URL is not set for "${dbKey}"` };
    // Any HTTP response (even 401/404/405) proves the host answered → reachable.
    // Only a network error / timeout means the VPN path is down.
    const res = await fetch(base, {
      method: "HEAD",
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    return { ok: true, ms: Date.now() - started, status: res.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: shortErr(e) };
  }
}

export async function GET(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json(
      { error: { title: "Not signed in", description: "Sign in to continue." } },
      { status: 401 },
    );
  }

  // Which CMF database to probe: `?db=<db_key>` (the health pill checks each
  // granted connection by key), else the one the user's toggle/preference
  // selects (the loader's status indicator). Only ENABLED connections the user
  // is granted can be probed. With no database there is nothing to check and
  // the answer says so — no probe runs against an env default.
  const dbParam = request.nextUrl.searchParams.get("db") ?? "";
  let dbKey: CmfDbKey | null;
  if (dbParam) {
    const enabled = (await listEnabledConnections()).map((c) => c.key);
    const access = await getUserCmfAccess(userId);
    dbKey = grantedKeys(access, enabled).includes(dbParam) ? dbParam : null;
    if (!dbKey) {
      return NextResponse.json(
        { error: { title: "Unknown database", description: `"${dbParam}" is not an enabled database connection you have access to.` } },
        { status: 404 },
      );
    }
  } else {
    dbKey = await resolveCmfDbKey(request, userId);
  }
  if (!dbKey) {
    return NextResponse.json({
      ok: false,
      db: null,
      noDatabase: true,
      message: NO_DATABASE_MESSAGE,
      checkedAt: new Date().toISOString(),
    });
  }

  // Run both probes under the selected DB's context so cmfQuery hits the right
  // SQL pool and the REST probe hits the right base URL.
  const key = dbKey;
  const [sql, rest] = await runWithCmfDb(key, () =>
    Promise.all([probeSql(), probeRest(key)]),
  );
  return NextResponse.json({
    ok: sql.ok && rest.ok,
    db: dbKey,
    sql,
    rest,
    checkedAt: new Date().toISOString(),
  });
}
