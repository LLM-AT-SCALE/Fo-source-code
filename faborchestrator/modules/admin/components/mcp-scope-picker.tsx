"use client";

import { useEffect, useState } from "react";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Loader2 } from "lucide-react";

export type McpScopeValue = { mode: "all" } | { mode: "servers"; registryIds: string[] };

type RegistryEntry = { id: string; displayName: string; serverUrl: string; isActive: boolean };

export type TraceServerRef = { registryId: string | null; serverUrl: string | null; connectionName?: string | null };

/**
 * "All connected servers" vs "Selected servers" (from the MCP registry).
 * On first load, when the caller gave an empty selection, the servers found in
 * the request's trace are pre-checked (matched by registry id, else URL).
 */
export function McpScopePicker({
  value,
  onChange,
  token,
  traceServers = [],
  disabled = false,
}: {
  value: McpScopeValue;
  onChange: (v: McpScopeValue) => void;
  token: string | null;
  traceServers?: TraceServerRef[];
  disabled?: boolean;
}) {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unmatched, setUnmatched] = useState<TraceServerRef[]>([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/admin/mcp-registry", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { servers?: RegistryEntry[] } | null) => {
        if (cancelled) return;
        const active = (j?.servers ?? []).filter((s) => s.isActive);
        setEntries(active);
        // Pre-check the servers the trace touched.
        const preset: string[] = [];
        const missing: TraceServerRef[] = [];
        for (const t of traceServers) {
          const hit = active.find((s) => (t.registryId && s.id === t.registryId) || (t.serverUrl && s.serverUrl === t.serverUrl));
          if (hit) {
            if (!preset.includes(hit.id)) preset.push(hit.id);
          } else {
            missing.push(t);
          }
        }
        setUnmatched(missing);
        if (value.mode === "servers" && value.registryIds.length === 0 && preset.length) {
          onChange({ mode: "servers", registryIds: preset });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const selected = value.mode === "servers" ? value.registryIds : [];
  const toggle = (id: string) =>
    onChange({
      mode: "servers",
      registryIds: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
    });

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="mcp-scope"
          className="accent-primary"
          checked={value.mode === "all"}
          disabled={disabled}
          onChange={() => onChange({ mode: "all" })}
        />
        All connected servers
        <span className="text-xs text-muted-foreground">(runs on every server that exposes the tools)</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="mcp-scope"
          className="accent-primary"
          checked={value.mode === "servers"}
          disabled={disabled}
          onChange={() => onChange({ mode: "servers", registryIds: selected })}
        />
        Selected servers
      </label>

      {value.mode === "servers" && (
        <div className="ml-6 max-h-44 space-y-1.5 overflow-y-auto rounded-md border p-3">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active MCP servers in the registry.</p>
          ) : (
            entries.map((s) => (
              <label key={s.id} className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={selected.includes(s.id)} disabled={disabled} onCheckedChange={() => toggle(s.id)} />
                <span className="min-w-0">
                  <span className="font-medium">{s.displayName}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">{s.serverUrl}</span>
                </span>
              </label>
            ))
          )}
          {unmatched.length > 0 && (
            <p className="pt-1 text-[11px] text-amber-600">
              The request also used {unmatched.map((u) => u.connectionName || u.serverUrl || "an unknown server").join(", ")}, which is not in the registry.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
