"use client";

/**
 * Error detail — where the "View error details" button in the Fab chat lands.
 *
 * Renders the stored error_audit_logs row. The important part is `detail`
 * (the row's request_context): it is rendered by WALKING whatever was actually
 * captured, not by reading a fixed list of fields. A failure mode nobody
 * anticipated still shows everything the runtime saw, because nothing here
 * depends on knowing the shape in advance.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Copy, RefreshCw } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface ErrorRecord {
  id: string;
  errorId: string;
  errorUuid: string;
  errorType: string;
  priority: "HIGH" | "MEDIUM";
  status: "OPEN" | "RESOLVED";
  datetime: string;
  user: { id: string; name: string | null; email: string } | null;
  userMessage: string | null;
  technicalMessage: string | null;
  stackPreview: string | null;
  route: string | null;
  httpMethod: string | null;
  httpStatus: number | null;
  detail: Record<string, unknown> | null;
  resolution: {
    resolvedBy: string | null;
    resolvedByName: string | null;
    resolvedAt: string | null;
    note: string | null;
  };
}

/** Fields we give a friendlier label. Anything not listed still renders, under
 *  its raw key — the list is cosmetic, never a filter. */
const LABELS: Record<string, string> = {
  name: "Error class",
  message: "Error message",
  code: "System code",
  errno: "errno",
  syscall: "System call",
  httpStatus: "HTTP status",
  responseBody: "Response body",
  rpcCode: "JSON-RPC code",
  rpcMessage: "JSON-RPC message",
  causeChain: "Underlying cause chain",
  stack: "Stack trace",
  connector: "Connector",
  connectorUrl: "Connector endpoint",
  toolName: "Tool",
  toolArgs: "Tool arguments",
  extra: "Other properties",
  at: "Captured at",
  type: "Category",
  priority: "Priority",
  errorId: "Error ID",
};

/** Keys already shown in the summary header — skipped in the capture table. */
const SHOWN_ABOVE = new Set(["errorId", "type", "priority", "at"]);

/** Values that read better in a monospace block than on one line. */
const BLOCK_KEYS = new Set([
  "message",
  "stack",
  "responseBody",
  "causeChain",
  "toolArgs",
  "extra",
]);

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

export default function ErrorDetailPage() {
  const params = useParams<{ errorId: string }>();
  const router = useRouter();
  const [record, setRecord] = useState<ErrorRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState<string | null>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const load = useCallback(async () => {
    if (!token || !params?.errorId) return;
    setLoading(true);
    setNotFound(null);
    try {
      const res = await fetch(`/api/admin/errors/${encodeURIComponent(params.errorId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        setNotFound(body?.error?.message ?? "No error record matches that id.");
        setRecord(null);
        return;
      }
      if (!res.ok) {
        setNotFound(`Could not load this error (HTTP ${res.status}).`);
        setRecord(null);
        return;
      }
      setRecord(await res.json());
    } catch (e) {
      setNotFound(e instanceof Error ? e.message : "Could not load this error.");
    } finally {
      setLoading(false);
    }
  }, [token, params?.errorId]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast(`Could not copy ${what}`),
    );
  };

  const detail = record?.detail ?? null;
  const detailKeys = detail
    ? Object.keys(detail).filter((k) => !SHOWN_ABOVE.has(k) && detail[k] !== null && detail[k] !== undefined)
    : [];

  return (
    <AdminPage className="space-y-6">
      <AdminPageHeader
        title="Error detail"
        description="Exactly what was captured when this request failed."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => router.push("/admin/errors")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          All errors
        </Button>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {notFound && !loading && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium">{notFound}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Records are removed 90 days after they are created.
          </p>
        </div>
      )}

      {record && !loading && (
        <div className="space-y-6">
          {/* ── Summary ─────────────────────────────────────────────── */}
          <section className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={record.priority === "HIGH" ? "destructive" : "secondary"}>
                {record.priority}
              </Badge>
              <Badge variant={record.status === "OPEN" ? "outline" : "secondary"}>
                {record.status}
              </Badge>
              <span className="font-mono text-sm">{record.errorType}</span>
            </div>

            <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Field label="Error ID (shown to the user)">
                <div className="flex items-center gap-2">
                  <code className="break-all text-xs">{record.errorUuid}</code>
                  <Button variant="ghost" size="icon" onClick={() => copy(record.errorUuid, "Error ID")}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Field>
              <Field label="Audit reference">
                <code className="text-xs">{record.errorId}</code>
              </Field>
              <Field label="When">{new Date(record.datetime).toLocaleString()}</Field>
              <Field label="User">
                {record.user ? `${record.user.name ?? "—"} · ${record.user.email}` : "—"}
              </Field>
              <Field label="Route">
                <code className="break-all text-xs">
                  {record.httpMethod ? `${record.httpMethod} ` : ""}
                  {record.route ?? "—"}
                </code>
              </Field>
              <Field label="HTTP status">{record.httpStatus ?? "—"}</Field>
            </dl>
          </section>

          {/* ── What the user was told vs what really happened ───────── */}
          <section className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold">What the user saw</h2>
            <p className="mt-1 text-sm text-muted-foreground">{record.userMessage ?? "—"}</p>

            <h2 className="mt-4 text-sm font-semibold">What actually failed</h2>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {record.technicalMessage ?? "Not captured for this record."}
            </pre>
          </section>

          {/* ── The full capture, rendered from whatever is present ──── */}
          <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Captured detail</h2>
              {detail && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copy(JSON.stringify(detail, null, 2), "Captured detail")}
                >
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Copy all
                </Button>
              )}
            </div>

            {!detail && (
              <p className="mt-2 text-sm text-muted-foreground">
                No structured capture on this record. It predates the capture change, or was
                recorded by a path that does not go through the MCP client yet.
              </p>
            )}

            {detail && detailKeys.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">Capture present but empty.</p>
            )}

            {detail && detailKeys.length > 0 && (
              <dl className="mt-3 space-y-3">
                {detailKeys.map((k) => {
                  const text = renderValue(detail[k]);
                  const isBlock = BLOCK_KEYS.has(k) || text.includes("\n") || text.length > 120;
                  return (
                    <div key={k}>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {LABELS[k] ?? k}
                      </dt>
                      <dd className="mt-1">
                        {isBlock ? (
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                            {text}
                          </pre>
                        ) : (
                          <span className="break-all font-mono text-sm">{text}</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </section>

          {/* ── Stack ───────────────────────────────────────────────── */}
          {record.stackPreview && (
            <section className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold">Stack trace</h2>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {record.stackPreview}
              </pre>
            </section>
          )}

          {/* ── Resolution ──────────────────────────────────────────── */}
          {record.status === "RESOLVED" && (
            <section className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold">Resolution</h2>
              <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
                <Field label="Resolved by">{record.resolution.resolvedByName ?? "—"}</Field>
                <Field label="Resolved at">
                  {record.resolution.resolvedAt
                    ? new Date(record.resolution.resolvedAt).toLocaleString()
                    : "—"}
                </Field>
                <Field label="Note">{record.resolution.note ?? "—"}</Field>
              </dl>
            </section>
          )}
        </div>
      )}
    </AdminPage>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
