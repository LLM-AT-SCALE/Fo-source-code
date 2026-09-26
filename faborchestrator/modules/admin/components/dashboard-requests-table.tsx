"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminToolbar, AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { RequestStatusBadge, ageOf } from "@/modules/admin/components/request-status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { toast } from "sonner";
import { Inbox, Loader2 } from "lucide-react";
import { REQUEST_STATUSES } from "@/modules/admin/lib/dashboards/dashboard-requests";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

type Row = {
  id: string;
  title: string;
  requester: { id: string; name: string | null; email: string | null };
  reason: string;
  kpiCount: number;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  dashboardId: string | null;
};

const POLL_MS = 15_000;

const selectClass =
  "flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * The dashboard-request queue: status filter, 15 s polling, row click opens
 * /admin/dashboard-requests/[id]. `onPendingCount` reports the server's count
 * of requests awaiting an admin action on every refresh.
 */
export function DashboardRequestsTable({ onPendingCount }: { onPendingCount?: (n: number) => void }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(
    async (quiet = false) => {
      if (!token) return;
      if (!quiet) setLoading(true);
      try {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        const res = await fetch(`/api/admin/dashboard-requests${qs}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        setRows(data.requests || []);
        const n = data.pendingCount ?? 0;
        setPending(n);
        onPendingCount?.(n);
      } catch {
        if (!quiet) toast.error("Failed to load dashboard requests");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [token, status, onPendingCount],
  );

  useEffect(() => {
    fetchData();
    const t = setInterval(() => fetchData(true), POLL_MS);
    return () => clearInterval(t);
  }, [fetchData]);

  const open = (id: string) => router.push(`/admin/dashboard-requests/${id}`);

  return (
    <>
      <AdminCollectionHeader title="Request queue" description="Select a request to review its preview and approval history." count={loading ? undefined : rows.length} />

      <AdminToolbar label="Filter dashboard requests">
        <span className="text-sm font-medium">Status</span>
        <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
      </AdminToolbar>

      {pending > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{pending}</span> request{pending === 1 ? "" : "s"} awaiting an admin action.
        </p>
      )}

      <div className="admin-table-surface" role="region" aria-label="Dashboard requests" tabIndex={0}>
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Requester</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">KPIs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  <Inbox className="mx-auto mb-2 h-5 w-5" />
                  No dashboard requests{status ? ` with status "${status.replace(/_/g, " ")}"` : " yet"}.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => open(r.id)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open(r.id);
                  }}
                >
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell>
                    <div className="text-sm">{r.requester.name || r.requester.email || r.requester.id.slice(0, 8)}</div>
                    {r.requester.name && r.requester.email && <div className="text-xs text-muted-foreground">{r.requester.email}</div>}
                  </TableCell>
                  <TableCell className="max-w-[320px] truncate text-sm text-muted-foreground" title={r.reason}>{r.reason}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.kpiCount}</TableCell>
                  <TableCell><RequestStatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground" title={new Date(r.createdAt).toLocaleString()}>{ageOf(r.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
