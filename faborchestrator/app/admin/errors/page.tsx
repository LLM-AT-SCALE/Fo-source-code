"use client";

/**
 * Errors — triage table over error_audit_logs.
 *
 * Laid out as a table because that is what this data is: the same six facts
 * about every failure, read by scanning down a column. It also matches every
 * other page in this console, so nothing here needs relearning.
 *
 * Page padding follows the house convention (`p-4 sm:p-6 lg:p-8`) used by
 * Usage, Users and Performance — the first version omitted it, which pinned
 * the table against the sidebar with no breathing room.
 *
 * Two things are NOT cosmetic and are worth keeping:
 *
 *  - `causeOf()` runs the MCP payload parser at display time. Records written
 *    before that parser existed stored the whole envelope
 *    (`{'error': "…", 'columns': [], 'rows': []}`), so without this the table
 *    shows raw Python reprs for historical rows.
 *  - "Group repeats" is ON by default. A background job that fails once a
 *    minute writes the same row dozens of times; ungrouped, the list is that
 *    sentence repeated to the horizon. Untick it to see every occurrence.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { RefreshCw, Search } from "lucide-react";
import { readErrorPayload } from "@/shared/lib/errors/mcp-error-payload";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface Row {
  id: string;
  errorId: string;
  errorType: string;
  userName: string | null;
  userEmail: string | null;
  datetime: string;
  userMessage: string;
  technicalMessage: string | null;
  priority: "HIGH" | "MEDIUM";
  status: "OPEN" | "RESOLVED";
  route: string | null;
  httpStatus: number | null;
}

/** Rendered row: a record, plus how many identical ones it stands for. */
interface Display {
  row: Row;
  count: number;
}

/**
 * The line a human should read: the real cause, falling back to what the user
 * saw. Historical rows hold the whole error envelope, so the payload parser
 * runs here too — old rows then read as cleanly as new ones.
 */
function causeOf(r: Row): string {
  const raw = (r.technicalMessage || r.userMessage || "").trim();
  if (!raw) return "No detail captured.";
  return readErrorPayload(raw) ?? raw;
}

/** Type + the first 120 chars of the cause: the same fault with a different
 *  lot number still groups; genuinely different faults stay apart. */
function signature(r: Row): string {
  return `${r.errorType}::${causeOf(r).slice(0, 120)}`;
}

export default function ErrorsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [priority, setPriority] = useState("");
  const [status, setStatus] = useState("OPEN");
  // ON by default. A background job that fails once a minute writes the same
  // row dozens of times; ungrouped, the list is that sentence repeated to the
  // horizon and nothing else is visible. Untick to see every occurrence.
  const [grouped, setGrouped] = useState(true);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  /** When the list last came back from the server — shown so "live" is checkable. */
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  /**
   * `quiet` is the background poll: no spinner, and a transient failure keeps
   * the rows already on screen instead of blanking the list.
   */
  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!token) return;
    const quiet = opts.quiet === true;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const qs = new URLSearchParams();
      if (search.trim()) {
        const looksLikeId = /^[0-9a-f-]{8,}$/i.test(search.trim()) || /^ERR-/i.test(search.trim());
        qs.set(looksLikeId ? "errorId" : "user", search.trim());
      }
      if (type) qs.set("type", type);
      if (priority) qs.set("priority", priority);
      if (status) qs.set("status", status);
      qs.set("limit", "500");

      const res = await fetch(`/api/admin/errors?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (!quiet) {
          setError(`Could not load errors (HTTP ${res.status}).`);
          setRows([]);
        }
        return;
      }
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setUpdatedAt(new Date());
      if (quiet) setError(null);
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "Could not load errors.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [token, search, type, priority, status]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * LIVE. A failure in chat is written to the log the moment it happens; the
   * list used to load once and then only on Refresh, so it looked like nothing
   * was being recorded. Poll every 10 s while the tab is visible, and catch up
   * immediately when the admin comes back to the tab.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") load({ quiet: true });
    };
    const id = window.setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  /** Filter values come from the data, so a new category needs no code change. */
  const types = useMemo(() => Array.from(new Set(rows.map((r) => r.errorType))).sort(), [rows]);

  const display: Display[] = useMemo(() => {
    if (!grouped) return rows.map((r) => ({ row: r, count: 1 }));
    const map = new Map<string, Display>();
    for (const r of rows) {
      const k = signature(r);
      const seen = map.get(k);
      if (seen) {
        seen.count += 1;
        if (new Date(r.datetime) > new Date(seen.row.datetime)) seen.row = r;
      } else {
        map.set(k, { row: r, count: 1 });
      }
    }
    return [...map.values()].sort(
      (a, b) => new Date(b.row.datetime).getTime() - new Date(a.row.datetime).getTime(),
    );
  }, [rows, grouped]);

  return (
    <AdminPage>
      <AdminPageHeader
        title="Errors"
        description="Every failure captured across both applications, with the real cause."
      />

      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Error ID or user
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Paste an error ID, or type a name or email"
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm"
            />
          </div>
        </div>

        <Select label="Type" value={type} onChange={setType} options={types} anyLabel="Any type" />
        <Select
          label="Priority"
          value={priority}
          onChange={setPriority}
          options={["HIGH", "MEDIUM"]}
          anyLabel="Any priority"
        />
        <Select
          label="Status"
          value={status}
          onChange={setStatus}
          options={["OPEN", "RESOLVED", "all"]}
          anyLabel="Any status"
        />

        <label className="flex h-9 cursor-pointer select-none items-center gap-2 rounded-md border px-3 text-sm">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => setGrouped(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Group repeats
        </label>

        {updatedAt && (
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            Live · updated {updatedAt.toLocaleTimeString()}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} className="h-9">
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          {error}
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────── */}
      <div className="mt-6 overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[168px] pl-4">When</TableHead>
              <TableHead className="w-[190px]">Type</TableHead>
              <TableHead className="w-[100px]">Priority</TableHead>
              <TableHead className="w-[150px]">User</TableHead>
              <TableHead>What actually failed</TableHead>
              <TableHead className="w-[110px] pr-4 text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {display.map(({ row: r, count }) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() => router.push(`/admin/errors/${encodeURIComponent(r.errorId)}`)}
              >
                <TableCell className="whitespace-nowrap pl-4 text-xs text-muted-foreground">
                  {new Date(r.datetime).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.errorType}</TableCell>
                <TableCell>
                  <Badge variant={r.priority === "HIGH" ? "destructive" : "secondary"}>
                    {r.priority}
                  </Badge>
                </TableCell>
                <TableCell className="truncate text-xs">
                  {r.userName ?? r.userEmail ?? (
                    <span className="text-muted-foreground" title="No user — raised by a scheduled/background job">
                      Background job
                    </span>
                  )}
                </TableCell>
                {/* The real error, not the calm line the user saw. */}
                <TableCell className="text-xs" title={causeOf(r)}>
                  <div className="flex items-center gap-2">
                    <span className="line-clamp-2">{causeOf(r)}</span>
                    {count > 1 && (
                      <span
                        className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums"
                        title={`${count} occurrences`}
                      >
                        ×{count}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <Badge variant={r.status === "OPEN" ? "outline" : "secondary"}>{r.status}</Badge>
                </TableCell>
              </TableRow>
            ))}

            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}

            {!loading && display.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No errors match those filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {!loading && display.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {grouped
            ? `${display.length} distinct problems from ${rows.length} records.`
            : `${rows.length} shown${total > rows.length ? ` of ${total} matching` : ""}.`}{" "}
          Click any row for the full capture.
        </p>
      )}
    </AdminPage>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  anyLabel: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border bg-background px-2 text-sm"
      >
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
