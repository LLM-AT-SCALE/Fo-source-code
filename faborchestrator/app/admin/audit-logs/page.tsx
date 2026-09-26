"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminPage, AdminCollection, AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { toast } from "sonner";
import { Download, ScrollText } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface AuditLogEntry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null } | null;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchLogs = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/audit-logs?page=${page}&pageSize=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setLogs(data.logs || []);
      setTotalPages(data.totalPages || 1);
    } catch {
      console.error("Failed to load audit logs");
    } finally {
      setLoading(false);
    }
  }, [token, page]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const handleExport = async (format: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/audit-logs/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { toast.error("Export failed"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-logs.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error("Export failed"); }
  };

  const actionColor = (action: string): "default" | "destructive" | "success" | "warning" | "secondary" => {
    if (action.includes("deleted") || action.includes("suspended") || action.includes("failed")) return "destructive";
    if (action.includes("created") || action.includes("activated") || action.includes("ran")) return "success";
    if (action.includes("force")) return "warning";
    return "secondary";
  };

  // Friendly Target + Details for scheduled report runs and alerts — show the
  // dashboard NAME (id) and a clean status instead of a raw metadata dump.
  const friendly = (log: AuditLogEntry): { target: string; details: string } | null => {
    const md = (log.metadata || {}) as Record<string, unknown>;
    if (log.action === "report.schedule_ran" || log.action === "report.schedule_failed") {
      const id = String(md.dashboardId ?? log.targetId ?? "");
      const name = String(md.dashboardName ?? id);
      const target = name && id && name !== id ? `${name} (${id})` : name || id || "—";
      const reason = md.reason ? ` — ${String(md.reason).slice(0, 120)}` : "";
      const kept = md.unreachable ? " (last good snapshot kept)" : "";
      const details =
        log.action === "report.schedule_failed"
          ? `Refresh failed${kept}${reason}`
          : md.status === "partial"
            ? `Partial — ${md.refreshed ?? 0} refreshed, ${md.failed ?? 0} failed`
            : "Refreshed successfully";
      return { target, details };
    }
    if (log.action === "alert.discrepancy") {
      const metric = String(md.metricKey ?? log.targetId ?? "alert");
      const emailed = md.emailed ? `emailed ${md.recipientsCount ?? 0}` : "logged (no email)";
      return { target: metric, details: `Value ${md.value ?? "?"} breached threshold — ${emailed}` };
    }
    if (log.action === "report.shift_summary_sent") {
      const name = String(md.name ?? log.targetId ?? "shift summary");
      const details = md.emailed
        ? `Sent to ${md.recipientsCount ?? 0} — ${md.dashboards ?? 0} dashboards`
        : "Not sent (no SMTP / recipients)";
      return { target: `${name} (${md.timezone ?? ""} ${md.sendTime ?? ""})`.trim(), details };
    }
    if (log.action === "report.shift_summary_failed") {
      const name = String(md.name ?? log.targetId ?? "shift summary");
      const reason = md.reason ? ` — ${String(md.reason).slice(0, 120)}` : "";
      const details = md.emailed
        ? `Sent with problems to ${md.recipientsCount ?? 0}${reason}`
        : `Not sent${reason}`;
      return { target: `${name} (${md.timezone ?? ""} ${md.sendTime ?? ""})`.trim(), details };
    }
    return null;
  };

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="Monitoring" title="Audit Logs" description="Track all admin actions">
        <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => handleExport("csv")}>
          <Download className="mr-2 h-4 w-4" aria-hidden="true" /> Export CSV
        </Button>
      </AdminPageHeader>

      <AdminCollection>
      <AdminCollectionHeader title="Activity history" description="Administrative events, ordered by most recent activity." count={loading ? undefined : logs.length} />



      <div
        className="admin-table-surface"
        role="region"
        aria-label="Audit logs"
        tabIndex={0}
      >
        <Table className="min-w-[720px] text-sm">
          <TableCaption className="sr-only">Chronological log of administrative actions.</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Time</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Action</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Admin</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Target</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-b">
            {loading ? (
              [...Array(5)].map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent"><TableCell colSpan={5} className="whitespace-normal px-4 py-4"><div className="h-4 w-64 animate-pulse rounded bg-muted" /></TableCell></TableRow>
              ))
            ) : logs.length === 0 ? (
              <TableRow className="border-b-0! hover:bg-transparent">
                <TableCell colSpan={5} className="whitespace-normal px-4 py-14 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <ScrollText className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">No audit logs yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">Admin actions like inviting users or editing roles will appear here.</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id} className="hover:bg-muted/30">
                  <TableCell className="whitespace-normal px-4 py-3 text-sm tabular-nums text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3">
                    <Badge variant={actionColor(log.action)}>{log.action}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3 text-sm">
                    {log.user?.email || "system"}
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3 text-sm text-muted-foreground">
                    {friendly(log)?.target ?? (log.targetType && `${log.targetType}`)}
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3 text-xs text-muted-foreground">
                    {friendly(log)?.details ??
                      (log.metadata && Object.keys(log.metadata).length > 0 ? (
                        <span className="font-mono">
                          {Object.entries(log.metadata).map(([k, v]) => `${k}: ${v}`).join(", ")}
                        </span>
                      ) : (
                        "—"
                      ))}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="admin-pagination" aria-label="Audit log pagination">
          <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">Previous</Button>
          <span className="text-sm tabular-nums text-muted-foreground" aria-current="page">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={loading || page >= totalPages} onClick={() => setPage(page + 1)} aria-label="Next page">Next</Button>
        </nav>
      )}
      </AdminCollection>

    </AdminPage>
  );
}
