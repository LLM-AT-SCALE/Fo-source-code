"use client";

import { useState, useEffect, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/shared/components/ui/sheet";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Textarea } from "@/shared/components/ui/textarea";
import { Label } from "@/shared/components/ui/label";
import { Separator } from "@/shared/components/ui/separator";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Badge } from "@/shared/components/ui/badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, X, Database } from "lucide-react";
import { RoleChipsSection } from "@/modules/admin/components/role-chips-section";
import { McpAgentAssignments } from "@/modules/admin/components/mcp-agent-assignments";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";
import { ADMIN_ROLE_NAME } from "@/shared/lib/permissions";


function RoleMcpSection({ roleId }: { roleId: string }) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <p className="text-sm font-medium">Role MCP Access</p>
      <p className="text-xs text-muted-foreground">Connectors are attached per agent. Each agent sees only its own list; an agent with none attached has no connectors.</p>
      <McpAgentAssignments roleId={roleId} />
    </div>
  );
}

interface CmfGrant { id: string; dbKey: string; label: string }
interface CmfConn { dbKey: string; label: string; enabled: boolean }

function RoleCmfSection({ roleId }: { roleId: string }) {
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  const [assigned, setAssigned] = useState<CmfGrant[]>([]);
  const [catalog, setCatalog] = useState<CmfConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [aRes, cRes] = await Promise.all([
        fetch(`/api/admin/cmf-access?roleId=${roleId}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/database-connections`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const a = await aRes.json(); const c = await cRes.json();
      setAssigned(a.grants || []);
      setCatalog((c.connections || []).filter((x: CmfConn) => x.enabled));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [token, roleId]);

  useEffect(() => { load(); }, [load]);

  const assign = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/cmf-access`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dbKey: pick, roleId }),
      });
      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed to grant"); return; }
      toast.success("Database granted to role");
      setPick(""); load();
    } catch { toast.error("Failed to grant"); } finally { setBusy(false); }
  };

  const remove = async (grantId: string, label: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/cmf-access/${grantId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { toast.error("Failed to remove"); return; }
      toast.success(`"${label}" removed`); load();
    } catch { toast.error("Failed to remove"); } finally { setBusy(false); }
  };

  const available = catalog.filter((c) => !assigned.some((a) => a.dbKey === c.dbKey));

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <p className="text-sm font-medium">Role CMF Database Access</p>
      <p className="text-xs text-muted-foreground">Databases granted here are available to every user in this role.</p>
      {loading ? (
        <div className="h-8 animate-pulse rounded-md bg-muted" />
      ) : (
        <>
          {assigned.length === 0 ? (
            <p className="text-sm text-muted-foreground">None granted.</p>
          ) : (
            <div className="space-y-1.5">
              {assigned.map((g) => (
                <div key={g.id} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                  <Database className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm">{g.label}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => remove(g.id, g.label)} title="Remove" aria-label={`Remove ${g.label}`}>
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Select value={pick} onValueChange={setPick} disabled={available.length === 0}>
              <SelectTrigger aria-label="Grant CMF database to role" className="h-9 w-full flex-1">
                <SelectValue placeholder={available.length ? "Grant a database..." : "All databases granted"} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {available.map((c) => <SelectItem key={c.dbKey} value={c.dbKey}>{c.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button type="button" size="sm" disabled={!pick || busy} onClick={assign} aria-label="Grant database">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

interface RoleFormData {
  name: string;
  description: string;
  permissions: string[];
  allowedModels: string[];
  systemInstructions: string;
  customInstructionsEnabled: boolean;
  customInstructionsMaxLength: number;
  personalMcpEnabled: boolean;
  personalMcpMaxCount: number;
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  /** Ordered prompt-chip ids; only meaningful with the "dashboards" permission. */
  promptChipIds: string[];
}

 
interface RoleFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  // Loosely-typed role record hydrated from the API (fields read with guards below).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editRole?: Record<string, any> | null;
}

/** Platform models come from the shared model registry (Admin → Models). */
type RegistryModel = { modelId: string; displayName: string; description: string | null; isActive: boolean; isDefault: boolean; sortOrder: number };

const defaultForm: RoleFormData = {
  name: "", description: "", permissions: ["chat"], allowedModels: [],
  systemInstructions: "", customInstructionsEnabled: true,
  customInstructionsMaxLength: 1000, personalMcpEnabled: false,
  personalMcpMaxCount: 3, dailyRequestLimit: null, dailyTokenLimit: null,
  promptChipIds: [],
};

export function RoleFormModal({ open, onClose, onSaved, editRole }: RoleFormModalProps) {
  const [form, setForm] = useState<RoleFormData>(defaultForm);
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState<"general" | "models" | "limits" | "tools" | "databases">("general");
  const [errors, setErrors] = useState<{ name?: string; models?: string }>({});
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  const hasDashboards = form.permissions.includes("dashboards");
  // The built-in Admin role always has every permission; the form shows that and locks it.
  const isBuiltInAdmin = !!editRole && editRole.isSystemRole === true && editRole.name === ADMIN_ROLE_NAME;

  // Only models that are active in the registry can be granted to a role.
  const [registryModels, setRegistryModels] = useState<RegistryModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    setModelsLoading(true);
    fetch(`/api/admin/model-registry`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((data: { models?: RegistryModel[] }) => {
        if (cancelled) return;
        const rows = Array.isArray(data?.models) ? data.models : [];
        setRegistryModels(rows.filter((m) => m.isActive).sort((a, b) => a.sortOrder - b.sortOrder));
      })
      .catch(() => { if (!cancelled) setRegistryModels([]); })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [open, token]);
  const registryIds = registryModels.map((m) => m.modelId);

  useEffect(() => {
    if (editRole) {
      setForm({
        name: editRole.name || "",
        description: editRole.description || "",
        permissions: Array.isArray(editRole.permissions) ? editRole.permissions : [],
        allowedModels: Array.isArray(editRole.allowedModels) ? editRole.allowedModels : [],
        systemInstructions: editRole.systemInstructions || "",
        customInstructionsEnabled: editRole.customInstructionsEnabled ?? true,
        customInstructionsMaxLength: editRole.customInstructionsMaxLength ?? 1000,
        personalMcpEnabled: editRole.personalMcpEnabled ?? false,
        personalMcpMaxCount: editRole.personalMcpMaxCount ?? 3,
        dailyRequestLimit: editRole.dailyRequestLimit ?? null,
        dailyTokenLimit: editRole.dailyTokenLimit ?? null,
        promptChipIds: Array.isArray(editRole.promptChipIds)
          ? editRole.promptChipIds.filter((x: unknown): x is string => typeof x === "string")
          : [],
      });
    } else {
      setForm(defaultForm);
    }
    setTab("general");
    setErrors({});
  }, [editRole, open]);

  const toggleModel = (m: string) => {
    setErrors((p) => ({ ...p, models: undefined }));
    setForm((f) => ({
      ...f,
      allowedModels: f.allowedModels.includes(m)
        ? f.allowedModels.filter((x) => x !== m)
        : [...f.allowedModels, m],
    }));
  };

  const handleSubmit = async () => {
    const nextErrors: { name?: string; models?: string } = {};
    if (!form.name.trim()) nextErrors.name = "Role name is required.";
    // Retired models (no longer active in the registry) are dropped on save.
    const allowedModels = registryIds.length > 0 ? form.allowedModels.filter((id) => registryIds.includes(id)) : form.allowedModels;
    if (allowedModels.length === 0) nextErrors.models = "Select at least one model.";
    setErrors(nextErrors);
    if (nextErrors.name) { setTab("general"); toast.error("Please fix the highlighted fields"); return; }
    if (nextErrors.models) { setTab("models"); toast.error("Select at least one model"); return; }

    setSubmitting(true);
    const token = localStorage.getItem(AUTH_TOKEN_KEY);

    try {
      const url = editRole ? `/api/admin/roles/${editRole.id}` : "/api/admin/roles";
      const method = editRole ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, allowedModels }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save role");
        setSubmitting(false);
        return;
      }

      toast.success(editRole ? "Role updated" : "Role created");
      onSaved();
    } catch {
      toast.error("Failed to save role");
    } finally {
      setSubmitting(false);
    }
  };

  const tabs = [
    { id: "general" as const, label: "General" },
    { id: "models" as const, label: "Models" },
    { id: "limits" as const, label: "Limits" },
    { id: "tools" as const, label: "MCP" },
    { id: "databases" as const, label: "Databases" },
  ];

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="admin-overlay admin-role-editor">
        <SheetHeader>
          <SheetTitle>{editRole ? `Edit ${editRole.name}` : "Create role"}</SheetTitle>
          <SheetDescription>Define what members can access and how much they can use.</SheetDescription>
        </SheetHeader>

        <div className="admin-role-editor-workspace">
        <div role="group" aria-label="Role settings sections" className="admin-role-editor-nav">
          {tabs.map((t) => (
            <Button
              key={t.id}
              variant="ghost"
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={`h-auto justify-start rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === t.id ? "bg-background text-foreground shadow-sm hover:bg-background" : "text-muted-foreground hover:bg-transparent hover:text-foreground"
              }`}
            >
              {t.label}
            </Button>
          ))}
        </div>

        <div className="admin-role-editor-body" aria-label={`${tabs.find(t => t.id === tab)?.label} settings`}>
          <div className="mb-6 border-b pb-4"><h3 className="text-lg font-semibold">{tabs.find(t => t.id === tab)?.label}</h3><p className="mt-1 text-sm text-muted-foreground">{tab === "general" ? "Role identity, instructions, and enabled features." : tab === "models" ? "Choose the models available to members of this role." : tab === "limits" ? "Set usage allowances and instruction limits." : tab === "tools" ? "Manage shared connectors and personal MCP access." : "Grant access to the databases this team needs."}</p></div>
          {/* General Tab */}
          {tab === "general" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="role-name">Name <span className="text-destructive" aria-hidden="true">*</span></Label>
                <Input id="role-name" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }} placeholder="e.g. Data Analyst" aria-required="true" aria-invalid={!!errors.name} aria-describedby={errors.name ? "role-name-error" : undefined} />
                {errors.name && <p id="role-name-error" className="text-sm text-destructive">{errors.name}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-description">Description</Label>
                <Input id="role-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Brief description of this role" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-system-instructions">System Instructions</Label>
                <Textarea
                  id="role-system-instructions"
                  value={form.systemInstructions}
                  onChange={(e) => setForm({ ...form, systemInstructions: e.target.value })}
                  placeholder="Instructions appended to the system prompt for users in this role..."
                  className="field-sizing-fixed min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm shadow-none transition-none placeholder:text-muted-foreground focus-visible:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-background"
                  maxLength={2000}
                />
                <p className="text-xs text-muted-foreground">{form.systemInstructions.length}/2000 characters</p>
              </div>
              <div className="space-y-2">
                <Label>Features</Label>
                {isBuiltInAdmin && (
                  <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
                    The built-in <span className="font-medium text-foreground">Admin</span> role has full access to the entire platform: every feature, every model, MCP, dashboards and the Admin Console. It cannot be restricted, renamed or deleted.
                  </p>
                )}
                <label className="flex cursor-pointer items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted/50">
                  <Checkbox
                    checked={isBuiltInAdmin || form.permissions.includes("backend_agent")}
                    disabled={isBuiltInAdmin}
                    onCheckedChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        permissions:
                          v === true
                            ? Array.from(new Set([...f.permissions, "backend_agent"]))
                            : f.permissions.filter((p) => p !== "backend_agent"),
                      }))
                    }
                  />
                  <span className="text-sm font-medium">
                    Coding Agent{" "}
                    <span className="font-normal text-muted-foreground">
                      — turn requirement documents into CMF deployment units
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted/50">
                  <Checkbox
                    checked={isBuiltInAdmin || form.permissions.includes("modeling_agent")}
                    disabled={isBuiltInAdmin}
                    onCheckedChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        permissions:
                          v === true
                            ? Array.from(new Set([...f.permissions, "modeling_agent"]))
                            : f.permissions.filter((p) => p !== "modeling_agent"),
                      }))
                    }
                  />
                  <span className="text-sm font-medium">
                    Modeling Agent{" "}
                    <span className="font-normal text-muted-foreground">
                      — enable the CMF master-data loader for this role
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted/50">
                  <Checkbox
                    checked={isBuiltInAdmin || hasDashboards}
                    disabled={isBuiltInAdmin}
                    onCheckedChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        permissions:
                          v === true
                            ? Array.from(new Set([...f.permissions, "dashboards"]))
                            : f.permissions.filter((p) => p !== "dashboards"),
                      }))
                    }
                  />
                  <span className="text-sm font-medium">
                    Dashboard Scheduling{" "}
                    <span className="font-normal text-muted-foreground">
                      — let this role pin chat dashboards for admin approval and scheduled refresh
                    </span>
                  </span>
                </label>
              </div>
              <RoleChipsSection
                selectedIds={form.promptChipIds}
                onChange={(ids) => setForm((f) => ({ ...f, promptChipIds: ids }))}
                token={token}
                hasDashboards={hasDashboards}
              />
            </>
          )}

          {/* Models Tab */}
          {tab === "models" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Select which platform models users with this role can access: <span className="text-destructive" aria-hidden="true">*</span>
              </p>
              <p className="text-xs text-muted-foreground">Only models active in the model registry are listed. Add or retire models under Models.</p>
              {errors.models && <p className="text-sm text-destructive">{errors.models}</p>}
              <div className="flex justify-between">
                <Button variant="outline" size="sm" disabled={registryIds.length === 0} onClick={() => setForm({ ...form, allowedModels: [...registryIds] })}>Select All</Button>
                <Button variant="outline" size="sm" onClick={() => setForm({ ...form, allowedModels: [] })}>Clear All</Button>
              </div>
              <Separator />
              {modelsLoading && registryModels.length === 0 && (
                <p className="text-sm text-muted-foreground">Loading models…</p>
              )}
              {!modelsLoading && registryModels.length === 0 && (
                <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">No active models in the registry. Add one under Models first.</p>
              )}
              {registryModels.map((m) => (
                <label key={m.modelId} className="flex cursor-pointer items-start gap-3 rounded-md p-2 transition-colors hover:bg-muted/50">
                  <Checkbox
                    className="mt-0.5"
                    checked={form.allowedModels.includes(m.modelId)}
                    onCheckedChange={() => toggleModel(m.modelId)}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {m.displayName}
                      {m.isDefault && <Badge variant="secondary" className="text-[10px]">Default</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      <span className="font-mono">{m.modelId}</span>{m.description ? ` · ${m.description}` : ""}
                    </span>
                  </span>
                </label>
              ))}
              {form.allowedModels.some((id) => !registryIds.includes(id)) && registryModels.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This role still lists retired models ({form.allowedModels.filter((id) => !registryIds.includes(id)).join(", ")}). They are dropped on save.
                </p>
              )}
            </div>
          )}

          {/* Limits Tab */}
          {tab === "limits" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="role-daily-request-limit">Daily Request Limit</Label>
                <Input
                  id="role-daily-request-limit"
                  type="number"
                  value={form.dailyRequestLimit ?? ""}
                  onChange={(e) => setForm({ ...form, dailyRequestLimit: e.target.value ? Number(e.target.value) : null })}
                  placeholder="Unlimited"
                  min={1}
                />
                <p className="text-xs text-muted-foreground">Max requests per 24-hour rolling window. Empty = unlimited.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="role-daily-token-limit">Daily Token Limit</Label>
                <Input
                  id="role-daily-token-limit"
                  type="number"
                  value={form.dailyTokenLimit ?? ""}
                  onChange={(e) => setForm({ ...form, dailyTokenLimit: e.target.value ? Number(e.target.value) : null })}
                  placeholder="Unlimited"
                  min={1}
                />
                <p className="text-xs text-muted-foreground">Max tokens per 24-hour rolling window. Empty = unlimited.</p>
              </div>
              <Separator />
              <div className="space-y-2">
                <label className="flex items-center gap-3">
                  <Checkbox checked={form.customInstructionsEnabled} onCheckedChange={(v) => setForm({ ...form, customInstructionsEnabled: v === true })} />
                  <span className="text-sm">Allow custom instructions</span>
                </label>
                {form.customInstructionsEnabled && (
                  <div className="ml-7 space-y-2">
                    <Label htmlFor="role-custom-instructions-max-length">Max Length</Label>
                    <Input id="role-custom-instructions-max-length" type="number" value={form.customInstructionsMaxLength} onChange={(e) => setForm({ ...form, customInstructionsMaxLength: Number(e.target.value) })} min={0} max={5000} />
                  </div>
                )}
              </div>
            </>
          )}

          {/* MCP Tab */}
          {tab === "tools" && (
            <div className="space-y-4">
              {editRole?.id ? (
                <RoleMcpSection roleId={editRole.id} />
              ) : (
                <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Save the role first, then reopen it to attach MCP connectors.
                </p>
              )}
              <Separator />
              <p className="text-sm text-muted-foreground">
                The connectors assigned above are connected automatically for every user in this role.
                Choose whether users may manage connections themselves.
              </p>
              <label className="flex items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  checked={form.personalMcpEnabled}
                  onCheckedChange={(v) => setForm({
                    ...form,
                    personalMcpEnabled: v === true,
                    // Managing implies adding: the limit is at least 1 while the option is on.
                    personalMcpMaxCount: v === true && form.personalMcpMaxCount < 1 ? 3 : form.personalMcpMaxCount,
                  })}
                />
                <span>
                  <span className="block text-sm font-medium">Users can manage MCP connections</span>
                  <span className="block text-xs text-muted-foreground">Connect / disconnect the assigned connectors for themselves, and add their own MCP servers from the Settings page.</span>
                </span>
              </label>
              {form.personalMcpEnabled && (
                <div className="ml-7 space-y-2">
                  <Label htmlFor="role-personal-mcp-max-count">Max own MCP servers per user</Label>
                  <Input
                    id="role-personal-mcp-max-count"
                    type="number"
                    value={form.personalMcpMaxCount}
                    onChange={(e) => setForm({ ...form, personalMcpMaxCount: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
                    min={1}
                    max={99}
                  />
                  <p className="text-xs text-muted-foreground">A server a user adds is visible to that user only.</p>
                </div>
              )}
            </div>
          )}

          {/* Databases Tab */}
          {tab === "databases" && (
            <div className="space-y-4">
              {editRole?.id ? (
                <RoleCmfSection roleId={editRole.id} />
              ) : (
                <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Save the role first, then reopen it to grant CMF databases.
                </p>
              )}
            </div>
          )}
        </div>

        </div>
        {/* Submit */}
        <div className="admin-role-editor-footer">
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Saving…</> : editRole ? "Update Role" : "Create Role"}
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
