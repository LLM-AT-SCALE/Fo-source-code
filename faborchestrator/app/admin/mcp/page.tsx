"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminPage, AdminFormSection, AdminToolbar, AdminSearch } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Card } from "@/shared/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/shared/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/shared/components/ui/dialog";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import { Plus, Wrench, Trash2, Loader2, Pencil, AlertTriangle, Plug, RefreshCw, Stethoscope } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";
import { McpLayerPills, statusTone } from "@/modules/admin/components/mcp-health-pill";
import { MCP_HEALTH_LABELS, MCP_HEALTH_STATUSES, type McpHealthDetail, type McpHealthProbe, type McpHealthStatus } from "@/modules/mcp/lib/mcp-health-types";

interface Connector {
  id: string;
  displayName: string;
  description: string | null;
  serverUrl: string;
  authType: string;
  hasCredentials: boolean;
  isActive: boolean;
  assignmentCount: number;
  // Additive stats from the registry GET (older responses may omit them).
  roleCount?: number;
  userCount?: number;
  toolCount?: number | null;
  lastConnectedAt?: string | null;
  connected?: boolean;
  // Tool names, when the registry GET includes them (any of these shapes).
  toolNames?: string[] | null;
  tools?: Array<string | { name: string }> | null;
  availableTools?: Array<string | { name: string }> | null;
  // Health (see modules/mcp/lib/mcp-health-types.ts); older responses may omit them.
  healthStatus?: McpHealthStatus | null;
  healthCheckedAt?: string | null;
  healthDetail?: McpHealthDetail | null;
  healthProbe?: McpHealthProbe | null;
}

const AUTH_LABELS: Record<string, string> = { none: "None", api_key: "API key", oauth: "OAuth" };
const PROBE_SOURCE_LABELS: Record<string, string> = { configured: "configured", llm: "chosen by AI", automatic: "automatic", "built-in": "built-in" };

function healthStatusOf(c: Connector): McpHealthStatus {
  return c.healthStatus ?? c.healthDetail?.status ?? "unknown";
}

/** "last probe: ksp_list_tables · automatic" — what the most recent check called. */
function lastProbeLabel(c: Connector): string | null {
  const d = c.healthDetail;
  if (!d?.toolUsed) return null;
  const source = d.probeSource ? PROBE_SOURCE_LABELS[d.probeSource] ?? d.probeSource : null;
  return `last probe: ${d.toolUsed}${source ? ` · ${source}` : ""}`;
}

/** 1 column on phones, 2 from md, 3 from xl — same breakpoints as the Roles grid. */
const GRID = "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

function Stat({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex min-w-0 flex-col items-center px-2 py-2 text-center">
      <span className="text-lg font-semibold tabular-nums leading-tight">{typeof value === "number" ? value.toLocaleString() : "—"}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export default function McpPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const filtered = connectors.filter(item => [item.displayName, item.serverUrl, item.description].filter(Boolean).join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [probeTarget, setProbeTarget] = useState<Connector | null>(null);
  const confirm = useConfirm();

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!token) return;
    if (!opts.quiet) setLoading(true);
    try {
      const res = await fetch("/api/admin/mcp-registry", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setConnectors(data.servers || []);
    } catch {
      if (!opts.quiet) toast.error("Failed to load connectors");
    } finally {
      if (!opts.quiet) setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /*
   * Health is refreshed by the worker every few minutes; re-read the list every
   * 60 s while the tab is visible (and as soon as the admin comes back to it)
   * so the pills and the "checked … ago" text keep up without a reload.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") fetchData({ quiet: true });
    };
    const id = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [fetchData]);

  // Re-render every 30 s so "checked 2 min ago" ages between refetches.
  const [, setClock] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setClock((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const healthCounts = connectors.reduce<Record<McpHealthStatus, number>>(
    (acc, c) => { acc[healthStatusOf(c)] += 1; return acc; },
    { healthy: 0, degraded: 0, down: 0, unknown: 0 },
  );

  const patchConnector = (id: string, patch: Partial<Connector>) =>
    setConnectors((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const checkNow = async (c: Connector) => {
    if (!token || checkingId) return;
    setCheckingId(c.id);
    try {
      const res = await fetch(`/api/admin/mcp-registry/${c.id}/health`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.health) { toast.error(data?.error || `Health check failed (${res.status})`); return; }
      const health = data.health as McpHealthDetail;
      patchConnector(c.id, { healthDetail: health, healthStatus: health.status, healthCheckedAt: health.checkedAt });
    } catch {
      toast.error("Health check failed");
    } finally {
      setCheckingId(null);
    }
  };

  const handleDelete = async (c: Connector) => {
    const description = c.assignmentCount > 0
      ? `This also removes it from ${c.assignmentCount} role/user assignment(s).`
      : "This permanently removes the connector from the catalog.";
    const ok = await confirm({
      title: `Delete "${c.displayName}"?`,
      description,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/mcp-registry/${c.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { toast.error("Failed to delete"); return; }
      toast.success(`"${c.displayName}" deleted`);
      fetchData();
    } catch { toast.error("Failed to delete"); } finally { setBusyId(null); }
  };

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="Configuration" title="MCP Connections" description="Manage the catalog of MCP server connectors. Assign them to users and roles from their sections.">
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }} className="bg-primary">
          <Plus className="mr-2 h-4 w-4" /> Add Custom Connector
        </Button>
      </AdminPageHeader>

      <AdminToolbar label="Find connectors" className="mt-6">
        <AdminSearch value={search} onChange={setSearch} placeholder="Search connectors..." />
        {search && <Button variant="ghost" size="sm" onClick={() => setSearch("")}>Clear search</Button>}
        {!loading && connectors.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Health summary">
            {MCP_HEALTH_STATUSES.map((s) => {
              const tone = statusTone(s);
              return (
                <span key={s} className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium tabular-nums ${tone.pill}`} title={`${healthCounts[s]} ${MCP_HEALTH_LABELS[s].toLowerCase()}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
                  {healthCounts[s]} {MCP_HEALTH_LABELS[s]}
                </span>
              );
            })}
          </div>
        )}
        <span className="text-sm tabular-nums text-muted-foreground sm:ml-auto" aria-live="polite">
          {loading ? "Loading…" : search ? `${filtered.length} of ${connectors.length} connectors` : `${connectors.length} ${connectors.length === 1 ? "connector" : "connectors"}`}
        </span>
      </AdminToolbar>

      <div className="mt-4 min-w-0">
        {loading ? (
          <div className={GRID} aria-busy="true" aria-label="Loading connectors">
            {[...Array(6)].map((_, i) => <div key={i} className="h-56 animate-pulse rounded-xl border bg-muted" />)}
          </div>
        ) : filtered.length === 0 && search ? (
          <div className="rounded-xl border bg-card px-6 py-16 text-center">
            <h2 className="text-base font-semibold">No matches found</h2>
            <p className="mt-2 text-sm text-muted-foreground">Try another name or clear your search.</p>
            <Button variant="outline" className="mt-4" onClick={() => setSearch("")}>Clear search</Button>
          </div>
        ) : connectors.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-16 text-center">
            <Wrench className="h-12 w-12 text-muted-foreground/30" aria-hidden="true" />
            <div>
              <h3 className="text-lg font-medium">No MCP connectors yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">Add a custom connector, then assign it to users or roles.</p>
            </div>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }} className="mt-1 bg-primary">
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Add Custom Connector
            </Button>
          </div>
        ) : (
          <div className={GRID}>
            {filtered.map((c) => (
              <Card key={c.id} className="flex h-full min-w-0 flex-col rounded-xl border p-5 shadow-none transition-shadow hover:shadow-sm">
                {/* Row 1 — identity + actions. Title and URL stay on their own lines; nothing wraps into the title. */}
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Plug className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-base font-semibold tracking-tight" title={c.displayName}>{c.displayName}</h3>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={c.serverUrl}>{c.serverUrl}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => { setEditing(c); setDialogOpen(true); }} aria-label={`Edit ${c.displayName}`}>
                      <Pencil className="size-3.5" aria-hidden="true" /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive hover:text-destructive"
                      disabled={busyId === c.id}
                      onClick={() => handleDelete(c)}
                      aria-label={`Delete ${c.displayName}`}
                      title="Delete this connector"
                    >
                      {busyId === c.id ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
                    </Button>
                  </div>
                </div>

                {/* Row 2 — health: is the MCP server up, does its database answer. */}
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <McpLayerPills detail={c.healthDetail ?? null} checkedAt={c.healthCheckedAt ?? null} />
                </div>
                {c.healthDetail?.error && (
                  <p className={`mt-1.5 truncate text-xs ${statusTone(healthStatusOf(c)).text}`} title={c.healthDetail.error}>
                    {c.healthDetail.error}
                  </p>
                )}

                {/* Row 3 — description (fixed height so cards align even without one). */}
                <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm leading-5 text-muted-foreground" title={c.description || undefined}>
                  {c.description || "No description."}
                </p>

                {/* Row 4 — stats. */}
                <div className="mt-4 grid grid-cols-3 divide-x divide-border rounded-lg border bg-muted/30">
                  <Stat label="Roles" value={c.roleCount ?? 0} />
                  <Stat label="Users" value={c.userCount ?? 0} />
                  <Stat label="Tools" value={c.toolCount ?? null} />
                </div>

                {/* Row 5 — footer pinned to the bottom: connection + probe facts left, health actions right. */}
                <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <p className="truncate" title={c.lastConnectedAt ? new Date(c.lastConnectedAt).toLocaleString() : undefined}>
                      {c.lastConnectedAt ? `Last connected ${relativeTime(c.lastConnectedAt)}` : "Never connected"}
                    </p>
                    {(lastProbeLabel(c) || c.healthProbe) && (
                      <p className="truncate" title={c.healthProbe ? `${c.healthProbe.source === "llm" ? "Chosen by AI" : "Saved"} probe: ${c.healthProbe.tool}${c.healthProbe.reason ? ` — ${c.healthProbe.reason}` : ""}` : undefined}>
                        {lastProbeLabel(c) ?? `probe: ${c.healthProbe!.tool} · ${c.healthProbe!.source === "llm" ? "chosen by AI" : "saved"}`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={checkingId === c.id}
                      onClick={() => checkNow(c)}
                      aria-label={`Check health of ${c.displayName} now`}
                      title="Run a health check now"
                    >
                      <RefreshCw className={`size-3.5 ${checkingId === c.id ? "animate-spin" : ""}`} aria-hidden="true" />
                      {checkingId === c.id ? "Checking…" : "Check now"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setProbeTarget(c)}
                      aria-label={`Health probe for ${c.displayName}`}
                      title="See which read-only call the data check uses, or let AI choose it"
                    >
                      <Stethoscope className="size-3.5" aria-hidden="true" /> Probe
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <ConnectorDialog
        open={dialogOpen}
        editing={editing}
        token={token}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { setDialogOpen(false); fetchData(); }}
      />

      <ProbeDialog
        connector={probeTarget}
        token={token}
        onClose={() => setProbeTarget(null)}
        onSaved={(id, probe, health) => { patchConnector(id, { healthProbe: probe, ...(health ? { healthDetail: health, healthStatus: health.status, healthCheckedAt: health.checkedAt } : {}) }); }}
      />
    </AdminPage>
  );
}

// ── Health probe: which tool the data stage calls ──
type ProbeAttemptView = { tool: string; arguments: Record<string, unknown>; reason: string; ok: boolean; dataMs: number; error?: string };

/**
 * The data-stage probe is never typed in. The checker picks a safe read-only
 * tool itself; when it cannot, or when the admin asks, the model reads the
 * server's tool list and proposes calls, each of which is run before it is
 * kept. This dialog shows what is in use and offers "Let AI choose" / reset.
 */
function ProbeDialog({ connector, token, onClose, onSaved }: {
  connector: Connector | null;
  token: string | null;
  onClose: () => void;
  onSaved: (id: string, probe: McpHealthProbe | null, health?: McpHealthDetail) => void;
}) {
  const open = connector !== null;
  const [busy, setBusy] = useState<"choose" | "reset" | null>(null);
  const [tried, setTried] = useState<ProbeAttemptView[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { setBusy(null); setTried([]); setMessage(null); }, [connector]);

  const probe = connector?.healthProbe ?? null;
  const detail = connector?.healthDetail ?? null;
  const inUse = probe
    ? { tool: probe.tool, how: probe.source === "llm" ? "chosen by AI" : "saved", reason: probe.reason, args: probe.arguments }
    : detail?.toolUsed
      ? { tool: detail.toolUsed, how: PROBE_SOURCE_LABELS[detail.probeSource ?? ""] ?? "automatic", reason: undefined, args: undefined }
      : null;

  const chooseWithAi = async () => {
    if (!connector || !token) return;
    setBusy("choose"); setMessage(null); setTried([]);
    try {
      const res = await fetch(`/api/admin/mcp-registry/${connector.id}/health/probe`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || "Could not choose a probe"); return; }
      setTried(Array.isArray(d.tried) ? d.tried : []);
      if (d.probe) {
        toast.success(`AI chose ${d.probe.tool}`);
        setMessage(null);
      } else {
        setMessage(d.error || "No read-only call returned data.");
      }
      onSaved(connector.id, d.probe ?? null, d.health);
    } catch {
      toast.error("Could not choose a probe");
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!connector || !token) return;
    setBusy("reset");
    try {
      const res = await fetch(`/api/admin/mcp-registry/${connector.id}/health/probe`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || "Failed to reset the probe"); return; }
      toast.success("Probe reset — the next check picks again");
      setTried([]); setMessage(null);
      onSaved(connector.id, null);
    } catch {
      toast.error("Failed to reset the probe");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Health probe{connector ? ` — ${connector.displayName}` : ""}</DialogTitle>
          <DialogDescription>
            Each health check ends with one read-only call that proves the database answers. The checker picks it; when no obvious tool exists, AI reads the server&apos;s tool list, proposes calls and only keeps one that returns data.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {inUse ? (
            <>
              <p><span className="text-muted-foreground">In use:</span> <span className="font-mono">{inUse.tool}</span> <span className="text-muted-foreground">· {inUse.how}</span></p>
              {inUse.args && Object.keys(inUse.args).length > 0 && (
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={JSON.stringify(inUse.args)}>{JSON.stringify(inUse.args)}</p>
              )}
              {inUse.reason && <p className="mt-1 text-xs text-muted-foreground">{inUse.reason}</p>}
            </>
          ) : (
            <p className="text-muted-foreground">No probe chosen yet — run a check or let AI choose.</p>
          )}
        </div>

        {message && <p className="text-sm text-destructive">{message}</p>}

        {tried.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto text-xs" aria-label="Calls tried">
            {tried.map((t, i) => (
              <li key={`${t.tool}-${i}`} className="flex items-start gap-2">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${t.ok ? "bg-green-500" : "bg-red-500"}`} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="font-mono">{t.tool}</span> <span className="text-muted-foreground">· {t.ok ? `returned data in ${t.dataMs} ms` : t.error}</span>
                  {t.reason && <span className="block text-muted-foreground">{t.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" disabled={busy !== null || !probe} onClick={reset} title="Forget the saved probe; the next check picks again">
            {busy === "reset" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}Reset to automatic
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            <Button type="button" className="bg-primary" disabled={busy !== null} onClick={chooseWithAi}>
              {busy === "choose" ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Choosing…</> : "Let AI choose"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add / Edit Custom Connector ──
function ConnectorDialog({ open, editing, token, onClose, onSaved }: {
  open: boolean;
  editing: Connector | null;
  token: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [authType, setAuthType] = useState<"none" | "api_key" | "oauth">("none");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});

  useEffect(() => {
    if (open) {
      setName(editing?.displayName || "");
      setUrl(editing?.serverUrl || "");
      setDescription(editing?.description || "");
      setAuthType((editing?.authType as "none" | "api_key" | "oauth") || "none");
      setApiKey("");
      setErrors({});
    }
  }, [open, editing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: { name?: string; url?: string } = {};
    if (!name.trim()) nextErrors.name = "Name is required.";
    if (!url.trim()) nextErrors.url = "Server URL is required.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) { toast.error("Please fix the highlighted fields"); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { displayName: name.trim(), serverUrl: url.trim(), authType, description: description.trim() };
      if (authType === "api_key" && apiKey) body.apiKey = apiKey;
      const res = await fetch(editing ? `/api/admin/mcp-registry/${editing.id}` : "/api/admin/mcp-registry", {
        method: editing ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); setSubmitting(false); return; }
      toast.success(editing ? "Connector updated" : "Connector added");
      onSaved();
    } catch { toast.error("Failed to save connector"); } finally { setSubmitting(false); }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="admin-overlay overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{editing ? "Edit Connector" : "Add Custom Connector"}</SheetTitle>
          <SheetDescription>Connect to a remote MCP server to extend Claude&apos;s capabilities with custom tools.</SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <AdminFormSection title="Connector details">
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Name <span className="text-destructive" aria-hidden="true">*</span></Label>
            <Input id="mcp-name" value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }} placeholder="My MCP Server" required aria-required="true" aria-invalid={!!errors.name} aria-describedby={errors.name ? "mcp-name-error" : undefined} />
            {errors.name && <p id="mcp-name-error" className="text-sm text-destructive">{errors.name}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-url">Remote MCP Server URL <span className="text-destructive" aria-hidden="true">*</span></Label>
            <Input id="mcp-url" type="url" value={url} onChange={(e) => { setUrl(e.target.value); if (errors.url) setErrors((p) => ({ ...p, url: undefined })); }} placeholder="https://mcp.example.com/api" required aria-required="true" aria-invalid={!!errors.url} aria-describedby={errors.url ? "mcp-url-error" : "mcp-url-help"} />
            {errors.url ? <p id="mcp-url-error" className="text-sm text-destructive">{errors.url}</p> : <p id="mcp-url-help" className="text-xs text-muted-foreground">The HTTPS endpoint of the remote MCP server.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-description">Description <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="mcp-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this connector provides" />
          </div>
          </AdminFormSection>

          <div className="space-y-2">
            <Label>Authentication Type</Label>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(["none", "api_key", "oauth"] as const).map((t) => (
                <Button
                  key={t}
                  variant="ghost"
                  type="button"
                  onClick={() => setAuthType(t)}
                  className={`h-auto flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    authType === t ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground hover:bg-transparent hover:text-foreground"
                  }`}
                >
                  {AUTH_LABELS[t]}
                </Button>
              ))}
            </div>
          </div>
          {authType === "api_key" && (
            <div className="space-y-2">
              <Label htmlFor="mcp-api-key">API Key</Label>
              <Input id="mcp-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing?.hasCredentials ? "Leave blank to keep existing key" : "Enter API key"} aria-describedby="mcp-api-key-help" />
              <p id="mcp-api-key-help" className="text-xs text-muted-foreground">Stored encrypted (AES-256-GCM). {editing?.hasCredentials ? "Leave blank to keep the existing key." : ""}</p>
            </div>
          )}

          <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              <span className="font-semibold">Security Notice</span><br />
              Only connect to MCP servers from developers you trust. Connected servers can execute tools and access data on your behalf.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submitting} className="bg-primary">
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Saving…</> : editing ? "Save Changes" : "Add Connector"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
