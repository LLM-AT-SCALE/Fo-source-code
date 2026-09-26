"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Textarea } from "@/shared/components/ui/textarea";
import { McpScopePicker, type McpScopeValue, type TraceServerRef } from "@/modules/admin/components/mcp-scope-picker";
import {
  ScheduleFields,
  defaultScheduleValue,
  describeScheduleValue,
  scheduleLabelCls,
  scheduleSelectCls,
  scheduleValueErrors,
  scheduleValueFrom,
  scheduleValueToBody,
  type ScheduleValue,
} from "@/modules/admin/components/schedule-fields";
import { VisibilityPicker, type VisibilityValue } from "@/modules/admin/components/visibility-picker";
import type { PinChoices } from "@/modules/fabinsight/lib/pin/options";
import { EXPIRY_PRESETS, EXPIRY_NEVER, type ExpiryInput } from "@/modules/admin/lib/dashboards/report-schedule";
import { Check, Loader2, Settings2, X } from "lucide-react";

export type ApproveBody = {
  /** "static" publishes the pinned snapshot now (no compile, no schedule). */
  type: "static" | "scheduled";
  /** First refresh on this date ("YYYY-MM-DD", schedule timezone); omitted = now. */
  startDate?: string;
  /** Publish the compile result as soon as it is ready (with `visibility`). */
  autoPublish: boolean;
  visibility: VisibilityValue;
  mode: "create" | "extend";
  targetDashboardId?: string;
  connections: { mode: "all" } | { mode: "servers"; registryIds: string[] };
  schedule: ReturnType<typeof scheduleValueToBody>;
  expiry: ExpiryInput;
};

export type MatchOption = {
  dashboardId: string;
  title: string;
  overlapPct: number;
  sharedKpis: string[];
  missingKpis: string[];
  status: string | null;
};

/**
 * Approve / deny for a pending request. The defaults are already sensible
 * (new dashboard, the servers from the trace, daily refresh, never expires), so
 * the panel shows one summary line and a single primary button; the settings
 * unfold only when the admin wants to change them.
 *
 * A request pinned with the one-step Pin dialog carries the requester's choices
 * (`requested`: static or scheduled, schedule, From/To, who can see it). They
 * pre-fill everything, and "publish when ready" is on, so approving is one click.
 */
export function DecisionPanel({
  token,
  traceServers,
  matches,
  onApprove,
  onDeny,
  busy = false,
  requested = null,
  requester = null,
}: {
  token: string | null;
  /** What the requester chose when pinning; null for older requests. */
  requested?: PinChoices | null;
  requester?: { id: string; name: string | null; email: string | null } | null;
  traceServers: TraceServerRef[];
  /** Closest existing dashboards (by KPI overlap); null while loading. */
  matches: MatchOption[] | null;
  onApprove: (body: ApproveBody) => Promise<void> | void;
  onDeny: (note: string) => Promise<void> | void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "extend">("create");
  const [extendTarget, setExtendTarget] = useState<MatchOption | null>(null);
  // Default scope: the registry servers the trace touched; every connected
  // server when none of them is in the registry. Resolved here (not in the
  // picker) so the default is valid while the settings stay folded away.
  const [scope, setScope] = useState<McpScopeValue>({ mode: "all" });
  useEffect(() => {
    if (!token || traceServers.length === 0) return;
    let cancelled = false;
    fetch("/api/admin/mcp-registry", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { servers?: { id: string; serverUrl: string; isActive: boolean }[] } | null) => {
        if (cancelled) return;
        const active = (j?.servers ?? []).filter((s) => s.isActive);
        const ids: string[] = [];
        for (const t of traceServers) {
          const hit = active.find((s) => (t.registryId && s.id === t.registryId) || (t.serverUrl && s.serverUrl === t.serverUrl));
          if (hit && !ids.includes(hit.id)) ids.push(hit.id);
        }
        if (ids.length) setScope({ mode: "servers", registryIds: ids });
      })
      .catch(() => { /* keep "all" */ });
    return () => { cancelled = true; };
  }, [token, traceServers]);
  const [type, setType] = useState<"static" | "scheduled">(requested?.type ?? "scheduled");
  const [schedule, setSchedule] = useState<ScheduleValue>(() =>
    requested?.schedule ? scheduleValueFrom(requested.schedule) : defaultScheduleValue(),
  );
  const [startDate, setStartDate] = useState<string>(requested?.fromDate ?? "");
  const [expiryPreset, setExpiryPreset] = useState<string>(requested?.toDate ? "custom" : EXPIRY_NEVER);
  const [expiryDate, setExpiryDate] = useState<string>(requested?.toDate ?? "");
  const [autoPublish, setAutoPublish] = useState<boolean>(!!requested);
  const [visibility, setVisibility] = useState<VisibilityValue>({
    visibleToAll: requested ? requested.visibleToAll : true,
    roleIds: requested?.roleIds ?? [],
    userIds: [],
  });
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState("");

  const { valid: scheduleValid } = scheduleValueErrors(schedule);
  const scopeValid = scope.mode === "all" || scope.registryIds.length > 0;
  const expiryValid = expiryPreset !== "custom" || !!expiryDate;
  const extendValid = mode === "create" || !!extendTarget;
  const isStatic = type === "static";
  const canApprove = !busy && (isStatic || (scheduleValid && scopeValid && expiryValid && extendValid));

  // The requester's To date keeps its exact end-of-day instant in their timezone
  // unless the admin changes it.
  const customExpiry = requested?.toDate && expiryDate === requested.toDate && requested.expiresAt ? requested.expiresAt : expiryDate;

  const approve = () =>
    onApprove({
      type,
      startDate: !isStatic && startDate ? startDate : undefined,
      autoPublish: isStatic || autoPublish,
      visibility,
      mode,
      targetDashboardId: mode === "extend" ? extendTarget?.dashboardId : undefined,
      connections: scope.mode === "all" ? { mode: "all" } : { mode: "servers", registryIds: scope.registryIds },
      schedule: scheduleValueToBody(schedule),
      expiry: expiryPreset === EXPIRY_NEVER ? { preset: EXPIRY_NEVER } : expiryPreset === "custom" ? { preset: "custom", date: customExpiry } : { preset: Number(expiryPreset) as 7 | 14 | 30 | 90 },
    });

  const today = new Date().toISOString().slice(0, 10);

  const outcomeText = mode === "extend" ? (extendTarget ? `extend “${extendTarget.title}”` : "extend (pick a dashboard)") : "new dashboard";
  const scopeText = scope.mode === "all" ? "all connected servers" : `${scope.registryIds.length || "no"} server${scope.registryIds.length === 1 ? "" : "s"} selected`;
  const expiryText = expiryPreset === EXPIRY_NEVER ? "never expires" : expiryPreset === "custom" ? (expiryDate ? `until ${expiryDate}` : "custom date") : `${expiryPreset} days`;
  const whoText = visibility.visibleToAll ? "all roles" : visibility.roleIds.length ? `${visibility.roleIds.length} role${visibility.roleIds.length === 1 ? "" : "s"}` : "only the requester";
  const startText = startDate ? `from ${startDate}` : "";
  const summary = isStatic
    ? `static snapshot, never refreshed · visible to ${whoText}`
    : [outcomeText, scopeText, describeScheduleValue(schedule), startText, expiryText, autoPublish ? `published when ready, visible to ${whoText}` : "review before publishing"].filter(Boolean).join(" · ");
  const problems = isStatic ? [] : [
    !extendValid && "choose the dashboard to extend",
    !scopeValid && "pick at least one server",
    !scheduleValid && "fix the schedule",
    !expiryValid && "pick the expiry date",
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      {/* One-line summary of what approval will do, with the settings behind a toggle. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">{requested ? "As requested:" : isStatic ? "Will publish as" : "Will compile as"}</span>
        <span className="font-medium">{summary}</span>
        <Button variant="ghost" size="sm" className="-my-1 h-7 px-2 text-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Settings2 className="mr-1.5 h-3.5 w-3.5" /> {open ? "Hide settings" : "Change settings"}
        </Button>
      </div>
      {problems.length > 0 && <p className="text-xs text-destructive">Before approving: {problems.join(", ")}.</p>}

      {open && (
        <div className="admin-decision-form rounded-md border bg-muted/20 p-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Type</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="decision-type" className="accent-primary" checked={type === "scheduled"} disabled={busy} onChange={() => setType("scheduled")} />
              Scheduled — refreshed automatically
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="decision-type" className="accent-primary" checked={type === "static"} disabled={busy} onChange={() => setType("static")} />
              Static — publish the snapshot as it is, never refreshed
            </label>
          </div>

          {!isStatic && (<>
          <div className="space-y-2">
            <p className="text-sm font-medium">Outcome</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="decision-mode" className="accent-primary" checked={mode === "create"} disabled={busy} onChange={() => setMode("create")} />
              Create a new dashboard
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="decision-mode" className="accent-primary" checked={mode === "extend"} disabled={busy} onChange={() => setMode("extend")} />
              Add these KPIs to an existing dashboard
            </label>
            {mode === "extend" && (
              <div className="ml-6">
                {matches === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : matches.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No similar dashboards found. Create a new one instead.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {matches.map((m) => {
                      const selected = extendTarget?.dashboardId === m.dashboardId;
                      return (
                        <li key={m.dashboardId}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setExtendTarget(selected ? null : m)}
                            className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-accent/40"}`}
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{m.title}</span>
                              {m.status && <Badge variant="outline" className="capitalize">{m.status}</Badge>}
                              <span className="ml-auto text-xs text-muted-foreground">{m.overlapPct}% of KPIs already there</span>
                            </span>
                            {m.missingKpis.length > 0 && (
                              <span className="mt-1 block text-xs text-muted-foreground">Adds: {m.missingKpis.slice(0, 6).join(", ")}{m.missingKpis.length > 6 ? ` +${m.missingKpis.length - 6}` : ""}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">MCP servers</p>
            <McpScopePicker value={scope} onChange={setScope} token={token} traceServers={traceServers} disabled={busy} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Refresh schedule</p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <ScheduleFields value={schedule} onChange={setSchedule} disabled={busy} />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Expiry</p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div>
                <label className={scheduleLabelCls}>Stops refreshing after</label>
                <select aria-label="Stops refreshing after" className={scheduleSelectCls} value={expiryPreset} disabled={busy} onChange={(e) => setExpiryPreset(e.target.value)}>
                  <option value={EXPIRY_NEVER}>Never</option>
                  {EXPIRY_PRESETS.map((d) => (
                    <option key={d} value={String(d)}>{d} days</option>
                  ))}
                  <option value="custom">Custom date…</option>
                </select>
              </div>
              {expiryPreset === "custom" && (
                <div>
                  <label className={scheduleLabelCls}>Expiry date</label>
                  <input aria-label="Expiry date" type="date" min={today} className={scheduleSelectCls} value={expiryDate} disabled={busy} onChange={(e) => setExpiryDate(e.target.value)} />
                </div>
              )}
              <div>
                <label className={scheduleLabelCls}>First refresh on (optional)</label>
                <input aria-label="First refresh on" type="date" min={today} className={scheduleSelectCls} value={startDate} disabled={busy} onChange={(e) => setStartDate(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Publishing</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={autoPublish} disabled={busy} onChange={(e) => setAutoPublish(e.target.checked)} />
              Publish as soon as it is ready (otherwise review the preview first)
            </label>
          </div>
          </>)}

          {(isStatic || autoPublish) && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Who can see it</p>
              <VisibilityPicker value={visibility} onChange={setVisibility} token={token} requester={requester} disabled={busy} />
            </div>
          )}
        </div>
      )}

      {denyOpen ? (
        <div className="space-y-2 rounded-md border border-destructive/40 p-3">
          <p className="text-sm font-medium">Deny this request</p>
          <Textarea aria-label="Reason for denying the request" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for the requester (optional)" className="min-h-16" disabled={busy} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDenyOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => onDeny(note.trim())} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <X className="mr-2 h-4 w-4" />}
              Deny
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setDenyOpen(true)} disabled={busy}>
            <X className="mr-2 h-4 w-4" /> Deny
          </Button>
          <Button onClick={approve} disabled={!canApprove} className="bg-primary">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
            {isStatic ? "Approve & publish" : autoPublish ? "Approve" : "Approve & run compiler"}
          </Button>
        </div>
      )}
    </div>
  );
}
