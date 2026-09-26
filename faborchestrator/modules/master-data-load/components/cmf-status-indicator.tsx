"use client";

import { useCallback, useEffect, useState } from "react";
import { cmfFetch } from "@/modules/master-data-load/lib/cmf/client-auth";
import { cn } from "@/shared/lib/utils";

type CmfHealth =
  | {
      ok: boolean;
      noDatabase?: false;
      sql: { ok: boolean; ms: number; error?: string };
      rest: { ok: boolean; ms: number; status?: number; error?: string };
      checkedAt: string;
    }
  | {
      /** No enabled, granted database connection: nothing to probe. */
      ok: false;
      noDatabase: true;
      message: string;
      checkedAt: string;
    };

/**
 * Live CMF connectivity pill. The Modeling Agent (both the chat and the loader
 * wizard) only reaches CMF over the VPN, so this polls `/api/cmf/health`
 * (SQL + REST probes) and shows green (connected), red (unreachable — VPN likely
 * down), or amber (partial — e.g. SQL up but the REST host is blocked). Click to
 * re-check. Shared by the chat header and the loader header.
 *
 * The probe targets the database the CmfDatabaseToggle selected (sent as the
 * `x-cmf-db-key` header by cmfFetch). With no database connection at all the
 * server answers `noDatabase` and the pill is hidden: there is nothing to check.
 */
export function CmfStatusIndicator({ className }: { className?: string }) {
  const [health, setHealth] = useState<CmfHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const res = await cmfFetch("/api/cmf/health");
      const data = (await res.json().catch(() => null)) as CmfHealth | null;
      setHealth(data && "ok" in data ? data : null);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), 30_000);
    return () => clearInterval(id);
  }, [check]);

  // Nothing to probe: no enabled, granted database connection. The toggle
  // next to this pill already says so; a second "unknown" pill would only
  // suggest a connectivity problem that does not exist.
  if (health?.noDatabase) return null;

  let color = "bg-muted-foreground";
  let label = "CMF status unknown";
  let detail = "Couldn't run the connectivity check";
  if (loading && !health) {
    color = "bg-amber-400";
    label = "Checking CMF…";
    detail = "Probing SQL and REST connectivity";
  } else if (health?.ok) {
    color = "bg-emerald-500";
    label = "CMF connected";
    detail = `SQL ${health.sql.ms}ms · REST ${health.rest.ms}ms`;
  } else if (health && !health.sql.ok && !health.rest.ok) {
    color = "bg-red-500";
    label = "CMF unreachable — check VPN";
    detail = `SQL: ${health.sql.error ?? "down"} · REST: ${health.rest.error ?? "down"}`;
  } else if (health) {
    color = "bg-amber-500";
    const up = health.sql.ok ? "SQL" : "REST";
    const down = health.sql.ok ? "REST" : "SQL";
    label = `Partial — ${up} OK, ${down} blocked`;
    detail = health.sql.ok ? health.rest.error ?? "REST down" : health.sql.error ?? "SQL down";
  }

  return (
    <button
      type="button"
      onClick={() => void check()}
      title={`${detail}${health ? ` · checked ${new Date(health.checkedAt).toLocaleTimeString()}` : ""} — click to re-check`}
      aria-label={`CMF connectivity: ${label}. Click to re-check.`}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50",
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", color, loading && "animate-pulse")} />
      {label}
    </button>
  );
}
