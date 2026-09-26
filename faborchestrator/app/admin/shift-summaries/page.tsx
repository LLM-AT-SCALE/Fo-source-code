"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminPage, AdminFormSection, AdminCollection, AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Badge } from "@/shared/components/ui/badge";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/shared/components/ui/sheet";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import { Plus, Mail, Trash2, Loader2, Pencil } from "lucide-react";
import { listTimezones } from "@/shared/lib/timezones";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface Role { id: string; name: string }
interface Dashboard { id: string; title: string }
interface Shift {
  id: string;
  name: string;
  sendTime: string;
  timezone: string;
  recipientRoleIds: string[];
  dashboardIds: string[];
  isActive: boolean;
  lastStatus: string | null;
}

const DEFAULT_ROLE_NAMES = ["Shift Lead", "Shift Supervisor", "Admin"];
const CURATED_7 = [
  "factory-operations", "lot-history", "process-analytics", "maintenance-prediction",
  "bottleneck-prediction", "analytics-dashboard", "executive-overview",
];
const TZ_OPTIONS = listTimezones();
const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";

export default function ShiftSummariesPage() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirm = useConfirm();

  const [name, setName] = useState("");
  const [sendTime, setSendTime] = useState("06:00");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [recipientRoleIds, setRecipientRoleIds] = useState<string[]>([]);
  const [dashboardIds, setDashboardIds] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/shift-summaries", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setShifts(data.shifts || []);
      setRoles(data.roles || []);
      setDashboards(data.dashboards || []);
    } catch {
      toast.error("Failed to load shift summaries");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openAdd = () => {
    setEditing(null);
    setName("");
    setSendTime("06:00");
    setTimezone("America/Los_Angeles");
    setRecipientRoleIds(roles.filter((r) => DEFAULT_ROLE_NAMES.includes(r.name)).map((r) => r.id));
    setDashboardIds(CURATED_7);
    setIsActive(true);
    setDialogOpen(true);
  };

  const openEdit = (s: Shift) => {
    setEditing(s);
    setName(s.name);
    setSendTime(s.sendTime);
    setTimezone(s.timezone);
    setRecipientRoleIds(s.recipientRoleIds ?? []);
    setDashboardIds(s.dashboardIds?.length ? s.dashboardIds : CURATED_7);
    setIsActive(s.isActive);
    setDialogOpen(true);
  };

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const handleSave = async () => {
    if (!name.trim()) return toast.error("Enter a name");
    setSaving(true);
    try {
      const body = { name: name.trim(), sendTime, timezone, recipientRoleIds, dashboardIds, isActive };
      const url = editing ? `/api/admin/shift-summaries/${editing.id}` : "/api/admin/shift-summaries";
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
      toast.success(editing ? "Shift summary updated" : "Shift summary added");
      setDialogOpen(false);
      fetchData();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: Shift) => {
    const ok = await confirm({ title: `Delete "${s.name}"?`, description: "This shift summary email will stop being sent.", confirmText: "Delete", destructive: true });
    if (!ok) return;
    setBusyId(s.id);
    try {
      const res = await fetch(`/api/admin/shift-summaries/${s.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { toast.error("Failed to delete"); return; }
      toast.success("Deleted");
      fetchData();
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (s: Shift) => {
    setBusyId(s.id);
    try {
      const res = await fetch(`/api/admin/shift-summaries/${s.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !s.isActive }),
      });
      if (!res.ok) { toast.error("Failed to update"); return; }
      fetchData();
    } finally {
      setBusyId(null);
    }
  };

  const roleNames = (ids: string[]) =>
    ids.length ? ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(", ") : "Default roles";
  const dashCount = (ids: string[]) => (ids.length ? `${ids.length} dashboards` : "All 7 curated");

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="Monitoring"
        title="Shift Summaries"
        description="Schedule dashboard summaries for your shift teams, using each schedule’s selected timezone."
      >
        <Button onClick={openAdd} className="bg-primary">
          <Plus className="mr-2 h-4 w-4" /> Add Shift Summary
        </Button>
      </AdminPageHeader>

      <AdminCollection>


      <AdminCollectionHeader title="Delivery schedules" description="Review send times, recipients, and active schedules." count={loading ? undefined : shifts.length} />

      <div className="admin-table-surface" role="region" aria-label="Shift summaries" tabIndex={0}>
        <Table className="min-w-[900px] text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Send time</TableHead>
              <TableHead>Timezone</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Dashboards</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow>
            ) : shifts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3 whitespace-normal py-6">
                    <p className="text-sm font-semibold">No delivery schedules yet</p>
                    <p className="text-sm text-muted-foreground">Create a shift summary and choose when your team receives it.</p>
                    <Button size="sm" onClick={openAdd}><Plus aria-hidden="true" />Add Shift Summary</Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              shifts.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{s.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{s.sendTime}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.timezone.replace(/_/g, " ")}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">{roleNames(s.recipientRoleIds)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{dashCount(s.dashboardIds)}</TableCell>
                  <TableCell>
                    <button aria-label={`${s.isActive ? "Pause" : "Activate"} ${s.name}`} onClick={() => toggleActive(s)} disabled={busyId === s.id}>
                      {s.isActive ? (
                        <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">Paused</Badge>
                      )}
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" aria-label={`Edit ${s.name}`} onClick={() => openEdit(s)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete ${s.name}`} onClick={() => handleDelete(s)} disabled={busyId === s.id}>
                        {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}
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
            <SheetTitle>{editing ? "Edit shift summary" : "Add shift summary"}</SheetTitle>
            <SheetDescription>Emails an overall summary + each dashboard&apos;s summary to the selected roles at the send time.</SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-4">
          <AdminFormSection title="Delivery schedule">
            <div className="space-y-2">
              <Label htmlFor="shift-name">Name</Label>
              <Input id="shift-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Swing 1 — end" />
            </div>

            <div className="flex gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="shift-time">Send time</Label>
                <Input id="shift-time" type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} />
              </div>
              <div className="flex-[2] space-y-2">
                <Label htmlFor="shift-timezone">Timezone</Label>
                <select id="shift-timezone" className={selectClass} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {TZ_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
              </div>
            </div>

          </AdminFormSection>

          <AdminFormSection title="Audience & content">
            <div className="space-y-2">
              <Label>Email these roles</Label>
              <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-md border p-3">
                {roles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={recipientRoleIds.includes(r.id)} onCheckedChange={() => toggle(recipientRoleIds, setRecipientRoleIds, r.id)} />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">Leave all off to use the default roles (Shift Lead, Shift Supervisor, Admin).</p>
            </div>

            <div className="space-y-2">
              <Label>Dashboards in the email</Label>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-3">
                {dashboards.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={dashboardIds.includes(d.id)} onCheckedChange={() => toggle(dashboardIds, setDashboardIds, d.id)} />
                    <span>{d.title}</span>
                  </label>
                ))}
              </div>
            </div>

          </AdminFormSection>

            <label className="flex items-center gap-2">
              <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(!!v)} />
              <span className="text-sm">Active</span>
            </label>
          </div>

          <div className="mt-8 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="bg-primary">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Add"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </AdminPage>
  );
}
