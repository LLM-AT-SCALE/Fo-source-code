"use client";

/**
 * Secure "create MCP data source" upload dialog.
 *
 * Opened when the admin attaches a credentials document in the chat composer.
 * The file is posted DIRECTLY to /api/admin/mcp/secrets (multipart) — it is NEVER
 * added to the chat/conversation, so its contents never reach the model,
 * messages, or prompt_audit_logs. The backend parses it in memory, stores the
 * secret in AWS Secrets Manager, and returns only non-secret metadata.
 */
import { useEffect, useState } from "react";
import { X, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";

export interface CreatedDataSource {
  id: string;
  name: string;
  status: string;
  metadata: { engine: string; host: string; port: number; database: string; schemas: string[] };
  /** Set when the new source shares the credentials of an existing one. */
  reusedSecretFrom?: string;
  /** Set when the upload carried a new password for that shared login. */
  rotated?: boolean;
}

/** A data source that already holds the uploaded login (never its password). */
interface ReusableMatch {
  id: string;
  name: string;
  status: string;
  host: string | null;
  database: string | null;
  createdAt: string;
  samePassword: boolean;
}

const STATUS_WORD: Record<string, string> = {
  DRAFT: "not connected yet", CONNECTED: "connected", GENERATED: "tools prepared",
  DEPLOYING: "deploying", ACTIVE: "live", FAILED: "failed", RETIRED: "retired",
};

interface Props {
  open: boolean;
  file: File | null;
  defaultName?: string;
  token: string | null;
  onClose: () => void;
  onCreated?: (result: CreatedDataSource) => void;
}

export function MCPDataSourceUploadDialog({ open, file, defaultName, token, onClose, onCreated }: Props) {
  const [name, setName] = useState(defaultName || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same login already stored: the server answers 409 with these and stores
  // nothing until the admin picks "reuse" or "create new".
  const [matches, setMatches] = useState<ReusableMatch[] | null>(null);
  const [choice, setChoice] = useState<string>("new");

  useEffect(() => {
    if (open) {
      setName(defaultName || "");
      setError(null);
      setSubmitting(false);
      setMatches(null);
      setChoice("new");
    }
  }, [open, defaultName]);

  if (!open || !file) return null;

  async function handleCreate(opts: { reuseFrom?: string; force?: boolean } = {}) {
    setError(null);
    if (!name.trim()) return setError("Give the data source a name.");
    if (!file) return setError("No file attached.");

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim());
      form.append("engine", "sqlserver"); // v1 scope: SQL Server
      form.append("schemas", "[]");        // empty = auto-discover everything
      if (opts.reuseFrom) form.append("reuseFrom", opts.reuseFrom);
      if (opts.force) form.append("force", "1");

      const res = await fetch("/api/admin/mcp/secrets", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(json?.matches) && json.matches.length) {
        setMatches(json.matches as ReusableMatch[]);
        setChoice(json.matches[0].id);
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        const detail = json?.missingFields?.length
          ? `Missing in the document: ${json.missingFields.join(", ")}`
          : json?.detail || json?.error || "Upload failed";
        setError(detail);
        setSubmitting(false);
        return;
      }
      const created = json as CreatedDataSource;
      toast.success(
        created.reusedSecretFrom
          ? created.rotated
            ? `Data source "${created.name}" created — stored credentials reused and the password updated.`
            : `Data source "${created.name}" created — stored credentials reused.`
          : `Data source "${created.name}" created — credentials stored securely.`,
      );
      onCreated?.(created);
      onClose();
    } catch {
      setError("Network error while creating the data source.");
      setSubmitting(false);
    }
  }

  function handleConfirmChoice() {
    if (choice === "new") return handleCreate({ force: true });
    return handleCreate({ reuseFrom: choice });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Create MCP data source">
      <div className="w-full max-w-md rounded-2xl bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-blue-600" aria-hidden="true" />
            <h2 className="text-base font-semibold">Create MCP data source</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <p className="mb-4 text-xs text-muted-foreground">
          The credentials file <span className="font-medium text-foreground">{file.name}</span> is sent
          straight to AWS Secrets Manager and is <span className="font-medium">never shared with the chat or the model</span>.
          Only non-secret metadata (host, database, schema list) is stored.
        </p>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ds-name">Data source name</Label>
            <Input id="ds-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Warehouse Database" disabled={submitting} />
            <p className="text-[11px] text-muted-foreground">A friendly name you&apos;ll recognise. We&apos;ll connect and find the available information automatically.</p>
          </div>
        </div>

        {matches && (
          <fieldset className="mt-4 space-y-2 rounded-lg border p-3" aria-label="Credentials already stored">
            <legend className="px-1 text-xs font-semibold">These credentials are already stored</legend>
            <p className="text-[11px] text-muted-foreground">
              The same login is used by the data source{matches.length > 1 ? "s" : ""} below. Reuse it to avoid keeping several copies of one password.
            </p>
            {matches.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-muted">
                <input type="radio" name="reuse" className="mt-0.5" value={m.id} checked={choice === m.id} onChange={() => setChoice(m.id)} disabled={submitting} />
                <span className="min-w-0">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-muted-foreground"> · {STATUS_WORD[m.status] ?? m.status.toLowerCase()}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{m.host}{m.database ? ` / ${m.database}` : ""}</span>
                  {!m.samePassword && (
                    <span className="block text-[11px] text-amber-700">Your file has a different password — reusing will update the stored one.</span>
                  )}
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted">
              <input type="radio" name="reuse" value="new" checked={choice === "new"} onChange={() => setChoice("new")} disabled={submitting} />
              <span>Store a new copy anyway</span>
            </label>
          </fieldset>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          {matches ? (
            <Button onClick={handleConfirmChoice} disabled={submitting}>
              {submitting ? (<><Loader2 className="mr-1 size-4 animate-spin" /> Creating…</>) : choice === "new" ? "Create with new credentials" : "Reuse and create"}
            </Button>
          ) : (
            <Button onClick={() => handleCreate()} disabled={submitting}>
              {submitting ? (<><Loader2 className="mr-1 size-4 animate-spin" /> Creating…</>) : "Create securely"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
