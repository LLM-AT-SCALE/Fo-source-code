import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  version_no: number | null;
  visible_to_all: boolean;
  visibility_role_ids: unknown;
  visibility_user_ids: unknown;
  expires_at: Date | null;
  refreshed_at: Date | null;
  last_status: string | null;
  requester_id: string | null;
  created_at: Date;
  sched_next_run_at: Date | null;
  sched_enabled: boolean | null;
  sched_last_status: string | null;
  sched_frequency: string | null;
};

/**
 * GET /api/admin/dashboards — every dashboard joined with its report schedule
 * (by slug) and current version number. List only; actions come with B5.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT d.id, d.slug, d.title, d.kind, d.status, v.version_no,
              d.visible_to_all, d.visibility_role_ids, d.visibility_user_ids,
              d.expires_at, d.refreshed_at, d.last_status, d.requester_id, d.created_at,
              s.next_run_at AS sched_next_run_at, s.enabled AS sched_enabled,
              s.last_status AS sched_last_status, s.frequency AS sched_frequency
         FROM dashboards d
         LEFT JOIN dashboard_versions v ON v.id = d.current_version_id
         LEFT JOIN report_schedules s ON s.dashboard_id = d.slug
        ORDER BY d.title ASC`,
    );

    const roleIds = new Set<string>();
    for (const r of rows) if (Array.isArray(r.visibility_role_ids)) for (const x of r.visibility_role_ids) if (typeof x === "string") roleIds.add(x);
    const roles = roleIds.size
      ? await prisma.role.findMany({ where: { id: { in: [...roleIds] } }, select: { id: true, name: true } })
      : [];
    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    return NextResponse.json({
      dashboards: rows.map((r) => {
        const rIds = Array.isArray(r.visibility_role_ids) ? (r.visibility_role_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const uIds = Array.isArray(r.visibility_user_ids) ? (r.visibility_user_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        return {
          id: r.id,
          slug: r.slug,
          title: r.title,
          kind: r.kind,
          status: r.status,
          versionNo: r.version_no,
          visibility: {
            all: r.visible_to_all,
            roleNames: rIds.map((x) => roleName.get(x) ?? x),
            userCount: uIds.length,
          },
          expiresAt: r.expires_at,
          refreshedAt: r.refreshed_at,
          lastStatus: r.last_status,
          createdAt: r.created_at,
          schedule: r.sched_frequency
            ? { nextRunAt: r.sched_next_run_at, enabled: !!r.sched_enabled, lastStatus: r.sched_last_status, frequency: r.sched_frequency }
            : null,
        };
      }),
    });
  } catch (e) {
    console.error("[api/admin/dashboards] GET failed", e);
    return NextResponse.json({ error: "Could not load dashboards." }, { status: 500 });
  }
}
