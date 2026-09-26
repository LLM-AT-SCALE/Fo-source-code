"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/shared/components/ui/button";
import { REPORT_DASHBOARDS, REPORT_SOURCES, toFrequency } from "@/modules/admin/lib/dashboards/report-schedule";
import { canonicalTz } from "@/shared/lib/timezones";
import {
  ScheduleFields,
  describeScheduleValue,
  scheduleLabelCls,
  scheduleSelectCls,
  scheduleValueErrors,
  scheduleValueFrom,
  scheduleValueToBody,
  type ScheduleValue,
} from "@/modules/admin/components/schedule-fields";

type DashOption = { id: string; label: string };

/** A current schedule row returned by GET, used to pre-fill the form on reschedule. */
type ScheduleRow = {
  dashboardId: string;
  frequency: string;
  intervalMinutes: number | null;
  atTime: string | null;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  timezone: string | null;
  enabled: boolean;
  windowStart: string | null;
  windowEnd: string | null;
};

export type ScheduleFormInitial = {
  database?: string;
  report?: string; // dashboard id/label or "all"
  frequency?: string;
  intervalMinutes?: number;
  atTime?: string; // "HH:MM"
  daysOfWeek?: number[]; // 0-6 list
  dayOfMonth?: number; // 1-31
  enabled?: boolean;
  timezone?: string; // IANA tz for atTime/day (default: the admin's browser tz)
  windowStart?: string; // "HH:MM" — interval active-window start
  windowEnd?: string; // "HH:MM" — interval active-window end
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Resolve a marker's report value to a <select> value: "all", a dashboard id, or "". */
function resolveReportValue(input: string | undefined, list: DashOption[]): string {
  if (!input) return "";
  if (norm(input) === "all") return "all";
  const n = norm(input);
  const hit =
    list.find((d) => norm(d.id) === n || norm(d.label) === n) ??
    list.find((d) => norm(d.label).includes(n));
  return hit ? hit.id : "";
}

/**
 * In-chat form to set a report's refresh schedule. Pre-filled from the current
 * schedule (on reschedule) and/or what the model parsed out of the admin's text;
 * the admin adjusts the dropdowns and confirms. Confirm POSTs to
 * /api/admin/report-schedule (deterministic write).
 */
export function ReportScheduleCard({
  initial,
  active = true,
  token,
  onDone,
}: {
  initial: ScheduleFormInitial;
  active?: boolean;
  token: string | null;
  onDone?: (summary: string | null) => void;
}) {
  const [database, setDatabase] = useState(initial.database || REPORT_SOURCES[0].key);
  const [dashboards, setDashboards] = useState<DashOption[]>(REPORT_DASHBOARDS);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [report, setReport] = useState(() => resolveReportValue(initial.report, REPORT_DASHBOARDS));

  const [schedule, setSchedule] = useState<ScheduleValue>(() => scheduleValueFrom(initial));
  const [enabled, setEnabled] = useState<boolean>(initial.enabled ?? true);

  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Fill the form fields from an existing schedule row (reschedule pre-fill).
  const applySchedule = (s: ScheduleRow) => {
    setSchedule(scheduleValueFrom(s));
    setEnabled(s.enabled ?? true);
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/admin/report-schedule", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { dashboards?: DashOption[]; schedules?: ScheduleRow[] } | null) => {
        if (cancelled || !j) return;
        const live = j.dashboards?.length ? j.dashboards.map((d) => ({ id: d.id, label: d.label })) : REPORT_DASHBOARDS;
        setDashboards(live);
        setSchedules(j.schedules ?? []);
        const id = resolveReportValue(initial.report, live) || report;
        setReport(id);
        // Pre-fill from the existing schedule for this report, then let any
        // fields the admin explicitly named in their message win.
        const existing = (j.schedules ?? []).find((s) => s.dashboardId === id);
        if (existing) {
          const base = scheduleValueFrom(existing);
          setSchedule({
            ...base,
            ...(initial.frequency ? { frequency: toFrequency(initial.frequency) } : {}),
            ...(initial.intervalMinutes ? { intervalMinutes: initial.intervalMinutes } : {}),
            ...(initial.atTime ? { atTime: initial.atTime } : {}),
            ...(initial.timezone ? { timezone: canonicalTz(initial.timezone) } : {}),
            ...(initial.daysOfWeek?.length
              ? { daysOfWeek: [...new Set(initial.daysOfWeek.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b) }
              : {}),
            ...(typeof initial.dayOfMonth === "number" ? { dayOfMonth: initial.dayOfMonth } : {}),
            ...(initial.windowStart ? { windowStart: initial.windowStart } : {}),
            ...(initial.windowEnd ? { windowEnd: initial.windowEnd } : {}),
          });
          setEnabled(typeof initial.enabled === "boolean" ? initial.enabled : (existing.enabled ?? true));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, initial.report]);

  // Switching the report in the dropdown loads that report's current schedule.
  const onReportChange = (id: string) => {
    setReport(id);
    const existing = schedules.find((s) => s.dashboardId === id);
    if (existing) applySchedule(existing);
  };

  const { valid } = scheduleValueErrors(schedule);
  const canSave = active && report !== "" && valid && state !== "saving" && state !== "saved";

  const submit = async () => {
    if (!canSave) return;
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/report-schedule", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ database, report, ...scheduleValueToBody(schedule), enabled }),
      });
      const raw = await res.text();
      const json = raw ? (JSON.parse(raw) as { error?: string; updated?: string[]; nextRunAtUtc?: string }) : {};
      if (!res.ok) throw new Error(json.error ?? `Could not save the schedule (${res.status}).`);

      const scope = report === "all" ? "all reports" : (json.updated?.[0] ?? "the report");
      const summary = enabled
        ? `✅ Scheduled ${scope} — ${describeScheduleValue(schedule)}.`
        : `⏸ Paused the schedule for ${scope}.`;
      setState("saved");
      onDone?.(summary);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Could not save the schedule.");
    }
  };

  const reportOptions = useMemo(
    () => [{ value: "all", label: "All reports" }, ...dashboards.map((d) => ({ value: d.id, label: d.label }))],
    [dashboards],
  );

  const disabled = !active || state === "saving" || state === "saved";

  return (
    <div className="mt-1 rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">🗓</span>
        Schedule report refresh
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          times in {schedule.timezone.replace(/_/g, " ")}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={scheduleLabelCls}>Database</label>
          <select className={scheduleSelectCls} value={database} disabled={disabled} onChange={(e) => setDatabase(e.target.value)}>
            {REPORT_SOURCES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={scheduleLabelCls}>Report</label>
          <select className={scheduleSelectCls} value={report} disabled={disabled} onChange={(e) => onReportChange(e.target.value)}>
            <option value="" disabled>Select a report…</option>
            {reportOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <ScheduleFields value={schedule} onChange={setSchedule} disabled={disabled} />
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border border-input accent-primary" />
        Enabled
      </label>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {state === "saved" && <p className="mt-2 text-xs text-green-600">Saved. Applies within ~5 minutes.</p>}

      {active && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onDone?.(null)} disabled={state === "saving" || state === "saved"}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave} title={report === "" ? "Select a report first" : undefined}>
            {state === "saving" ? "Saving…" : "Confirm"}
          </Button>
        </div>
      )}
    </div>
  );
}
