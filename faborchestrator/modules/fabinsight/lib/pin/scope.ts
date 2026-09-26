/**
 * The data servers a pinned dashboard refreshes from, derived from the chat
 * trace — the same rule the admin approval screen applies by default
 * (modules/admin/components/decision-panel.tsx): every ACTIVE registry server
 * the trace touched, matched by registry id or server address; every connected
 * server when none of them is in the registry.
 */

import { prisma } from '@/shared/lib/db';
import { traceServers, type TraceStep } from '@/modules/fabinsight/lib/pin/trace';
import type { ConnectionScope } from '@/modules/admin/lib/dashboards/dashboard-service';

export async function scopeFromTrace(trace: TraceStep[]): Promise<ConnectionScope> {
  const refs = traceServers(trace);
  if (!refs.length) return { mode: 'all' };
  const active = await prisma.mcpRegistry.findMany({ where: { isActive: true }, select: { id: true, serverUrl: true } });
  const servers: { registryId: string; serverUrl: string }[] = [];
  for (const t of refs) {
    const hit = active.find((s) => (t.registryId && s.id === t.registryId) || (t.serverUrl && s.serverUrl === t.serverUrl));
    if (hit && !servers.some((s) => s.registryId === hit.id)) servers.push({ registryId: hit.id, serverUrl: hit.serverUrl });
  }
  return servers.length ? { mode: 'fixed', servers } : { mode: 'all' };
}
