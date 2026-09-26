"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminPage, AdminFormSection, AdminCollection, AdminToolbar, AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Badge } from "@/shared/components/ui/badge";
import { Checkbox } from "@/shared/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/shared/components/ui/sheet";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import { Plus, BellRing, Trash2, Loader2, Pencil } from "lucide-react";
import type { Comparator } from "@/modules/admin/lib/dashboards/alert-metrics";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface Metric {
  key: string;
  label: string;
  unit: string;
  dashboardId: string;
  suggestedComparator: Comparator;
  suggestedThreshold: number;
  custom?: boolean;
  setKey?: string;
  column?: string;
}

interface Dashboard {
  id: string;
  title: string;
}

interface Role {
  id: string;
  name: string;
}

interface Baseline {
  min: number;
  avg: number;
  max: number;
  count: number;
  current: number | null;
  since: string | null;
}

const DEFAULT_RECIPIENT_ROLE_NAMES = ["Shift Lead", "Shift Supervisor", "Admin"];

interface Threshold {
  id: string;
  metricKey: string;
  metricLabel: string;
  legacy?: boolean;
  unit: string;
  label: string | null;
  comparator: Comparator;
  minValue: number | null;
  maxValue: number | null;
  dashboardId: string | null;
  throttleMin: number;
  isActive: boolean;
  recipientRoleIds: string[];
  updatedAt: string;
}

const COMPARATOR_LABEL: Record<Comparator, string> = {
  gt: "greater than (max)",
  lt: "less than (min)",
  outside: "outside range (min–max)",
};

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export default function AlertThresholdsPage() {
  const [thresholds, setThresholds] = useState<Threshold[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [baselines, setBaselines] = useState<Record<string, Baseline>>({});
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Threshold | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const confirm = useConfirm();

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });


  // Form state
  const [dashboardId, setDashboardId] = useState("");
  const [metricKey, setMetricKey] = useState("");
  const [comparator, setComparator] = useState<Comparator>("gt");
  const [minValue, setMinValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [throttleMin, setThrottleMin] = useState("60");
  const [isActive, setIsActive] = useState(true);
  const [label, setLabel] = useState("");
  const [recipientRoleIds, setRecipientRoleIds] = useState<string[]>([]);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/alert-thresholds", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setThresholds(data.thresholds || []);
      setMetrics(data.metrics || []);
      setDashboards(data.dashboards || []);
      setRoles(data.roles || []);
      setBaselines(data.baselines || {});
    } catch {
      toast.error("Failed to load alert thresholds");
    } finally {
      setLoading(false);
    }
  }, [token]);

  /** Delete several thresholds through one call: explicit ids, or every legacy row. */
  const bulkDelete = async (selector: { ids: string[] } | { legacy: true }, label: string) => {
    const ok = await confirm({
      title: `Delete ${label}?`,
      description: "These alerts will stop being evaluated. This cannot be undone.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const res = await fetch(`/api/admin/alert-thresholds/bulk-delete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(selector),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error || "Failed to delete");
        return;
      }
      toast.success(`Deleted ${d.deleted ?? 0} threshold${d.deleted === 1 ? "" : "s"}`);
      setSelected(new Set());
      await fetchData();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setBulkBusy(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openAdd = () => {
    setEditing(null);
    setDashboardId("");
    setMetricKey("");
    setComparator("gt");
    setMinValue("");
    setMaxValue("");
    setThrottleMin("60");
    setIsActive(true);
    setLabel("");
    // Pre-select the default alert roles that exist.
    setRecipientRoleIds(roles.filter((r) => DEFAULT_RECIPIENT_ROLE_NAMES.includes(r.name)).map((r) => r.id));
    setDialogOpen(true);
  };

  const openEdit = (t: Threshold) => {
    setEditing(t);
    setDashboardId(metrics.find((m) => m.key === t.metricKey)?.dashboardId ?? t.dashboardId ?? "");
    setMetricKey(t.metricKey);
    setComparator(t.comparator);
    setMinValue(t.minValue === null ? "" : String(t.minValue));
    setMaxValue(t.maxValue === null ? "" : String(t.maxValue));
    setThrottleMin(String(t.throttleMin));
    setIsActive(t.isActive);
    setLabel(t.label ?? "");
    setRecipientRoleIds(t.recipientRoleIds ?? []);
    setDialogOpen(true);
  };

  const toggleRecipient = (roleId: string) => {
    setRecipientRoleIds((prev) => (prev.includes(roleId) ? prev.filter((x) => x !== roleId) : [...prev, roleId]));
  };

  // Choosing a dashboard resets the metric selection (add mode).
  const onDashboardChange = (id: string) => {
    setDashboardId(id);
    setMetricKey("");
  };

  // Picking a metric (add mode) auto-fills the comparator, then a threshold just
  // outside the observed normal range (from live samples) — or the static
  // suggestion if there are no samples yet.
  const onMetricChange = (key: string) => {
    setMetricKey(key);
    const m = metrics.find((x) => x.key === key);
    if (m && !editing) {
      setComparator(m.suggestedComparator);
      setMinValue("");
      setMaxValue("");
      const b = baselines[key];
      if (m.suggestedComparator === "gt") {
        const v = b ? Math.ceil(b.max + Math.max(1, Math.abs(b.max) * 0.05)) : m.suggestedThreshold;
        setMaxValue(String(v));
      } else if (m.suggestedComparator === "lt") {
        const v = b ? Math.max(0, Math.floor(b.min - Math.max(1, Math.abs(b.min) * 0.05))) : m.suggestedThreshold;
        setMinValue(String(v));
      }
    }
  };

  const dashboardTitle = (id: string | null) => dashboards.find((d) => d.id === id)?.title ?? id ?? "—";
  const metricsForDashboard = metrics.filter((m) => m.dashboardId === dashboardId);
  const recipientText = (ids: string[]) => {
    if (!ids || ids.length === 0) return "Default roles";
    const names = ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean);
    return names.length ? names.join(", ") : "—";
  };

  const handleSave = async () => {
    if (!metricKey) return toast.error("Pick a metric");
    setSaving(true);
    try {
      const selected = metrics.find((m) => m.key === metricKey);
      const body = {
        metricKey,
        comparator,
        minValue: minValue === "" ? null : Number(minValue),
        maxValue: maxValue === "" ? null : Number(maxValue),
        throttleMin: Number(throttleMin) || 60,
        isActive,
        label: label.trim() || null,
        dashboardId: selected?.dashboardId ?? null,
        recipientRoleIds,
        customSetKey: selected?.setKey ?? null,
        customColumn: selected?.column ?? null,
      };
      const url = editing ? `/api/admin/alert-thresholds/${editing.id}` : "/api/admin/alert-thresholds";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Failed to save");
        return;
      }
      toast.success(editing ? "Threshold updated" : "Threshold added");
      setDialogOpen(false);
      fetchData();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (t: Threshold) => {
    const ok = await confirm({
      title: `Delete the "${t.metricLabel}" threshold?`,
      description: "This alert will stop being evaluated.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/admin/alert-thresholds/${t.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Failed to delete");
        return;
      }
      toast.success("Threshold deleted");
      fetchData();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (t: Threshold) => {
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/admin/alert-thresholds/${t.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Failed to update");
        return;
      }
      fetchData();
    } catch {
      toast.error("Failed to update");
    } finally {
      setBusyId(null);
    }
  };

  const boundText = (t: Threshold) => {
    const u = t.unit === "%" ? "%" : "";
    if (t.comparator === "gt") return `> ${t.maxValue}${u}`;
    if (t.comparator === "lt") return `< ${t.minValue}${u}`;
    return `outside ${t.minValue}${u}–${t.maxValue}${u}`;
  };

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="Monitoring"
        title="Alert Thresholds"
        description="Monitor dashboard metrics and notify the selected roles when a value crosses its limits."
      >
        <Button onClick={openAdd} className="bg-primary">
          <Plus className="mr-2 h-4 w-4" /> Add Threshold
        </Button>
      </AdminPageHeader>

      <AdminCollection>
      <AdminCollectionHeader title="Alert rules" description="Select rules for bulk actions, or edit a rule to adjust its limits." count={loading ? undefined : thresholds.length} />


      {(selected.size > 0 || thresholds.some((t) => t.legacy)) && (
        <AdminToolbar label="Bulk alert actions">
        {selected.size > 0 && (
          <Button variant="destructive" onClick={() => bulkDelete({ ids: [...selected] }, `${selected.size} selected threshold${selected.size === 1 ? "" : "s"}`)} disabled={bulkBusy}>
            {bulkBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />} Delete selected ({selected.size})
          </Button>
        )}
        {thresholds.some((t) => t.legacy) && (
          <Button variant="outline" onClick={() => bulkDelete({ legacy: true }, `all ${thresholds.filter((t) => t.legacy).length} legacy threshold${thresholds.filter((t) => t.legacy).length === 1 ? "" : "s"}`)} disabled={bulkBusy}>
            <Trash2 className="mr-2 h-4 w-4 text-amber-600" /> Delete legacy
          </Button>
        )}
        </AdminToolbar>
      )}



      <div className="admin-table-surface" role="region" aria-label="Alert thresholds" tabIndex={0}>
        <Table className="min-w-[1000px] text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select all thresholds"
                  checked={thresholds.length > 0 && selected.size === thresholds.length}
                  onCheckedChange={(v) => setSelected(v === true ? new Set(thresholds.map((t) => t.id)) : new Set())}
                />
              </TableHead>
              <TableHead>Dashboard</TableHead>
              <TableHead>Metric</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Throttle</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : thresholds.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3 whitespace-normal py-6">
                    <p className="text-sm font-semibold">No alert rules yet</p>
                    <p className="text-sm text-muted-foreground">Add a threshold to start monitoring dashboard metrics.</p>
                    <Button size="sm" onClick={openAdd}><Plus aria-hidden="true" />Add Threshold</Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              thresholds.map((t) => (
                <TableRow key={t.id} data-state={selected.has(t.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox aria-label={`Select ${t.label || t.metricLabel}`} checked={selected.has(t.id)} onCheckedChange={() => toggleSelected(t.id)} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{dashboardTitle(t.dashboardId)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <BellRing className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{t.label || t.metricLabel}</div>
                        <div className="text-xs text-muted-foreground">{t.metricKey}</div>
                        {t.legacy && (
                          <div className="text-xs text-amber-600">
                            Legacy metric — no longer evaluated.{" "}
                            <button type="button" className="underline" onClick={() => handleDelete(t)} disabled={busyId === t.id}>Delete</button>
                            {" "}and re-create it on a live dashboard column.
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{boundText(t)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{t.throttleMin} min</TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">{recipientText(t.recipientRoleIds)}</TableCell>
                  <TableCell>
                    <button onClick={() => toggleActive(t)} disabled={busyId === t.id || t.legacy} title={t.legacy ? "Legacy metric — cannot be re-activated" : undefined}>
                      {t.isActive ? (
                        <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">Paused</Badge>
                      )}
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(t)} disabled={busyId === t.id}>
                        {busyId === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      </AdminCollection>

      <Sheet open={dialogOpen} onOpenChange={setDialogOpen}>
        <SheetContent className="admin-overlay overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{editing ? "Edit threshold" : "Add threshold"}</SheetTitle>
            <SheetDescription>
              Alerts email the Shift Lead, Shift Supervisor, and Admin roles when the metric crosses this range.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-4">
          <AdminFormSection title="Monitored metric" description="Choose a dashboard and metric to see its observed range.">
            <div className="space-y-2">
              <Label htmlFor="threshold-dashboard">Dashboard</Label>
              <select id="threshold-dashboard"
                className={selectClass}
                value={dashboardId}
                onChange={(e) => onDashboardChange(e.target.value)}
                disabled={!!editing}
              >
                <option value="">Select a dashboard…</option>
                {dashboards.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="threshold-metric">Metric</Label>
              <select id="threshold-metric"
                className={selectClass}
                value={metricKey}
                onChange={(e) => onMetricChange(e.target.value)}
                disabled={!!editing || !dashboardId}
              >
                <option value="">{dashboardId ? "Select a metric…" : "Pick a dashboard first"}</option>
                {metricsForDashboard.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            {metricKey && (() => {
              const b = baselines[metricKey];
              const unit = metrics.find((m) => m.key === metricKey)?.unit === "%" ? "%" : "";
              const f = (x: number | null | undefined) =>
                x === null || x === undefined ? "—" : (Number.isInteger(x) ? String(x) : x.toFixed(1)) + unit;
              return (
                <div className="rounded-md border bg-muted/40 p-3 text-xs">
                  {b ? (
                    <>
                      <div className="font-medium text-foreground">Normal range · last 7 days</div>
                      <div className="mt-1 text-muted-foreground">
                        Current <span className="font-mono text-foreground">{f(b.current)}</span> · range{" "}
                        <span className="font-mono text-foreground">{f(b.min)} – {f(b.max)}</span> · avg{" "}
                        <span className="font-mono text-foreground">{f(b.avg)}</span>
                      </div>
                      <div className="mt-0.5 text-muted-foreground">from {b.count} sample{b.count === 1 ? "" : "s"}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      No samples yet — the normal range builds as the scheduler records live values.
                    </span>
                  )}
                </div>
              );
            })()}

          </AdminFormSection>

          <AdminFormSection title="Alert condition">
            <div className="space-y-2">
              <Label htmlFor="threshold-comparator">Alert when the value is</Label>
              <select id="threshold-comparator" className={selectClass} value={comparator} onChange={(e) => setComparator(e.target.value as Comparator)}>
                <option value="gt">{COMPARATOR_LABEL.gt}</option>
                <option value="lt">{COMPARATOR_LABEL.lt}</option>
                <option value="outside">{COMPARATOR_LABEL.outside}</option>
              </select>
            </div>

            <div className="flex gap-3">
              {(comparator === "lt" || comparator === "outside") && (
                <div className="flex-1 space-y-2">
                  <Label htmlFor="threshold-min">Min</Label>
                  <Input id="threshold-min" type="number" value={minValue} onChange={(e) => setMinValue(e.target.value)} placeholder="e.g. 90" />
                </div>
              )}
              {(comparator === "gt" || comparator === "outside") && (
                <div className="flex-1 space-y-2">
                  <Label htmlFor="threshold-max">Max</Label>
                  <Input id="threshold-max" type="number" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} placeholder="e.g. 30" />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="threshold-throttle">Throttle (minutes between repeat alerts)</Label>
              <Input id="threshold-throttle" type="number" value={throttleMin} onChange={(e) => setThrottleMin(e.target.value)} min={1} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="threshold-label">Custom label (optional)</Label>
              <Input id="threshold-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Defaults to the metric name" />
            </div>

          </AdminFormSection>

            <div className="space-y-2">
              <Label>Email these roles</Label>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-3">
                {roles.length === 0 && <p className="text-xs text-muted-foreground">No roles found.</p>}
                {roles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={recipientRoleIds.includes(r.id)} onCheckedChange={() => toggleRecipient(r.id)} />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Users in the selected roles get the alert email. Leave all unchecked to fall back to the default alert roles
                (Shift Lead, Shift Supervisor, Admin).
              </p>
            </div>

            <label className="flex items-center gap-2">
              <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(!!v)} />
              <span className="text-sm">Active</span>
            </label>
          </div>

          <div className="mt-8 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="bg-primary">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Add threshold"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </AdminPage>
  );
}
