"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/button";
import type { Comparator } from "@/modules/admin/lib/dashboards/alert-metrics";

type Metric = {
  key: string;
  label: string;
  unit: string;
  dashboardId: string;
  suggestedComparator: Comparator;
  suggestedThreshold: number;
  custom?: boolean;
  setKey?: string;
  column?: string;
};
type Dashboard = { id: string; title: string; custom?: boolean };
type Role = { id: string; name: string };
type Baseline = { min: number; avg: number; max: number; count: number; current: number | null };

/** Prefill parsed from the model's [[alert-threshold: {...}]] marker. All optional. */
export type AlertThresholdInitial = {
  dashboardId?: string;
  metricKey?: string;
  comparator?: string;
  minValue?: number;
  maxValue?: number;
  throttleMin?: number;
  recipientRoleNames?: string[];
  recipientRoleIds?: string[];
  label?: string;
  isActive?: boolean;
};

const DEFAULT_RECIPIENT_ROLE_NAMES = ["Shift Lead", "Shift Supervisor", "Admin"];
const selectCls =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-xs font-medium text-muted-foreground mb-1";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * In-chat form to create a discrepancy alert threshold. Pre-filled from what the
 * model parsed out of the admin's text; the admin adjusts and confirms. Confirm
 * POSTs to /api/admin/alert-thresholds (the same deterministic write the Alert
 * Thresholds page uses).
 */
export function AlertThresholdCard({
  initial,
  active = true,
  token,
  onDone,
}: {
  initial: AlertThresholdInitial;
  active?: boolean;
  token: string | null;
  onDone?: (summary: string | null) => void;
}) {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [baselines, setBaselines] = useState<Record<string, Baseline>>({});

  const [dashboardId, setDashboardId] = useState(initial.dashboardId || "");
  const [metricKey, setMetricKey] = useState(initial.metricKey || "");
  const [comparator, setComparator] = useState<Comparator>((initial.comparator as Comparator) || "gt");
  const [minValue, setMinValue] = useState(initial.minValue === undefined ? "" : String(initial.minValue));
  const [maxValue, setMaxValue] = useState(initial.maxValue === undefined ? "" : String(initial.maxValue));
  const [throttleMin, setThrottleMin] = useState(String(initial.throttleMin ?? 60));
  const [isActive, setIsActive] = useState(initial.isActive ?? true);
  const [recipientRoleIds, setRecipientRoleIds] = useState<string[]>(initial.recipientRoleIds ?? []);

  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const prefilled = useRef(false);

  // Load the live catalog (metrics/dashboards/roles/baselines) and apply the
  // model's prefill once against it.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/admin/alert-thresholds", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { metrics?: Metric[]; dashboards?: Dashboard[]; roles?: Role[]; baselines?: Record<string, Baseline> } | null) => {
        if (cancelled || !j) return;
        setMetrics(j.metrics ?? []);
        setDashboards(j.dashboards ?? []);
        setRoles(j.roles ?? []);
        setBaselines(j.baselines ?? {});
        if (prefilled.current) return;
        prefilled.current = true;

        // Resolve metric → dashboard, comparator, and a starting threshold.
        const m = (j.metrics ?? []).find((x) => x.key === initial.metricKey);
        if (m) {
          setMetricKey(m.key);
          setDashboardId(m.dashboardId);
          if (!initial.comparator) setComparator(m.suggestedComparator);
          if (initial.minValue === undefined && initial.maxValue === undefined) {
            const b = (j.baselines ?? {})[m.key];
            const cmp = (initial.comparator as Comparator) || m.suggestedComparator;
            if (cmp === "gt") setMaxValue(String(b ? Math.ceil(b.max + Math.max(1, Math.abs(b.max) * 0.05)) : m.suggestedThreshold));
            else if (cmp === "lt") setMinValue(String(b ? Math.max(0, Math.floor(b.min - Math.max(1, Math.abs(b.min) * 0.05))) : m.suggestedThreshold));
          }
        } else if (initial.dashboardId) {
          setDashboardId(initial.dashboardId);
        }

        // Resolve recipient role names → ids; default to the three alert roles.
        const allRoles = j.roles ?? [];
        if ((initial.recipientRoleIds ?? []).length === 0) {
          const names = initial.recipientRoleNames?.length ? initial.recipientRoleNames : DEFAULT_RECIPIENT_ROLE_NAMES;
          const wanted = new Set(names.map(norm));
          setRecipientRoleIds(allRoles.filter((r) => wanted.has(norm(r.name))).map((r) => r.id));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const metricsForDashboard = useMemo(() => metrics.filter((m) => m.dashboardId === dashboardId), [metrics, dashboardId]);
  const selectedMetric = useMemo(() => metrics.find((m) => m.key === metricKey), [metrics, metricKey]);
  const baseline = baselines[metricKey];

  const onDashboardChange = (id: string) => {
    setDashboardId(id);
    setMetricKey("");
  };

  const onMetricChange = (key: string) => {
    setMetricKey(key);
    const m = metrics.find((x) => x.key === key);
    if (!m) return;
    setComparator(m.suggestedComparator);
    setMinValue("");
    setMaxValue("");
    const b = baselines[key];
    if (m.suggestedComparator === "gt") setMaxValue(String(b ? Math.ceil(b.max + Math.max(1, Math.abs(b.max) * 0.05)) : m.suggestedThreshold));
    else if (m.suggestedComparator === "lt") setMinValue(String(b ? Math.max(0, Math.floor(b.min - Math.max(1, Math.abs(b.min) * 0.05))) : m.suggestedThreshold));
  };

  const toggleRecipient = (id: string) =>
    setRecipientRoleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const unit = selectedMetric?.unit === "%" ? "%" : "";
  const fmt = (x: number | null | undefined) =>
    x === null || x === undefined ? "—" : (Number.isInteger(x) ? String(x) : x.toFixed(1)) + unit;
  const boundText = () => {
    if (comparator === "gt") return `> ${maxValue}${unit}`;
    if (comparator === "lt") return `< ${minValue}${unit}`;
    return `outside ${minValue}${unit}–${maxValue}${unit}`;
  };

  const boundsValid =
    comparator === "gt" ? maxValue !== "" : comparator === "lt" ? minValue !== "" : minValue !== "" && maxValue !== "";
  const canSave = active && metricKey !== "" && boundsValid && state !== "saving" && state !== "saved";
  const disabled = !active || state === "saving" || state === "saved";

  const submit = async () => {
    if (!canSave) return;
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/alert-thresholds", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          metricKey,
          comparator,
          minValue: minValue === "" ? null : Number(minValue),
          maxValue: maxValue === "" ? null : Number(maxValue),
          throttleMin: Number(throttleMin) || 60,
          isActive,
          label: initial.label || null,
          dashboardId: selectedMetric?.dashboardId ?? dashboardId ?? null,
          recipientRoleIds,
          customSetKey: selectedMetric?.setKey ?? null,
          customColumn: selectedMetric?.column ?? null,
        }),
      });
      const raw = await res.text();
      const json = raw ? (JSON.parse(raw) as { error?: string }) : {};
      if (!res.ok) throw new Error(json.error ?? `Could not save the alert (${res.status}).`);

      const who =
        recipientRoleIds.length === 0
          ? "the default alert roles"
          : recipientRoleIds.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(", ");
      const name = selectedMetric?.label ?? metricKey;
      const summary = isActive
        ? `✅ Alert set: ${name} ${boundText()} → emails ${who}.`
        : `⏸ Saved (paused) alert: ${name} ${boundText()}.`;
      setState("saved");
      onDone?.(summary);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Could not save the alert.");
    }
  };

  return (
    <div className="mt-1 rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">🔔</span>
        Set discrepancy alert
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Dashboard</label>
          <select className={selectCls} value={dashboardId} disabled={disabled} onChange={(e) => onDashboardChange(e.target.value)}>
            <option value="">Select a dashboard…</option>
            {dashboards.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls}>Metric</label>
          <select className={selectCls} value={metricKey} disabled={disabled || !dashboardId} onChange={(e) => onMetricChange(e.target.value)}>
            <option value="">{dashboardId ? "Select a metric…" : "Pick a dashboard first"}</option>
            {metricsForDashboard.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {metricKey && (
        <div className="mt-2 rounded-md border bg-muted/40 p-2.5 text-xs">
          {baseline ? (
            <span className="text-muted-foreground">
              Normal (7d): <span className="font-mono text-foreground">{fmt(baseline.min)} – {fmt(baseline.max)}</span> · avg{" "}
              <span className="font-mono text-foreground">{fmt(baseline.avg)}</span> · current{" "}
              <span className="font-mono text-foreground">{fmt(baseline.current)}</span> ({baseline.count} samples)
            </span>
          ) : (
            <span className="text-muted-foreground">No samples yet — range builds as the scheduler records live values.</span>
          )}
        </div>
      )}

      <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Alert when the value is</label>
          <select className={selectCls} value={comparator} disabled={disabled} onChange={(e) => setComparator(e.target.value as Comparator)}>
            <option value="gt">greater than (max)</option>
            <option value="lt">less than (min)</option>
            <option value="outside">outside range (min–max)</option>
          </select>
        </div>
        <div className="flex gap-2">
          {(comparator === "lt" || comparator === "outside") && (
            <div className="flex-1">
              <label className={labelCls}>Min</label>
              <input type="number" className={selectCls} value={minValue} disabled={disabled} onChange={(e) => setMinValue(e.target.value)} />
            </div>
          )}
          {(comparator === "gt" || comparator === "outside") && (
            <div className="flex-1">
              <label className={labelCls}>Max</label>
              <input type="number" className={selectCls} value={maxValue} disabled={disabled} onChange={(e) => setMaxValue(e.target.value)} />
            </div>
          )}
        </div>

        <div>
          <label className={labelCls}>Throttle (min between repeat alerts)</label>
          <input type="number" min={1} className={selectCls} value={throttleMin} disabled={disabled} onChange={(e) => setThrottleMin(e.target.value)} />
        </div>
      </div>

      <div className="mt-2.5">
        <label className={labelCls}>Email these roles</label>
        <div className="flex flex-wrap gap-1.5">
          {roles.map((r) => {
            const on = recipientRoleIds.includes(r.id);
            return (
              <button
                key={r.id}
                type="button"
                disabled={disabled}
                onClick={() => toggleRecipient(r.id)}
                className={
                  "h-8 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-60 " +
                  (on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-foreground hover:bg-accent")
                }
              >
                {r.name}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">Leave all off to use the default alert roles.</p>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isActive} disabled={disabled} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 rounded border border-input accent-primary" />
        Active
      </label>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {state === "saved" && <p className="mt-2 text-xs text-green-600">Saved. Evaluated on the next scheduler tick.</p>}

      {active && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onDone?.(null)} disabled={state === "saving" || state === "saved"}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave} title={metricKey === "" ? "Pick a metric first" : undefined}>
            {state === "saving" ? "Saving…" : "Confirm"}
          </Button>
        </div>
      )}
    </div>
  );
}
