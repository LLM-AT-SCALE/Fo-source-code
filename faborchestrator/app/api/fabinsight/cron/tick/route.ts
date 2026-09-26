/**
 * Scheduled-refresh heartbeat for the Recent Reports.
 *
 * Called every few minutes by an external trigger (AWS EventBridge → API
 * destination / Lambda). Machine-to-machine, NOT user auth: gated by a shared
 * secret header `x-cron-secret` matching env `FABINSIGHT_CRON_SECRET`.
 *
 * The heartbeat cadence is fixed; the effective per-dashboard interval is
 * DB-driven (report_schedules, editable from the admin chat), so this endpoint
 * just claims whatever is due now and refreshes each due dashboard's pins.
 */

import { NextRequest, NextResponse } from "next/server";

import { runDueReportRefresh } from "@/modules/fabinsight/lib/refresh";
import { runExpiry } from "@/modules/fabinsight/lib/expiry";
import { claimCompileJobs } from "@/modules/fabinsight/lib/compiler/job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manual / external trigger for the report-refresh pass. The primary trigger is
 * now the in-app timer (see instrumentation.ts); this endpoint stays as a
 * secret-gated way to force a refresh on demand. Same shared logic either way.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.FABINSIGHT_CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron refresh not configured" }, { status: 503 });
  }
  if (request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  try {
    // Same stages as the in-app tick: claim compile jobs (non-blocking), then refresh + expiry.
    const compile = await claimCompileJobs({ max: 2 });
    const out = await runDueReportRefresh(now);
    const expiry = await runExpiry(now);
    return NextResponse.json({ ok: true, at: now.toISOString(), ...out, compile, expiry });
  } catch (err) {
    console.error("[api/fabinsight/cron/tick] failed", err);
    return NextResponse.json({ error: "cron tick failed" }, { status: 500 });
  }
}
