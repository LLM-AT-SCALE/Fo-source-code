"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import { DashboardPreview } from "@/modules/admin/components/dashboard-preview";
import { CompilePanel, isJobRunning, type CompileJob } from "@/modules/admin/components/compile-panel";
import { Disclosure } from "@/modules/admin/components/disclosure";
import { VisibilityPicker, type VisibilityValue } from "@/modules/admin/components/visibility-picker";
import {
  ScheduleFields,
  scheduleLabelCls,
  scheduleSelectCls,
  scheduleValueErrors,
  scheduleValueFrom,
  scheduleValueToBody,
  type ScheduleValue,
} from "@/modules/admin/components/schedule-fields";
import { EXPIRY_PRESETS, EXPIRY_NEVER } from "@/modules/admin/lib/dashboards/report-schedule";
import { ArrowLeft, CalendarClock, History, Loader2, Pause, Pencil, Play, Save, Wand2 } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

type Person = { id: string; name: string | null; email: string | null } | null;

type Detail = {
  dashboard: {
    id: string;
    slug: string;
    title: string;
    kind: string;
    status: string;
    currentVersionId: string | null;
    kpis: unknown;
    visibleToAll: boolean;
    visibilityRoleIds: string[];
    visibilityRoles: { id: string; name: string }[];
    visibilityUserIds: string[];
    visibilityUsers: Person[];
    connectionScope: unknown;
    expiresAt: string | null;
    createdBy: Person;
    requester: Person;
    cachedHtml: string | null;
    cachedSummary: string | null;
    refreshedAt: string | null;
    lastStatus: string | null;
    perServerStatus: unknown;
    createdAt: string;
  };
  currentVersion: { id: string; versionNo: number; templateHtml: string } | null;
  versions: {
    id: string;
    versionNo: number;
    refineHistory: unknown;
    createdFromJobId: string | null;
    approvedBy: Person;
    createdAt: string;
    current: boolean;
  }[];
  jobs: CompileJob[];
  schedule: {
    frequency: string;
    intervalMinutes: number | null;
    atTime: string | null;
    daysOfWeek: number[];
    dayOfMonth: number | null;
    enabled: boolean;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastStatus: string | null;
    timezone: string;
    windowStart: string | null;
    windowEnd: string | null;
  } | null;
};

const SEVEN_DAYS = 7 * 86_400_000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
const personText = (p: Person) => (p ? p.name || p.email || p.id.slice(0, 8) : "—");

function StatusBadge({ status }: { status: string }) {
  if (status === "live") return <Badge variant="success">Live</Badge>;
  if (status === "paused") return <Badge variant="warning">Paused</Badge>;
  if (status === "expired") return <Badge variant="destructive">Expired</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function scheduleText(s: Detail["schedule"]): string {
  if (!s) return "No schedule";
  const tz = s.timezone || "UTC";
  const win = s.windowStart && s.windowEnd ? ` between ${s.windowStart}–${s.windowEnd} ${tz}` : "";
  if (s.frequency === "hourly") return `every ${s.intervalMinutes ?? 60} min${win}`;
  if (s.frequency === "weekly") return `weekly on ${s.daysOfWeek.map((d) => DOW[d]).join(", ")} at ${s.atTime ?? "00:00"} ${tz}`;
  if (s.frequency === "monthly") return `monthly on day ${s.dayOfMonth ?? 1} at ${s.atTime ?? "00:00"} ${tz}`;
  return `daily at ${s.atTime ?? "00:00"} ${tz}`;
}

function scopeText(scope: unknown): string {
  if (!scope || typeof scope !== "object") return "all connected servers";
  const s = scope as { mode?: string; servers?: { serverUrl?: string; registryId?: string }[] };
  if (s.mode === "fixed" && Array.isArray(s.servers)) return s.servers.map((x) => x.serverUrl || x.registryId || "?").join(", ");
  return "all connected servers";
}

function refineCount(h: unknown): number {
  return Array.isArray(h) ? h.length : 0;
}

function visibilityText(d: Detail["dashboard"]): string {
  if (d.visibleToAll) return "Everyone";
  const bits: string[] = [];
  if (d.visibilityRoles.length) bits.push(`${d.visibilityRoles.length} role${d.visibilityRoles.length === 1 ? "" : "s"}`);
  if (d.visibilityUsers.length) bits.push(`${d.visibilityUsers.length} user${d.visibilityUsers.length === 1 ? "" : "s"}`);
  return bits.length ? bits.join(" + ") + " + requester" : "Requester only";
}

export default function DashboardDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const confirm = useConfirm();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibleToAll: true, roleIds: [], userIds: [] });
  const [visibilityDirty, setVisibilityDirty] = useState(false);
  const [expiryPreset, setExpiryPreset] = useState<string>(EXPIRY_NEVER);
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [scheduleEditing, setScheduleEditing] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleValue>(() => scheduleValueFrom({}));
  const [scheduleEnabled, setScheduleEnabled] = useState(true);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  const headers = useCallback(
    (json = false): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) }),
    [token],
  );

  const fetchDetail = useCallback(
    async (quiet = false) => {
      if (!token || !id) return;
      if (!quiet) setLoading(true);
      try {
        const res = await fetch(`/api/admin/dashboards/${id}`, { headers: headers() });
        const data = (await res.json()) as Detail & { error?: string };
        if (!res.ok) throw new Error(data.error || "failed");
        setDetail(data);
        if (!quiet) {
          const d = data.dashboard;
          setVisibility({
            visibleToAll: d.visibleToAll,
            roleIds: d.visibilityRoleIds,
            userIds: d.visibilityUserIds.filter((u) => u !== d.requester?.id),
          });
          setVisibilityDirty(false);
        }
      } catch (e) {
        if (!quiet) toast.error(e instanceof Error ? e.message : "Failed to load the dashboard");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [token, id, headers],
  );

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const refreshQuiet = useCallback(() => fetchDetail(true), [fetchDetail]);

  const call = async (method: "PATCH" | "POST", path: string, body: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/dashboards/${id}${path}`, { method, headers: headers(true), body: JSON.stringify(body) });
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

  const saveVisibility = async () => {
    const r = await call("PATCH", "", { visibility });
    if (r) {
      toast.success("Visibility saved");
      await fetchDetail();
    }
  };

  const extendExpiry = async (alsoResume: boolean) => {
    const expiry = expiryPreset === EXPIRY_NEVER ? { preset: EXPIRY_NEVER } : expiryPreset === "custom" ? { preset: "custom", date: expiryDate } : { preset: Number(expiryPreset) };
    const r = await call("PATCH", "", { expiry, ...(alsoResume ? { status: "live" } : {}) });
    if (r) {
      toast.success(alsoResume ? "Dashboard resumed" : expiryPreset === EXPIRY_NEVER ? "Expiry removed — never expires" : "Expiry updated");
      await fetchDetail(true);
    }
  };

  const openScheduleEditor = () => {
    const s = detail?.schedule;
    setScheduleDraft(scheduleValueFrom(s ?? {}));
    setScheduleEnabled(s ? s.enabled : true);
    setScheduleEditing(true);
  };

  const saveSchedule = async () => {
    if (!scheduleValueErrors(scheduleDraft).valid) return;
    const r = await call("PATCH", "", { schedule: { ...scheduleValueToBody(scheduleDraft), enabled: scheduleEnabled } });
    if (r) {
      const sched = r.schedule as { description?: string; enabled?: boolean } | undefined;
      toast.success(sched?.enabled === false ? "Schedule saved and paused" : `Schedule saved: ${sched?.description ?? "updated"}. First run on the next tick.`);
      setScheduleEditing(false);
      await fetchDetail(true);
    }
  };

  const setStatus = async (status: "live" | "paused") => {
    const r = await call("PATCH", "", { status });
    if (r) {
      toast.success(status === "paused" ? "Dashboard paused; its schedule is disabled." : "Dashboard resumed; its schedule is enabled.");
      await fetchDetail(true);
    }
  };

  const refine = async (instruction: string) => {
    const r = await call("POST", "/refine", { instruction });
    if (r) {
      toast.success("The compiler is building a new preview");
      await fetchDetail(true);
    }
  };

  const publish = async (jobId: string) => {
    const ok = await confirm({
      title: "Publish this preview as the new version?",
      description: "Viewers see it on the next refresh. You can roll back to the previous version at any time.",
      confirmText: "Publish",
    });
    if (!ok) return;
    const r = await call("POST", "/go-live", { jobId });
    if (r) {
      toast.success(`Version ${String(r.versionNo)} is live`);
      await fetchDetail(true);
    }
  };

  const rollback = async (versionId: string, versionNo: number) => {
    const ok = await confirm({
      title: `Roll back to version ${versionNo}?`,
      description: "The dashboard's program and template switch to that version. Newer versions stay in the history.",
      confirmText: "Roll back",
      destructive: true,
    });
    if (!ok) return;
    const r = await call("POST", "/rollback", { versionId });
    if (r) {
      toast.success(`Rolled back to version ${versionNo}`);
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
        <AdminPageHeader title="Unable to load dashboard" description="The item may no longer be available, or the connection was interrupted." />
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => fetchDetail()}>Try again</Button>
          <Button variant="outline" onClick={() => router.push("/admin/dashboards")}>Back to dashboards</Button>
        </div>
      </AdminPage>
    );
  }

  const { dashboard: d, currentVersion, versions, jobs, schedule } = detail;
  const now = Date.now();
  const expMs = d.expiresAt ? new Date(d.expiresAt).getTime() : null;
  const expSoon = expMs !== null && expMs - now < SEVEN_DAYS;
  const expired = d.status === "expired" || (expMs !== null && expMs < now);
  const previewHtml = d.cachedHtml || currentVersion?.templateHtml || null;
  const today = new Date().toISOString().slice(0, 10);
  const expiryValid = expiryPreset !== "custom" || !!expiryDate;
  // A job is a pending edit only until it is published (a version points at it)
  // or superseded (an older job than the current version). Published jobs keep
  // their preview_ready status, so without this the page would offer "Publish"
  // on every refresh of an old dashboard.
  const publishedJobIds = new Set(versions.map((v) => v.createdFromJobId).filter((x): x is string => !!x));
  const currentVersionAt = currentVersion ? new Date(versions.find((v) => v.current)?.createdAt ?? 0).getTime() : 0;
  const pendingJobs = jobs.filter((j) => isJobRunning(j) || (!publishedJobIds.has(j.id) && new Date(j.createdAt).getTime() > currentVersionAt));
  const editing = pendingJobs.length > 0;
  const compiling = pendingJobs.some(isJobRunning);
  const previewReady = pendingJobs.some((j) => j.status === "preview_ready");

  const snapshotLine = d.cachedHtml
    ? `Last refreshed ${fmt(d.refreshedAt)}${d.lastStatus && d.lastStatus !== "ok" ? ` · ${d.lastStatus}` : ""}`
    : currentVersion
      ? "No refresh yet — showing the template without data."
      : "No version published yet.";
  const nextLine = schedule?.enabled ? `Next refresh ${fmt(schedule.nextRunAt)}` : d.status === "paused" ? "Refresh paused" : "Not scheduled";

  return (
    <AdminPage className="admin-workspace-detail">
      <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => router.push("/admin/dashboards")}>
        <ArrowLeft className="mr-2 h-4 w-4" /> All dashboards
      </Button>
      <AdminPageHeader section="Dashboards" title={d.title} description={`Version ${currentVersion?.versionNo ?? "—"} · ${scheduleText(schedule)}${d.expiresAt ? ` · expires ${fmt(d.expiresAt)}` : ""}`}>
        <StatusBadge status={d.status} />
        {d.status === "live" && (
          <Button variant="outline" size="sm" onClick={() => setStatus("paused")} disabled={busy}>
            <Pause className="mr-2 h-4 w-4" /> Pause
          </Button>
        )}
        {d.status === "paused" && (
          <Button variant="outline" size="sm" onClick={() => setStatus("live")} disabled={busy}>
            <Play className="mr-2 h-4 w-4" /> Resume
          </Button>
        )}
      </AdminPageHeader>

      {expired && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          This dashboard has expired: it is hidden from viewers and no longer refreshes. Set a new expiry under Expiry below to resume it.
        </div>
      )}

      <div className="mt-6 flex flex-col gap-4">
        {/* What viewers see now, or the pending edit if one is in flight. */}
        <Card className="admin-card">
          <CardHeader className="pb-3">
            <CardTitle className="admin-card-title text-base">{editing ? (compiling ? "Compiling your edit" : previewReady ? "Review and publish" : "Edit") : "Live dashboard"}</CardTitle>
            <CardDescription>{editing ? (previewReady ? "Publishing adds a new version; the scheduled refresh keeps updating whichever version is current." : snapshotLine) : `${snapshotLine} · ${nextLine}`}</CardDescription>
          </CardHeader>
          <CardContent>
            {editing ? (
              <CompilePanel jobs={pendingJobs} onRefine={refine} onGoLive={publish} onRefresh={refreshQuiet} busy={busy} canGoLive={!!currentVersion} publishLabel="Publish as new version" />
            ) : (
              <div className="space-y-4">
                <DashboardPreview html={previewHtml} title={`Preview of ${d.title}`} />
                <EditStarter onRefine={refine} busy={busy || !currentVersion} />
              </div>
            )}
          </CardContent>
        </Card>

        {editing && (
          <Disclosure title="Live version" hint={snapshotLine}>
            <DashboardPreview html={previewHtml} title={`Live preview of ${d.title}`} />
          </Disclosure>
        )}

        <Disclosure title="Refresh schedule" hint={`${scheduleText(schedule)}${schedule && !schedule.enabled ? " (paused)" : ""} · ${nextLine}`}>
          {scheduleEditing ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <ScheduleFields value={scheduleDraft} onChange={setScheduleDraft} disabled={busy} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scheduleEnabled} disabled={busy} onChange={(e) => setScheduleEnabled(e.target.checked)} className="h-4 w-4 rounded border border-input accent-primary" />
                Enabled
                <span className="text-xs text-muted-foreground">(off pauses only the refresh; the dashboard stays visible)</span>
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setScheduleEditing(false)} disabled={busy}>Cancel</Button>
                <Button size="sm" onClick={saveSchedule} disabled={busy || !scheduleValueErrors(scheduleDraft).valid} className="bg-primary">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save schedule
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
              <div className="space-y-1">
                <p>{scheduleText(schedule)}{schedule && !schedule.enabled ? " (paused)" : ""}</p>
                <p className="text-xs text-muted-foreground">Next run {schedule?.enabled ? fmt(schedule.nextRunAt) : "—"} · last run {fmt(schedule?.lastRunAt)}{schedule?.lastStatus ? ` (${schedule.lastStatus})` : ""}</p>
                <p className="text-xs text-muted-foreground">Data from {scopeText(d.connectionScope)}</p>
              </div>
              <Button variant="outline" size="sm" onClick={openScheduleEditor} disabled={busy} aria-label="Edit schedule">
                <Pencil className="mr-2 h-4 w-4" /> {schedule ? "Edit" : "Set schedule"}
              </Button>
            </div>
          )}
        </Disclosure>

        <Disclosure title="Who can see it" hint={visibilityText(d)}>
          <div className="space-y-3">
            <VisibilityPicker
              value={visibility}
              onChange={(v) => {
                setVisibility(v);
                setVisibilityDirty(true);
              }}
              token={token}
              requester={d.requester}
              disabled={busy}
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={saveVisibility} disabled={busy || !visibilityDirty} className="bg-primary">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </Button>
            </div>
          </div>
        </Disclosure>

        <Disclosure title="Expiry" hint={d.expiresAt ? `${expired ? "Expired" : expSoon ? "Expires soon" : "Expires"} ${fmt(d.expiresAt)}` : "Never expires"} defaultOpen={expired}>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div>
                <label htmlFor="dashboard-expiry-preset" className={scheduleLabelCls}>New expiry</label>
                <select id="dashboard-expiry-preset" className={scheduleSelectCls} value={expiryPreset} disabled={busy} onChange={(e) => setExpiryPreset(e.target.value)}>
                  <option value={EXPIRY_NEVER}>Never</option>
                  {EXPIRY_PRESETS.map((n) => (
                    <option key={n} value={String(n)}>{n} days from today</option>
                  ))}
                  <option value="custom">Custom date…</option>
                </select>
              </div>
              {expiryPreset === "custom" && (
                <div>
                  <label htmlFor="dashboard-expiry-date" className={scheduleLabelCls}>New expiry date</label>
                  <input id="dashboard-expiry-date" type="date" min={today} className={scheduleSelectCls} value={expiryDate} disabled={busy} onChange={(e) => setExpiryDate(e.target.value)} />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              {expired ? (
                <Button size="sm" onClick={() => extendExpiry(true)} disabled={busy || !expiryValid} className="bg-primary">
                  <Play className="mr-2 h-4 w-4" /> Set expiry &amp; resume
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => extendExpiry(false)} disabled={busy || !expiryValid}>
                  <CalendarClock className="mr-2 h-4 w-4" /> Update expiry
                </Button>
              )}
            </div>
          </div>
        </Disclosure>

        <Disclosure title="Versions" count={versions.length} hint={currentVersion ? `v${currentVersion.versionNo} is current` : "Not published"}>
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions yet.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">v{v.versionNo}</span>
                  {v.current && <Badge variant="success">Current</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {fmt(v.createdAt)} · by {personText(v.approvedBy)}
                    {refineCount(v.refineHistory) > 0 && ` · ${refineCount(v.refineHistory)} refinement${refineCount(v.refineHistory) === 1 ? "" : "s"}`}
                  </span>
                  {!v.current && (
                    <Button variant="outline" size="sm" className="ml-auto" onClick={() => rollback(v.id, v.versionNo)} disabled={busy}>
                      Roll back
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Scheduled refreshes update the current version in place. A new version is created only when an edit is published.</p>
        </Disclosure>

        <Disclosure title="About" hint={`${d.kind === "seeded" ? "Standard" : "Custom"} · ${d.slug}`}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">Identifier</dt><dd className="font-mono text-xs">{d.slug}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Kind</dt><dd>{d.kind === "seeded" ? "Standard dashboard" : "Custom dashboard"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Requested by</dt><dd>{personText(d.requester)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{fmt(d.createdAt)} by {personText(d.createdBy)}</dd></div>
            {d.cachedSummary && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Latest summary</dt><dd>{d.cachedSummary}</dd></div>}
          </dl>
        </Disclosure>
      </div>
    </AdminPage>
  );
}

/** The edit box shown under the live preview before any edit job exists. */
function EditStarter({ onRefine, busy }: { onRefine: (instruction: string) => Promise<void>; busy: boolean }) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        aria-label="Describe dashboard changes"
        placeholder="Change something? e.g. “show the last 7 days instead of 30” or “add a yield-by-product table”. The compiler builds a preview you can publish as a new version."
        className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !text.trim()}
          onClick={async () => {
            await onRefine(text.trim());
            setText("");
          }}
        >
          <Wand2 className="mr-2 h-4 w-4" /> Edit & compile
        </Button>
      </div>
    </div>
  );
}
