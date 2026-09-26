/**
 * Live list of schedulable dashboards.
 *
 * Source of truth is the shared `dashboards` table (governed dashboards that
 * went live through the admin approval flow, plus the seeded ones). The admin
 * app reads it via raw SQL, like the other shared FabInsight tables.
 *
 * A schedule keys on (dashboard_id, source_key) where dashboard_id is the
 * dashboard's stable `slug` (seeded dashboards keep their legacy ids).
 */
import prisma from "@/shared/lib/db";

export type SchedulableDashboard = {
  id: string; // dashboards.slug (the schedule key)
  label: string; // dashboards.title
  kind: string; // "seeded" | "custom"
  status: string; // "live" | "paused"
  sourceKey: string;
  scheduled: boolean; // already has a report_schedules row
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Every dashboard the admin can schedule = live or paused dashboards, with a
 * flag for whether it already has a schedule. Empty when none exist yet.
 */
export async function getSchedulableDashboards(): Promise<SchedulableDashboard[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ slug: string; title: string; kind: string; status: string; source_key: string | null; scheduled: boolean }>
  >(
    `SELECT d.slug, d.title, d.kind, d.status,
            s.source_key,
            (s.dashboard_id IS NOT NULL) AS scheduled
       FROM dashboards d
       LEFT JOIN report_schedules s ON s.dashboard_id = d.slug
      WHERE d.status IN ('live', 'paused')
      ORDER BY d.title`,
  );
  return rows.map((r) => ({
    id: r.slug,
    label: r.title,
    kind: r.kind,
    status: r.status,
    sourceKey: r.source_key ?? "lumentum",
    scheduled: !!r.scheduled,
  }));
}

/** Resolve a user-supplied name/id (or "all") against the live list → dashboard ids. */
export function resolveAgainst(list: SchedulableDashboard[], input: string | string[]): string[] {
  const items = Array.isArray(input) ? input : [input];
  if (items.some((d) => norm(d) === "all")) return [...new Set(list.map((d) => d.id))];
  const ids: string[] = [];
  for (const raw of items) {
    const n = norm(raw);
    if (!n) continue;
    const hit =
      list.find((d) => norm(d.id) === n || norm(d.label) === n) ??
      list.find((d) => (n.length > 2 && norm(d.label).includes(n)) || norm(d.id).includes(n));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}
