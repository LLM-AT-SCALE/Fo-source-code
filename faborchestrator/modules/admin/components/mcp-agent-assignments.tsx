"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/shared/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, Wrench, X } from "lucide-react";
import { AGENT_KEYS, AGENT_LABELS, type AgentKey } from "@/shared/lib/agents";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface AssignedMcp { id: string; name: string; registryId: string | null; agent: string }
interface CatalogConnector { id: string; displayName: string; isActive: boolean }

/**
 * MCP connectors per agent for one target (a role or a user). Each agent has
 * its own list and its own picker: a connector attached under FabInsight is
 * invisible to the other agents. An agent with nothing attached simply has no
 * connectors there — there is no fallback to another agent's list.
 */
export function McpAgentAssignments({ roleId, userId, compact = false }: { roleId?: string; userId?: string; compact?: boolean }) {
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
  const target = roleId ? `roleId=${roleId}` : `userId=${userId}`;
  const [assigned, setAssigned] = useState<AssignedMcp[]>([]);
  const [catalog, setCatalog] = useState<CatalogConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token || (!roleId && !userId)) return;
    setLoading(true);
    try {
      const [aRes, cRes] = await Promise.all([
        fetch(`/api/admin/mcp?${target}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/mcp-registry`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const a = await aRes.json();
      const c = await cRes.json();
      setAssigned(a.connections || []);
      setCatalog((c.servers || []).filter((s: CatalogConnector) => s.isActive));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [token, target, roleId, userId]);

  useEffect(() => { load(); }, [load]);

  const assign = async (agent: AgentKey) => {
    const registryId = pick[agent];
    if (!registryId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ registryId, agent, ...(roleId ? { roleId } : { userId }) }),
      });
      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed to attach"); return; }
      toast.success(`Attached to ${AGENT_LABELS[agent]}`);
      setPick((p) => ({ ...p, [agent]: "" }));
      load();
    } catch { toast.error("Failed to attach"); } finally { setBusy(false); }
  };

  const remove = async (connId: string, name: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/mcp/${connId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { toast.error("Failed to remove"); return; }
      toast.success(`"${name}" removed`);
      load();
    } catch { toast.error("Failed to remove"); } finally { setBusy(false); }
  };

  if (loading) return <div className="h-8 animate-pulse rounded-md bg-muted" />;

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {AGENT_KEYS.map((agent) => {
        const rows = assigned.filter((m) => m.agent === agent);
        const available = catalog.filter((c) => !rows.some((r) => r.registryId === c.id || r.name === c.displayName));
        return (
          <div key={agent} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{AGENT_LABELS[agent]}</p>
              <span className="text-xs text-muted-foreground">{rows.length === 0 ? "No connectors" : `${rows.length} connector${rows.length === 1 ? "" : "s"}`}</span>
            </div>
            {rows.map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                <Wrench className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">{m.name}</span>
                {!m.registryId && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground" title="Added by the user in chat settings">
                    Personal
                  </span>
                )}
                <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500" disabled={busy} onClick={() => remove(m.id, m.name)} title="Remove" aria-label={`Remove ${m.name} from ${AGENT_LABELS[agent]}`}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Select value={pick[agent] ?? ""} onValueChange={(v) => setPick((p) => ({ ...p, [agent]: v }))} disabled={available.length === 0}>
                <SelectTrigger aria-label={`Attach MCP connector for ${AGENT_LABELS[agent]}`} className="h-9 w-full flex-1">
                  <SelectValue placeholder={available.length ? "Attach a connector…" : "All active connectors attached"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {available.map((c) => <SelectItem key={c.id} value={c.id}>{c.displayName}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button type="button" size="sm" disabled={!pick[agent] || busy} onClick={() => assign(agent)} aria-label={`Attach connector to ${AGENT_LABELS[agent]}`}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
