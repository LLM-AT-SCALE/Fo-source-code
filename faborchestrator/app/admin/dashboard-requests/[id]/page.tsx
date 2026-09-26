"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/components/ui/sheet";
import { toast } from "sonner";
import { DashboardPreview } from "@/modules/admin/components/dashboard-preview";
import { CompilePanel, isJobRunning, type CompileJob } from "@/modules/admin/components/compile-panel";
import { DecisionPanel, type ApproveBody, type MatchOption } from "@/modules/admin/components/decision-panel";
import { Disclosure, StageStrip } from "@/modules/admin/components/disclosure";
import { VisibilityPicker, type VisibilityValue } from "@/modules/admin/components/visibility-picker";
import { RequestStatusBadge, ageOf } from "@/modules/admin/components/request-status-badge";
import type { TraceServerRef } from "@/modules/admin/components/mcp-scope-picker";
import { ArrowLeft, ExternalLink, Loader2, Rocket } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";
import { storedPinChoices } from "@/modules/fabinsight/lib/pin/options";

type Person = { id: string; name: string | null; email: string | null } | null;

type Kpi = { label?: string; key?: string; source?: string } | string;

type TraceStep = {
  seq: number;
  toolName: string;
  serverUrl: string | null;
  registryId: string | null;
  connectionName: string | null;
  rowCount: number | null;
  error: string | null;
};

type Detail = {
  request: {
    id: string;
    title: string;
    reason: string;
    html: string;
    kpis: Kpi[];
    trace: TraceStep[];
    traceServers: TraceServerRef[];
    status: string;
    decision: Record<string, unknown> | null;
    requester: Person;
    decidedBy: Person;
    decidedAt: string | null;
    dashboardId: string | null;
    createdAt: string;
  };
  jobs: CompileJob[];
  dashboard: {
    id: string;
    slug: string;
    title: string;
    status: string;
    visibleToAll: boolean;
    visibilityRoleIds: unknown;
    visibilityUserIds: unknown;
    expiresAt: string | null;
  } | null;
  timeline: { id: string; action: string; targetId: string | null; actor: Person; metadata: Record<string, unknown>; at: string }[];
};

type Match = MatchOption & { score: number; extraKpis: string[]; slug: string | null };

const TIMELINE_LABEL: Record<string, string> = {
  "dashboard.requested": "Requested",
  "report.request_approved": "Approved",
  "report.request_denied": "Denied",
  "report.compile_requested": "Refinement queued",
  "dashboard.compile_ready": "Preview ready",
  "dashboard.compile_failed": "Compile failed",
  "report.dashboard_live": "Published",
};

const STAGES = ["Requested", "Approved", "Compiled", "Published"];

const kpiLabel = (k: Kpi) => (typeof k === "string" ? k : k.label || k.key || "");
const personText = (p: Person) => (p ? p.name || p.email || p.id.slice(0, 8) : "—");
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
const strIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export default function DashboardRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [goLiveJobId, setGoLiveJobId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibleToAll: true, roleIds: [], userIds: [] });

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  const headers = useCallback(
    (json = false): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    }),
    [token],
  );

  const fetchDetail = useCallback(
    async (quiet = false) => {
      if (!token || !id) return;
      if (!quiet) setLoading(true);
      try {
        const res = await fetch(`/api/admin/dashboard-requests/${id}`, { headers: headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        setDetail(data);
      } catch (e) {
        if (!quiet) toast.error(e instanceof Error ? e.message : "Failed to load the request");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [token, id, headers],
  );

  const fetchMatches = useCallback(async () => {
    if (!token || !id) return;
    try {
      const res = await fetch(`/api/admin/dashboard-requests/${id}/matches`, { headers: headers() });
      const data = await res.json();
      if (res.ok) setMatches(data.matches || []);
    } catch {
      /* matches are advisory */
    }
  }, [token, id, headers]);

  useEffect(() => {
    fetchDetail();
    fetchMatches();
  }, [fetchDetail, fetchMatches]);

  const refreshQuiet = useCallback(() => fetchDetail(true), [fetchDetail]);

  const post = async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/dashboard-requests/${id}/${path}`, { method: "POST", headers: headers(true), body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.error(typeof data.error === "string" ? data.error : "Request failed");
        return null;
      }
      return data;
    } catch {
      toast.error("Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const approve = async (body: ApproveBody) => {
    const r = await post("approve", body);
    if (r) {
      toast.success(
        r.status === "live"
          ? "Published."
          : r.autoPublish
            ? "Approved. It is published automatically when the compile is ready."
            : "Approved. The compiler is building the dashboard.",
      );
      await fetchDetail(true);
    }
  };
  const deny = async (note: string) => {
    const r = await post("deny", { note });
    if (r) {
      toast.success("Request denied");
      await fetchDetail(true);
    }
  };
  const refine = async (instruction: string) => {
    const r = await post("refine", { instruction });
    if (r) {
      toast.success("Recompiling with your change");
      await fetchDetail(true);
    }
  };
  const openGoLive = (jobId: string) => {
    const d = detail?.dashboard;
    const mode = detail?.request.decision?.mode;
    const asked = storedPinChoices(detail?.request.decision);
    // Extending: start from the target dashboard's current visibility; a pinned
    // request starts from who the requester chose.
    setVisibility(
      asked && mode !== "extend"
        ? { visibleToAll: asked.visibleToAll, roleIds: asked.roleIds, userIds: [] }
        : mode === "extend" && d
        ? { visibleToAll: d.visibleToAll, roleIds: strIds(d.visibilityRoleIds), userIds: strIds(d.visibilityUserIds).filter((u) => u !== detail?.request.requester?.id) }
        // New dashboards are visible to everyone unless the admin narrows it.
        : { visibleToAll: true, roleIds: [], userIds: [] },
    );
    setGoLiveJobId(jobId);
  };
  const confirmGoLive = async () => {
    if (!goLiveJobId) return;
    const r = await post("go-live", { jobId: goLiveJobId, ...visibility });
    if (r) {
      toast.success(r.emailed ? "Published. The requester has been emailed." : "Published.");
      setGoLiveJobId(null);
      await fetchDetail(true);
    }
  };

  if (loading) {
    return (
      <AdminPage className="admin-workspace-detail">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </AdminPage>
    );
  }

  if (!detail) {
    return (
      <AdminPage className="admin-workspace-detail">
        <AdminPageHeader title="Unable to load request" description="The item may no longer be available, or the connection was interrupted." />
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => fetchDetail()}>Try again</Button>
          <Button variant="outline" onClick={() => router.push("/admin/dashboards?tab=requests")}>Back to requests</Button>
        </div>
      </AdminPage>
    );
  }

  const { request, jobs, dashboard, timeline } = detail;
  const decision = request.decision;
  const isLive = request.status === "live";
  const compiling = jobs.some(isJobRunning);
  const hasPreview = jobs.some((j) => j.status === "preview_ready");
  /*
   * Show the decision panel whenever a decision is still open and nothing is
   * in flight or already previewable.
   *
   * This used to also require `jobs.length === 0`, which trapped a request whose
   * FIRST compile failed: the failed job row made the panel disappear for ever,
   * leaving only the refine box — and refine can never succeed there, because it
   * needs a base program that a failed compile never produced. The primary title
   * below already reads "Compile failed - approve again to retry", so approving
   * again was always the intent; a failed job must not hide the way to do it.
   */
  const pendingDecision =
    ["requested", "compile_failed", "denied"].includes(request.status) && !compiling && !hasPreview;
  const stage = isLive ? 3 : hasPreview ? 2 : pendingDecision ? 0 : 1;
  const publishedVersion = timeline.find((t) => t.action === "report.dashboard_live")?.metadata?.versionNo as number | undefined;

  const primaryTitle = pendingDecision
    ? request.status === "denied" ? "Denied — approve to reopen" : request.status === "compile_failed" ? "Compile failed — approve again to retry" : "Approve and run the compiler"
    : isLive ? "Published" : compiling ? "Compiling" : hasPreview ? "Review the preview and publish" : "Compile";
  const primaryDescription = pendingDecision
    ? request.status === "denied"
      ? `Denied by ${personText(request.decidedBy)} on ${fmt(request.decidedAt)}.`
      : "The compiler turns the captured MCP calls into a scheduled dashboard. You review the result before it is published."
    : isLive && decision?.type === "static"
      ? `“${dashboard?.title ?? request.title}” is live as a static snapshot${dashboard?.status && dashboard.status !== "live" ? ` (now ${dashboard.status})` : ""}.`
    : isLive
      ? `Version ${publishedVersion ?? ""} of “${dashboard?.title ?? request.title}” is live${dashboard?.status && dashboard.status !== "live" ? ` (now ${dashboard.status})` : ""}.`.replace("  ", " ")
      : hasPreview
        ? "Publish it as is, or describe a change and recompile."
        : "Approved; waiting for the compiler.";

  return (
    <AdminPage className="admin-workspace-detail">
      <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => router.push("/admin/dashboards?tab=requests")}>
        <ArrowLeft className="mr-2 h-4 w-4" /> All requests
      </Button>
      <AdminPageHeader section="Dashboards" title={request.title} description={`Requested by ${personText(request.requester)} · ${ageOf(request.createdAt)} ago`}>
        <RequestStatusBadge status={request.status} />
        {dashboard && <Badge variant="outline" className="font-mono text-xs">{dashboard.slug}</Badge>}
      </AdminPageHeader>

      <div className="mt-4 mb-6">
        <StageStrip stages={STAGES} current={stage} />
      </div>

      <div className="flex flex-col gap-4">
        {/* The one card that carries the admin's next action. */}
        <Card className="admin-card">
          <CardHeader className="pb-3">
            <CardTitle className="admin-card-title text-base">{primaryTitle}</CardTitle>
            <CardDescription>{primaryDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            {pendingDecision ? (
              <div className="space-y-4">
                <DashboardPreview html={request.html} title={`Preview of ${request.title}`} />
                <DecisionPanel
                  token={token}
                  traceServers={request.traceServers}
                  matches={matches}
                  onApprove={approve}
                  onDeny={deny}
                  busy={busy}
                  requested={storedPinChoices(request.decision)}
                  requester={request.requester}
                />
              </div>
            ) : isLive ? (
              <div className="flex flex-wrap items-center gap-3">
                {dashboard && (
                  <Button onClick={() => router.push(`/admin/dashboards/${dashboard.id}`)} className="bg-primary">
                    <ExternalLink className="mr-2 h-4 w-4" /> Open dashboard
                  </Button>
                )}
                <span className="text-sm text-muted-foreground">Edits, schedule, visibility and versions are managed on the dashboard page.</span>
              </div>
            ) : (
              <CompilePanel jobs={jobs} onRefine={refine} onGoLive={openGoLive} onRefresh={refreshQuiet} busy={busy} canGoLive={!isLive} />
            )}
          </CardContent>
        </Card>

        {/* Everything else is reference material, folded away. */}
        {!pendingDecision && (
          <Disclosure title="Original request" hint="The dashboard as the requester saw it in chat">
            <DashboardPreview html={request.html} title={`Original preview of ${request.title}`} />
          </Disclosure>
        )}

        {request.reason.trim() && (
          <Disclosure title="Why it was requested" hint={request.reason.length > 90 ? `${request.reason.slice(0, 90)}…` : request.reason}>
            <p className="whitespace-pre-wrap text-sm">{request.reason}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              {request.requester?.name && request.requester.email ? `${request.requester.name} · ${request.requester.email}` : personText(request.requester)} · submitted {fmt(request.createdAt)}
            </p>
          </Disclosure>
        )}

        <Disclosure title="KPIs and data sources" count={request.kpis.length} hint={`${request.trace.length} MCP call${request.trace.length === 1 ? "" : "s"} captured`}>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {request.kpis.length === 0 && <span className="text-xs text-muted-foreground">No KPIs detected in the HTML.</span>}
              {request.kpis.map((k, i) => (
                <span key={i} className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs">{kpiLabel(k)}</span>
              ))}
            </div>
            {request.trace.length === 0 ? (
              <p className="text-xs text-amber-600">No tool calls were captured for this artifact; the compiler cannot replay it.</p>
            ) : (
              <ol className="divide-y rounded-md border text-xs">
                {request.trace.map((t) => (
                  <li key={t.seq} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                    <span className="w-5 text-muted-foreground">{t.seq}.</span>
                    <span className="font-mono">{t.toolName}</span>
                    <span className="text-muted-foreground">on {t.connectionName || t.serverUrl || "unknown server"}</span>
                    {t.rowCount !== null && <span className="ml-auto tabular-nums text-muted-foreground">{t.rowCount} rows</span>}
                    {t.error && <span className="ml-auto text-destructive">{t.error}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Disclosure>

        {decision && !pendingDecision && decision.type === "static" && (
          <Disclosure title="Approval settings" hint="static snapshot, never refreshed">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Decided</dt><dd>by {personText(request.decidedBy)} on {fmt(request.decidedAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Outcome</dt><dd>static snapshot of the pinned dashboard</dd></div>
            </dl>
          </Disclosure>
        )}

        {decision && !pendingDecision && decision.type !== "static" && typeof decision.mode === "string" && (
          <Disclosure title="Approval settings" hint={`${decision.mode === "extend" ? "extends an existing dashboard" : "new dashboard"} · ${scheduleText(decision.schedule)}`}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Decided</dt><dd>by {personText(request.decidedBy)} on {fmt(request.decidedAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Outcome</dt><dd>{decision.mode === "extend" ? `extend ${dashboard?.title ?? "existing dashboard"}` : "create a new dashboard"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Servers</dt><dd>{scopeText(decision.connectionScope)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Schedule</dt><dd>{scheduleText(decision.schedule)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Expires</dt><dd>{typeof decision.expiresAt === "string" ? fmt(decision.expiresAt) : "Never"}</dd></div>
              {typeof decision.startsAt === "string" && (
                <div><dt className="text-xs text-muted-foreground">First refresh</dt><dd>{fmt(decision.startsAt)}</dd></div>
              )}
              {decision.autoPublish === true && (
                <div><dt className="text-xs text-muted-foreground">Publishing</dt><dd>automatically, when the compile is ready</dd></div>
              )}
            </dl>
          </Disclosure>
        )}

        <Disclosure title="Activity" count={timeline.length}>
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded yet.</p>
          ) : (
            <ol className="space-y-3 border-l pl-4 text-sm">
              {timeline.map((t) => (
                <li key={t.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" aria-hidden />
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{TIMELINE_LABEL[t.action] ?? t.action}</span>
                    <span className="text-xs text-muted-foreground">{fmt(t.at)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t.actor ? `by ${personText(t.actor)}` : "by Fab Orchestrator"}
                    {typeof t.metadata?.instruction === "string" && ` · “${t.metadata.instruction}”`}
                    {typeof t.metadata?.error === "string" && ` · ${t.metadata.error}`}
                    {typeof t.metadata?.note === "string" && t.metadata.note && ` · ${t.metadata.note}`}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Disclosure>
      </div>

      <Sheet open={!!goLiveJobId} onOpenChange={(o) => !o && setGoLiveJobId(null)}>
        <SheetContent className="admin-overlay overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Publish</SheetTitle>
            <SheetDescription>
              Everyone can open it unless you narrow it below. The requester always has access, and the refresh schedule starts on the next tick.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            <VisibilityPicker value={visibility} onChange={setVisibility} token={token} requester={request.requester} disabled={busy} />
          </div>
          <div className="mt-8 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setGoLiveJobId(null)} disabled={busy}>Cancel</Button>
            <Button onClick={confirmGoLive} disabled={busy} className="bg-primary">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
              Publish
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </AdminPage>
  );
}

function scopeText(scope: unknown): string {
  if (!scope || typeof scope !== "object") return "all connected servers";
  const s = scope as { mode?: string; servers?: { serverUrl?: string; registryId?: string }[] };
  if (s.mode === "fixed" && Array.isArray(s.servers)) return s.servers.map((x) => x.serverUrl || x.registryId || "?").join(", ");
  return "all connected servers";
}

function scheduleText(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object") return "—";
  const s = schedule as { frequency?: string; intervalMinutes?: number | null; atTime?: string | null; timezone?: string; daysOfWeek?: number[]; dayOfMonth?: number | null; windowStart?: string | null; windowEnd?: string | null };
  const tz = s.timezone || "UTC";
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (s.frequency === "hourly") return `every ${s.intervalMinutes ?? 60} min${s.windowStart && s.windowEnd ? ` between ${s.windowStart}–${s.windowEnd} ${tz}` : ""}`;
  if (s.frequency === "weekly") return `weekly on ${(s.daysOfWeek ?? []).map((d) => DOW[d]).join(", ")} at ${s.atTime ?? "00:00"} ${tz}`;
  if (s.frequency === "monthly") return `monthly on day ${s.dayOfMonth ?? 1} at ${s.atTime ?? "00:00"} ${tz}`;
  return `daily at ${s.atTime ?? "00:00"} ${tz}`;
}
