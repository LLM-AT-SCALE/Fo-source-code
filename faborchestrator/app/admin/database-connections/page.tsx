"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { AdminPage, AdminFormSection, AdminCollection, AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Badge } from "@/shared/components/ui/badge";
import { Checkbox } from "@/shared/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/shared/components/ui/sheet";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import { Plus, Database, Trash2, Loader2, Pencil, AlertTriangle, Eye, EyeOff, RefreshCw } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface Connection {
  id: string;
  dbKey: string;
  label: string;
  engine: string;
  sqlServer: string;
  sqlInstance: string | null;
  sqlDatabase: string;
  sqlUser: string;
  hasPassword: boolean;
  baseUrl: string;
  hostResolver: Array<[string, string]>;
  tokenDbName: string;
  tokenSecretId: string | null;
  portalUser: string | null;
  hasPortalPassword: boolean;
  provisioned: boolean;
  /** In-app token refresher status (GET /api/admin/database-connections). */
  refresher: {
    mode: "in-app" | "lambda";
    state: "ok" | "failed" | "pending" | "no-credentials" | "disabled" | "lambda";
    refreshedAt?: string;
    expiresAt?: string;
    error?: string;
    errorAt?: string;
    text: string;
  } | null;
  enabled: boolean;
  updatedAt: string;
}

export default function DatabaseConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const confirm = useConfirm();

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/database-connections", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setConnections(data.connections || []);
    } catch {
      toast.error("Failed to load database connections");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDelete = async (c: Connection) => {
    const ok = await confirm({
      title: `Delete "${c.label}"?`,
      description: `This removes the "${c.label}" CMF connection and its stored access token.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/database-connections/${c.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Failed to delete");
        return;
      }
      toast.success(`"${c.label}" deleted`);
      fetchData();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setBusyId(null);
    }
  };

  // "Refresh token now": log in to the CMF portal for this connection at once and
  // show the portal's own outcome, so a fixed password can be checked without re-saving.
  const handleRefreshToken = async (c: Connection) => {
    setRefreshingId(c.id);
    try {
      const res = await fetch(`/api/admin/database-connections/${c.id}/refresh-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error || "Could not refresh the token");
        return;
      }
      if (d.ok) toast.success(d.message || `Token fetched for "${c.label}"`);
      else if (d.pending || d.queued) toast.info(d.message);
      else toast.error(d.message || "The portal login failed");
      fetchData();
    } catch {
      toast.error("Could not refresh the token");
    } finally {
      setRefreshingId(null);
    }
  };

  const refresherCell = (c: Connection) => {
    const r = c.refresher;
    const canRefresh = r?.mode === "in-app" && r.state !== "no-credentials";
    const badge =
      !r ? null
      : r.state === "ok" ? <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">Token OK</Badge>
      : r.state === "failed" ? <Badge variant="secondary" className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">Failed</Badge>
      : r.state === "pending" ? <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
      : r.state === "lambda" ? (c.provisioned ? <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">Provisioned</Badge> : <Badge variant="outline" className="text-muted-foreground">Not provisioned</Badge>)
      : <Badge variant="outline" className="text-muted-foreground">{r.state === "disabled" ? "Disabled" : "No credentials"}</Badge>;
    return (
      <div className="flex max-w-xs items-start gap-2">
        <div className="min-w-0 space-y-1">
          {badge}
          <p className={`whitespace-normal break-words text-xs ${r?.state === "failed" ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`} title={r?.error ?? r?.text}>
            {r?.text ?? "—"}
          </p>
        </div>
        {canRefresh && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 cursor-pointer"
            disabled={refreshingId === c.id}
            onClick={() => handleRefreshToken(c)}
            title="Refresh token now"
            aria-label={`Refresh the access token for ${c.label} now`}
          >
            {refreshingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          </Button>
        )}
      </div>
    );
  };

  const passwordBadge = (c: Connection) => {
    if (c.hasPassword) return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">Stored</Badge>;
    return <span className="text-muted-foreground">—</span>;
  };

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="Configuration"
        title="Database Connections"
        description="Manage the database connections Fab Orchestrator uses. Passwords are stored encrypted; the access token is fetched and kept fresh automatically."
      >
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }} className="bg-primary">
          <Plus className="mr-2 h-4 w-4" /> Add Connection
        </Button>
      </AdminPageHeader>

      <AdminCollection>


      <AdminCollectionHeader title="Saved connections" description="Encrypted credentials and automatic token refresh." count={loading ? undefined : connections.length} />

      <div className="admin-table-surface" role="region" aria-label="Database connections" tabIndex={0}>
        <Table className="min-w-[900px] text-sm">
          <TableCaption className="sr-only">CMF database connections used by Fab Orchestrator.</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Label</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">SQL Server</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Database</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Token DB</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Refresher</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Enabled</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-b">
            {loading ? (
              [...Array(2)].map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={8} className="whitespace-normal px-4 py-4"><div className="h-4 w-64 animate-pulse rounded bg-muted" /></TableCell>
                </TableRow>
              ))
            ) : connections.length === 0 ? (
              <TableRow className="border-b-0! hover:bg-transparent">
                <TableCell colSpan={8} className="whitespace-normal px-4 py-14 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <Database className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">No connections yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">Add a CMF database connection for Fab Orchestrator to use.</p>
                    </div>
                    <Button onClick={() => { setEditing(null); setDialogOpen(true); }} size="sm" className="mt-1 bg-primary">
                      <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Add Connection
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              connections.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="px-4 py-3 font-medium">{c.label}</TableCell>
                  <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {c.sqlServer}{c.sqlInstance ? `\\${c.sqlInstance}` : ""}
                  </TableCell>
                  <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.sqlDatabase}</TableCell>
                  <TableCell className="px-4 py-3">{passwordBadge(c)}</TableCell>
                  <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.tokenDbName}</TableCell>
                  <TableCell className="px-4 py-3">{refresherCell(c)}</TableCell>
                  <TableCell className="px-4 py-3">
                    {c.enabled ? (
                      <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">Enabled</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer" onClick={() => { setEditing(c); setDialogOpen(true); }} title="Edit" aria-label={`Edit ${c.label}`}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer text-destructive hover:text-destructive" disabled={busyId === c.id} onClick={() => handleDelete(c)} title="Delete" aria-label={`Delete ${c.label}`}>
                        {busyId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
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

      <ConnectionDialog
        open={dialogOpen}
        editing={editing}
        token={token}
        connections={connections}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { setDialogOpen(false); fetchData(); }}
      />
    </AdminPage>
  );
}

// ── Add / Edit Connection ──
function ConnectionDialog({ open, editing, token, connections, onClose, onSaved }: {
  open: boolean;
  editing: Connection | null;
  token: string | null;
  connections: Connection[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [sqlServer, setSqlServer] = useState("");
  const [sqlInstance, setSqlInstance] = useState("");
  const [sqlDatabase, setSqlDatabase] = useState("");
  const [sqlUser, setSqlUser] = useState("");
  const [password, setPassword] = useState("");
  const [portalUser, setPortalUser] = useState("");
  const [portalPassword, setPortalPassword] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [loadingSecrets, setLoadingSecrets] = useState(false);

  // Heads-up if this connection's name / database duplicates an existing one.
  // Not a blocker — each connection now keeps its own token — but it flags a
  // likely mix-up (e.g. two servers both using "CriticalManufacturing").
  const dupWarnings = useMemo(() => {
    const out: string[] = [];
    const others = connections.filter((c) => c.id !== editing?.id);
    const lbl = label.trim().toLowerCase();
    const db = sqlDatabase.trim().toLowerCase();
    if (lbl) {
      const m = others.find((c) => c.label.trim().toLowerCase() === lbl);
      if (m) out.push(`A connection named “${m.label}” already exists — pick a different label to avoid confusion.`);
    }
    if (db) {
      const m = others.find((c) => c.sqlDatabase.trim().toLowerCase() === db);
      if (m) out.push(`Another connection (“${m.label}”) already uses the database “${m.sqlDatabase}” on server ${m.sqlServer}. That's fine — each connection keeps its own token — just confirm this is a different server.`);
    }
    return out;
  }, [connections, editing?.id, label, sqlDatabase]);

  useEffect(() => {
    if (open) {
      setErrors({});
      setLabel(editing?.label || "");
      setBaseUrl(editing?.baseUrl || "");
      setSqlServer(editing?.sqlServer || "");
      setSqlInstance(editing?.sqlInstance || "");
      setSqlDatabase(editing?.sqlDatabase || "");
      setSqlUser(editing?.sqlUser || "");
      setPassword("");
      setPortalUser(editing?.portalUser || "");
      setPortalPassword("");
      setShowPassword(false);
      setShowPortalPassword(false);
      setEnabled(editing ? editing.enabled : true);
      // On edit, load the current (decrypted) passwords so they're shown + editable.
      if (editing && token) {
        setLoadingSecrets(true);
        fetch(`/api/admin/database-connections/${editing.id}`, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => (r.ok ? r.json() : {}) as Promise<{ sqlPassword?: string; portalPassword?: string }>)
          .then((d) => {
            if (typeof d.sqlPassword === "string") setPassword(d.sqlPassword);
            if (typeof d.portalPassword === "string") setPortalPassword(d.portalPassword);
          })
          .catch(() => {})
          .finally(() => setLoadingSecrets(false));
      }
    }
  }, [open, editing, token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!label.trim()) next.label = "Label is required.";
    if (!baseUrl.trim()) next.baseUrl = "Base URL is required.";
    if (!sqlServer.trim()) next.sqlServer = "SQL server is required.";
    if (!sqlDatabase.trim()) next.sqlDatabase = "Database is required.";
    if (!sqlUser.trim()) next.sqlUser = "SQL user is required.";
    if (!editing && !password.trim()) next.password = "Password is required.";
    if (!editing && !portalUser.trim()) next.portalUser = "Portal user is required.";
    if (!editing && !portalPassword.trim()) next.portalPassword = "Portal password is required.";
    setErrors(next);
    if (Object.keys(next).length > 0) {
      toast.error("Please fix the highlighted fields");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        sqlServer: sqlServer.trim(),
        sqlInstance: sqlInstance.trim() || null,
        sqlDatabase: sqlDatabase.trim(),
        sqlUser: sqlUser.trim(),
        portalUser: portalUser.trim() || null,
        enabled,
      };
      if (password.trim()) body.password = password;
      if (portalPassword.trim()) body.portalPassword = portalPassword;

      const res = await fetch(
        editing ? `/api/admin/database-connections/${editing.id}` : "/api/admin/database-connections",
        {
          method: editing ? "PATCH" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to save");
        setSubmitting(false);
        return;
      }
      toast.success(data?.message || (editing ? "Connection updated" : "Connection added"));
      if (data?.warning) toast.error(data.warning, { duration: 12000 });
      onSaved();
    } catch {
      toast.error("Failed to save connection");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="admin-overlay overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{editing ? "Edit Connection" : "Add Connection"}</SheetTitle>
          <SheetDescription>Configure a database connection. Passwords are stored encrypted; the access token is fetched from the CMF portal when you save and refreshed automatically after that.</SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <AdminFormSection title="Connection identity">
          <div className="space-y-2">
            <Label htmlFor="conn-label">Label <span className="text-destructive" aria-hidden="true">*</span></Label>
            <Input id="conn-label" value={label} onChange={(e) => { setLabel(e.target.value); if (errors.label) setErrors((p) => ({ ...p, label: "" })); }} placeholder="Entegris / KSP (source)" aria-invalid={!!errors.label} />
            {errors.label && <p className="text-sm text-destructive">{errors.label}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="conn-baseurl">Base URL <span className="text-destructive" aria-hidden="true">*</span></Label>
            <Input id="conn-baseurl" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); if (errors.baseUrl) setErrors((p) => ({ ...p, baseUrl: "" })); }} placeholder="https://atscmapp4.usa.athenatec.com" aria-invalid={!!errors.baseUrl} />
            {errors.baseUrl && <p className="text-sm text-destructive">{errors.baseUrl}</p>}
          </div>

          </AdminFormSection>

          <AdminFormSection title="SQL connection" description="Server, database and SQL credentials.">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="conn-server">Server / IP <span className="text-destructive" aria-hidden="true">*</span></Label>
              <Input id="conn-server" value={sqlServer} onChange={(e) => { setSqlServer(e.target.value); if (errors.sqlServer) setErrors((p) => ({ ...p, sqlServer: "" })); }} placeholder="10.10.1.145" aria-invalid={!!errors.sqlServer} aria-describedby={errors.sqlServer ? "conn-server-error" : "conn-server-help"} />
              {errors.sqlServer ? <p id="conn-server-error" className="text-sm text-destructive">{errors.sqlServer}</p> : <p id="conn-server-help" className="text-xs text-muted-foreground">Server host or IP, e.g. 10.10.1.145.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-instance">Instance Name <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="conn-instance" value={sqlInstance} onChange={(e) => setSqlInstance(e.target.value)} placeholder="ONLINE" aria-describedby="conn-instance-help" />
              <p id="conn-instance-help" className="text-xs text-muted-foreground">Just the instance, e.g. ONLINE — not SERVER\ONLINE.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-db">Database <span className="text-destructive" aria-hidden="true">*</span></Label>
              <Input id="conn-db" value={sqlDatabase} onChange={(e) => { setSqlDatabase(e.target.value); if (errors.sqlDatabase) setErrors((p) => ({ ...p, sqlDatabase: "" })); }} placeholder="EntegrisKSPUpgrade" aria-invalid={!!errors.sqlDatabase} />
              {errors.sqlDatabase && <p className="text-sm text-destructive">{errors.sqlDatabase}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-user">SQL User <span className="text-destructive" aria-hidden="true">*</span></Label>
              <Input id="conn-user" value={sqlUser} onChange={(e) => { setSqlUser(e.target.value); if (errors.sqlUser) setErrors((p) => ({ ...p, sqlUser: "" })); }} placeholder="cmuser" aria-invalid={!!errors.sqlUser} />
              {errors.sqlUser && <p className="text-sm text-destructive">{errors.sqlUser}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="conn-password">SQL Password {editing && loadingSecrets && <span className="text-muted-foreground">(loading…)</span>}</Label>
            <div className="relative">
              <Input id="conn-password" type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); if (errors.password) setErrors((p) => ({ ...p, password: "" })); }} placeholder={editing ? (loadingSecrets ? "Loading…" : "SQL password") : "SQL password (stored encrypted)"} className="pr-10" aria-invalid={!!errors.password} />
              <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"} className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
            {errors.password && <p className="text-sm text-destructive">{errors.password}</p>}
          </div>

          </AdminFormSection>

          <div className="space-y-3 rounded-lg border border-dashed p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Portal login (token)</p>
              <p className="text-xs text-muted-foreground">The portal account used to fetch the access token — separate from the SQL user above (the UN / PWD from the connection details).</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-portaluser">Portal User {!editing && <span className="text-destructive" aria-hidden="true">*</span>}</Label>
              <Input id="conn-portaluser" value={portalUser} onChange={(e) => { setPortalUser(e.target.value); if (errors.portalUser) setErrors((p) => ({ ...p, portalUser: "" })); }} placeholder={"ATHENATEC\\atscmapp4"} className="font-mono text-sm" aria-invalid={!!errors.portalUser} />
              {errors.portalUser && <p className="text-sm text-destructive">{errors.portalUser}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-portalpassword">Portal Password {editing ? (loadingSecrets && <span className="text-muted-foreground">(loading…)</span>) : <span className="text-destructive" aria-hidden="true">*</span>}</Label>
              <div className="relative">
                <Input id="conn-portalpassword" type={showPortalPassword ? "text" : "password"} autoComplete="new-password" value={portalPassword} onChange={(e) => { setPortalPassword(e.target.value); if (errors.portalPassword) setErrors((p) => ({ ...p, portalPassword: "" })); }} placeholder={editing ? (loadingSecrets ? "Loading…" : "Portal password") : "Portal password (stored encrypted)"} className="pr-10" aria-invalid={!!errors.portalPassword} />
                <button type="button" onClick={() => setShowPortalPassword((v) => !v)} aria-label={showPortalPassword ? "Hide portal password" : "Show portal password"} className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                  {showPortalPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {errors.portalPassword && <p className="text-sm text-destructive">{errors.portalPassword}</p>}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(c) => setEnabled(!!c)} />
              <span>Enabled (Fab Orch may use this connection)</span>
            </label>
          </div>

          {dupWarnings.length > 0 && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <div className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                {dupWarnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submitting} className="bg-primary">
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Saving…</> : editing ? "Save Changes" : "Add Connection"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
