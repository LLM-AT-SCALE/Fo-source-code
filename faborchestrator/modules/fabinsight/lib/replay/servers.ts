/**
 * Map a program's connection scope to concrete MCP connection rows.
 *
 * A server is identified by its registry entry (`McpRegistry.id` = one server
 * URL). Connection rows (`mcp_connections`) are per-role / per-user copies of a
 * registry entry that carry the credentials `executeMcpTool` needs, so the
 * scheduler picks any active, connected row for the registry — preferring
 * role-level rows (`user_id IS NULL`) because they outlive individual users.
 *
 * Prisma is injected (and imported lazily) so unit tests never touch a DB.
 */

import type { ConnectionScope } from './program';

export type ResolvedServer = {
  registryId: string;
  serverUrl: string;
  /** Registry display name (falls back to the URL host). */
  label: string;
  /** Undefined when no usable connection row exists. */
  connectionId?: string;
  /** The row's status when one was found (executeMcpTool needs 'connected'). */
  connectionStatus?: string;
  /** The row's last connection error, when it is not connected — the real cause. */
  connectionError?: string;
};

type ConnRow = { id: string; registryId: string | null; serverUrl: string; status: string; userId: string | null; name: string; lastError?: string | null };
type RegRow = { id: string; serverUrl: string; displayName: string; isActive: boolean };

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ServerDeps = {
  prisma: {
    mcpConnection: { findMany(args: any): Promise<any[]> };
    mcpRegistry: { findMany(args: any): Promise<any[]> };
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

async function defaultDeps(): Promise<ServerDeps> {
  const { prisma } = await import('@/shared/lib/db');
  return { prisma: prisma as unknown as ServerDeps['prisma'] };
}

function labelFor(reg: Pick<RegRow, 'displayName' | 'serverUrl'> | undefined, serverUrl: string): string {
  if (reg?.displayName) return reg.displayName;
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl.replace(/^[a-z-]+:\/\//i, '').slice(0, 60) || 'server';
  }
}

/** Choose the best connection row for a registry: connected + role-level first. */
export function pickConnection(rows: ConnRow[]): ConnRow | undefined {
  const score = (r: ConnRow) => (r.status === 'connected' ? 2 : 0) + (r.userId === null ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a))[0];
}

export async function resolveServers(scope: ConnectionScope, deps?: ServerDeps): Promise<ResolvedServer[]> {
  const d = deps ?? (await defaultDeps());

  const registries: RegRow[] =
    scope.mode === 'all'
      ? await d.prisma.mcpRegistry.findMany({ where: { isActive: true }, orderBy: { displayName: 'asc' } })
      : await d.prisma.mcpRegistry.findMany({ where: { id: { in: scope.servers.map((s) => s.registryId) } } });
  const regById = new Map(registries.map((r) => [r.id, r]));

  const wanted: { registryId: string; serverUrl: string }[] =
    scope.mode === 'all'
      ? registries.map((r) => ({ registryId: r.id, serverUrl: r.serverUrl }))
      : scope.servers;
  if (!wanted.length) return [];

  const conns: ConnRow[] = await d.prisma.mcpConnection.findMany({
    // Dashboards replay through FabInsight's own connections only.
    where: { registryId: { in: wanted.map((w) => w.registryId) }, isActive: true, agent: 'fabinsight' },
    select: { id: true, registryId: true, serverUrl: true, status: true, userId: true, name: true, lastError: true },
  });

  /*
   * Reconnect before replaying. Chat reconnects a dropped connection the next
   * time someone lists it; the scheduler never did, so a server that failed
   * once left every scheduled dashboard on it stale ("connection … is error")
   * until a person happened to open chat. Only with the real client (tests
   * inject deps and stay pure), and never a connection someone deliberately
   * switched off.
   */
  if (!deps) {
    const down = conns.filter((c) => c.status !== 'connected');
    if (down.length) {
      try {
        const { prisma } = await import('@/shared/lib/db');
        const { autoConnectMcp } = await import('@/modules/mcp/lib/mcp-connect');
        const rows = await prisma.mcpConnection.findMany({ where: { id: { in: down.map((c) => c.id) } } });
        const fresh = await autoConnectMcp(rows, { respectManualOff: true });
        for (const f of fresh) {
          const c = conns.find((x) => x.id === f.id);
          if (c) {
            c.status = f.status;
            c.lastError = f.lastError;
          }
        }
      } catch (e) {
        // Reconnecting is an improvement, not a precondition: replay still
        // runs and reports each server's real state.
        console.warn('[replay] reconnect before replay failed:', e instanceof Error ? e.message : e);
      }
    }
  }
  const byReg = new Map<string, ConnRow[]>();
  for (const c of conns) {
    if (!c.registryId) continue;
    const list = byReg.get(c.registryId) ?? [];
    list.push(c);
    byReg.set(c.registryId, list);
  }

  const out: ResolvedServer[] = [];
  for (const w of wanted) {
    const reg = regById.get(w.registryId);
    const best = pickConnection(byReg.get(w.registryId) ?? []);
    // In 'all' mode a registry with no connection row at all is simply not connected — skip it.
    if (scope.mode === 'all' && !best) continue;
    out.push({
      registryId: w.registryId,
      serverUrl: reg?.serverUrl ?? w.serverUrl,
      label: labelFor(reg, reg?.serverUrl ?? w.serverUrl),
      connectionId: best?.id,
      connectionStatus: best?.status,
      ...(best && best.status !== 'connected' && best.lastError ? { connectionError: best.lastError } : {}),
    });
  }
  return out;
}
