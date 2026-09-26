"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/shared/components/ui/switch";
import { cn } from "@/shared/lib/utils";
import { CMF_ACTIVE_DB_KEY } from "@/modules/master-data-load/lib/cmf/client-auth";

/**
 * Per-user selector for WHICH CMF database the Modeling Agent uses.
 *
 * The list of databases is DYNAMIC — fetched from `/api/cmf/connections`, which
 * returns the enabled admin-managed connections this user is granted. A
 * connection added in Admin → Database Connections appears here automatically;
 * with none, the pill says so and nothing is selected (there is no built-in
 * default). Exactly ONE is active at a time, used for both export (read) and
 * load (write). To move data across databases, export against one, switch, then
 * load against the other — the staged file is environment-independent, so this
 * works without a separate load selector.
 *
 * The choice persists in the user's settings (`preferences.cmfDb` /
 * `preferences.cmfLoadDbKey`) and is sent up with every chat request via the
 * `onChange` callback (as `{ cmfDbs, loadDbKey }`, which the chat route reads).
 */

type CmfDbKey = string;
export type CmfDbSelection = {
  cmfDbs: Record<CmfDbKey, boolean>;
  loadDbKey: CmfDbKey;
};

type DbOption = { key: string; label: string };

/** Where the list stands: still loading, loaded, or the request failed. */
type ListState = "loading" | "ready" | "error";

/** Build the request-shaped selection (one active DB) from the current db list. */
function selectionFor(active: string, dbs: DbOption[]): CmfDbSelection {
  // No accessible database → send an empty selection (the server also enforces).
  if (!active) return { cmfDbs: {}, loadDbKey: "" };
  const cmfDbs: Record<string, boolean> = {};
  for (const d of dbs) cmfDbs[d.key] = d.key === active;
  cmfDbs[active] = true;
  return { cmfDbs, loadDbKey: active };
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("llmatscale_auth_token") : null;
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

export function CmfDatabaseToggle({
  onChange,
  className,
}: {
  onChange: (sel: CmfDbSelection) => void;
  className?: string;
}) {
  const [dbs, setDbs] = useState<DbOption[]>([]);
  const [active, setActive] = useState<string>("");
  const [listState, setListState] = useState<ListState>("loading");
  // How many enabled connections exist at all (before the per-user grant
  // filter) — tells "no database has been added" from "none granted to you".
  const [available, setAvailable] = useState<number>(0);
  const [open, setOpen] = useState(false);
  // Keep the full preferences blob so a PATCH doesn't clobber other settings.
  const prefsRef = useRef<Record<string, unknown>>({});
  // Mirrors `active` so `apply` (a []-dep callback) can compare against the
  // previous value without going stale.
  const activeRef = useRef<string>("");
  const dbsRef = useRef<DbOption[]>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const labelFor = useCallback(
    (key: string) => dbsRef.current.find((d) => d.key === key)?.label ?? key,
    [],
  );

  // Load the dynamic DB list + the saved selection once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) Fetch the databases the user is GRANTED (server filters by access).
      //    An empty array is a valid answer and is honored: there is no
      //    built-in fallback. A failed request leaves the pill "unavailable".
      let list: DbOption[] = [];
      let total = 0;
      let state: ListState = "error";
      try {
        const r = await fetch("/api/cmf/connections", { headers: authHeaders() });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d?.connections)) {
            list = d.connections;
            total = typeof d.available === "number" ? d.available : list.length;
            state = "ready";
          }
        }
      } catch {
        /* request failed — stays "error" */
      }
      if (cancelled) return;
      dbsRef.current = list;
      setDbs(list);
      setAvailable(total);
      setListState(state);

      // 2) Fetch the saved selection.
      let savedKey: string | null = null;
      try {
        const res = await fetch("/api/user/settings", { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          const prefs = (data?.preferences ?? {}) as Record<string, unknown>;
          prefsRef.current = prefs;
          if (typeof prefs.cmfLoadDbKey === "string") savedKey = prefs.cmfLoadDbKey;
        }
      } catch {
        /* best-effort — keep default */
      }
      if (cancelled) return;

      // 3) Active = saved key if still granted, else the first granted DB, else
      //    "" (no database).
      const valid = new Set(list.map((d) => d.key));
      const next = savedKey && valid.has(savedKey) ? savedKey : list[0]?.key ?? "";
      setActive(next);
      activeRef.current = next;
      try {
        if (next) localStorage.setItem(CMF_ACTIVE_DB_KEY, next);
        else localStorage.removeItem(CMF_ACTIVE_DB_KEY);
      } catch { /* ignore */ }
      onChangeRef.current(selectionFor(next, list));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback((next: string) => {
    const prev = activeRef.current;
    setActive(next);
    activeRef.current = next;

    // Confirm the switch. This is not decoration: the active database is the
    // target for LOADS as well as exports, so a silent change is the kind that
    // ends with data written to the wrong system. Naming it makes the change
    // visible at the moment it happens.
    //
    // Only on a real change — re-selecting the database already in use is a
    // no-op and should not produce a notification.
    if (prev !== next) {
      const label = dbsRef.current.find((d) => d.key === next)?.label ?? next;
      toast.success(`Switched to ${label}`, {
        description: "Exports read from, and loads write to, this database.",
      });
    }

    try { localStorage.setItem(CMF_ACTIVE_DB_KEY, next); } catch { /* ignore */ }
    const sel = selectionFor(next, dbsRef.current);
    onChangeRef.current(sel);
    const merged = { ...prefsRef.current, cmfDb: sel.cmfDbs, cmfLoadDbKey: next };
    prefsRef.current = merged;
    fetch("/api/user/settings", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ preferences: merged }),
    }).catch(() => {
      /* best-effort persist */
    });
  }, []);

  // Mutually exclusive: turning a database ON makes it the active one; turning
  // the active one OFF is ignored (exactly one must always be active).
  const onToggle = useCallback(
    (key: string, on: boolean) => {
      if (on) apply(key);
      // off on the active one → no-op (switch by enabling the other instead)
    },
    [apply],
  );

  const none = listState === "ready" && dbs.length === 0;
  // Pill text: the active database; otherwise say plainly why there is none.
  const pillText =
    listState === "loading" ? "DB: …"
    : listState === "error" ? "DB: unavailable"
    : active ? `DB: ${labelFor(active)}`
    : available === 0 ? "No database connections"
    : "DB: none granted";
  const pillTitle =
    none
      ? available === 0
        ? "No database connections. An administrator adds them in Admin → Database Connections."
        : "No database is granted to you. Ask an administrator for access."
      : "Choose which CMF database to export from and load into";

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        data-testid="cmf-db-toggle"
        data-state={none ? "none" : listState}
        onClick={() => setOpen((o) => !o)}
        title={pillTitle}
        aria-label={active ? `CMF database: ${labelFor(active)}. Click to change.` : pillText}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <span className={cn("size-2 rounded-full", active ? "bg-sky-500" : "bg-muted-foreground/40")} />
        {pillText}
      </button>

      {open && (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-border bg-card p-3 shadow-lg">
            <div className="mb-2 text-xs font-semibold text-foreground">CMF database</div>
            {listState === "loading" ? (
              <p className="text-xs text-muted-foreground">Loading your database connections…</p>
            ) : listState === "error" ? (
              <p className="text-xs text-muted-foreground">
                The database connections could not be loaded. Reload the page to try again.
              </p>
            ) : dbs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {available === 0
                  ? "No database connections have been added yet. An administrator adds them in Admin → Database Connections."
                  : "No databases are assigned to you. Ask an administrator to grant access."}
              </p>
            ) : (
              <div className="space-y-2">
                {dbs.map((db) => (
                  <label key={db.key} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-foreground">{db.label}</span>
                    <Switch
                      checked={active === db.key}
                      onCheckedChange={(on) => onToggle(db.key, on)}
                      aria-label={`Use ${db.label}`}
                    />
                  </label>
                ))}
              </div>
            )}
            {dbs.length > 0 && (
              <p className="mt-3 border-t border-border pt-2 text-[10px] leading-snug text-muted-foreground">
                The active database is used for both export and load. To move data
                across, export here, switch, then load.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
