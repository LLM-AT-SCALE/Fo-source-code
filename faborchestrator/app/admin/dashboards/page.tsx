"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AdminPage, AdminCollection, AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { AdminDetailTabs, AdminDetailPanel } from "@/modules/admin/components/admin-detail-tabs";
import { DashboardRequestsTable } from "@/modules/admin/components/dashboard-requests-table";
import { Badge } from "@/shared/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { toast } from "sonner";
import { LayoutGrid, Loader2 } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

type Row = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  versionNo: number | null;
  visibility: { all: boolean; roleNames: string[]; userCount: number };
  expiresAt: string | null;
  refreshedAt: string | null;
  lastStatus: string | null;
  createdAt: string;
  schedule: { nextRunAt: string | null; enabled: boolean; lastStatus: string | null; frequency: string } | null;
};

type Tab = "requests" | "dashboards";
const TABS: Tab[] = ["requests", "dashboards"];
const isTab = (v: string | null): v is Tab => !!v && (TABS as string[]).includes(v);

const SEVEN_DAYS = 7 * 86_400_000;

function StatusBadge({ status }: { status: string }) {
  if (status === "live") return <Badge variant="success">Live</Badge>;
  if (status === "paused") return <Badge variant="warning">Paused</Badge>;
  if (status === "expired") return <Badge variant="destructive">Expired</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function visibilityText(v: Row["visibility"]): string {
  if (v.all) return "Everyone";
  const parts: string[] = [];
  if (v.roleNames.length) parts.push(v.roleNames.join(", "));
  if (v.userCount) parts.push(`${v.userCount} user${v.userCount === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" + ") : "Requester only";
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** The live-dashboard library table (the former Dashboards page body). */
function DashboardsTable() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/dashboards", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setRows(data.dashboards || []);
    } catch {
      toast.error("Failed to load dashboards");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const now = Date.now();

  return (
    <>
      <AdminCollectionHeader title="Dashboard library" description="Select a dashboard to manage its schedule, visibility, and versions." count={loading ? undefined : rows.length} />

      <div className="admin-table-surface" role="region" aria-label="Dashboards" tabIndex={0}>
        <Table className="min-w-[960px]">
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Version</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Last refresh</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <LayoutGrid className="mx-auto mb-2 h-5 w-5" />
                  No dashboards yet. Approve a dashboard request to create one.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const expMs = r.expiresAt ? new Date(r.expiresAt).getTime() : null;
                const soon = expMs !== null && expMs - now < SEVEN_DAYS;
                return (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => router.push(`/admin/dashboards/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") router.push(`/admin/dashboards/${r.id}`);
                    }}
                  >
                    <TableCell>
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.slug}
                        {r.kind === "seeded" && " · seeded"}
                      </div>
                    </TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{r.versionNo ?? "—"}</TableCell>
                    <TableCell className="max-w-[240px] truncate text-sm" title={visibilityText(r.visibility)}>{visibilityText(r.visibility)}</TableCell>
                    <TableCell className={soon ? "text-sm font-medium text-amber-600" : "text-sm text-muted-foreground"} title={r.expiresAt ? fmt(r.expiresAt) : undefined}>
                      {r.expiresAt ? (expMs! < now ? "Expired" : fmt(r.expiresAt)) : "Never"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.schedule ? (
                        r.schedule.enabled ? (
                          <>
                            {fmt(r.schedule.nextRunAt)}
                            <div className="text-xs">{r.schedule.frequency}</div>
                          </>
                        ) : (
                          "Schedule paused"
                        )
                      ) : (
                        "No schedule"
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" title={r.lastStatus ?? undefined}>
                      {fmt(r.refreshedAt)}
                      {r.lastStatus && <div className="max-w-[200px] truncate text-xs">{r.lastStatus}</div>}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * Dashboards workspace: the request queue and the live-dashboard library as
 * two tabs. The tab lives in the URL (?tab=requests|dashboards); without one,
 * Requests opens when something is awaiting an admin, else Dashboards.
 */
function DashboardsWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTab] = useState<Tab | null>(isTab(urlTab) ? urlTab : null);
  const [pending, setPending] = useState<number | null>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  // Follow the URL when it changes (back/forward, sidebar link).
  useEffect(() => {
    if (isTab(urlTab)) setTab(urlTab);
  }, [urlTab]);

  // Pending count for the tab label and the default tab.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/admin/dashboard-requests?count=1", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { pendingCount?: number } | null) => {
        if (cancelled) return;
        const n = typeof j?.pendingCount === "number" ? j.pendingCount : 0;
        setPending(n);
        setTab((t) => t ?? (n > 0 ? "requests" : "dashboards"));
      })
      .catch(() => {
        if (!cancelled) {
          setPending(0);
          setTab((t) => t ?? "dashboards");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const selectTab = (next: string) => {
    if (!isTab(next)) return;
    setTab(next);
    router.replace(`/admin/dashboards?tab=${next}`, { scroll: false });
  };

  const onPendingCount = useCallback((n: number) => setPending(n), []);

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="Configuration"
        title="Dashboards"
        description="Review dashboards users pinned from Fab Orchestrator chat, then manage the live library: schedule, visibility, versions and expiry."
      />

      <AdminDetailTabs
        id="dashboards"
        value={tab ?? ""}
        onChange={selectTab}
        items={[
          { id: "requests", label: "Requests", ...(pending ? { count: pending } : {}) },
          { id: "dashboards", label: "Dashboards" },
        ]}
      />

      {tab === null ? (
        <div className="py-10 text-center text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          <AdminDetailPanel id="dashboards" value="requests" active={tab}>
            <AdminCollection>
              {tab === "requests" && <DashboardRequestsTable onPendingCount={onPendingCount} />}
            </AdminCollection>
          </AdminDetailPanel>
          <AdminDetailPanel id="dashboards" value="dashboards" active={tab}>
            <AdminCollection>
              {tab === "dashboards" && <DashboardsTable />}
            </AdminCollection>
          </AdminDetailPanel>
        </>
      )}
    </AdminPage>
  );
}

export default function DashboardsPage() {
  return (
    <Suspense
      fallback={
        <AdminPage className="admin-workspace-collection">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </AdminPage>
      }
    >
      <DashboardsWorkspace />
    </Suspense>
  );
}
