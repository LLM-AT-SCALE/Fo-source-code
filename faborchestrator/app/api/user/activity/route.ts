import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { AGENT_KEYS, AGENT_LABELS, agentKeyFrom, type AgentKey } from '@/shared/lib/agents';
import { dashboardAccess } from '@/modules/fabinsight/lib/access';
import { visibilityWhere } from '@/modules/fabinsight/lib/visibility';
import type { ActivityItem, AgentUsage, UserActivity } from '@/modules/home/lib/activity-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** How many rows the cockpit's "Recent activity" card shows. */
const MAX_ITEMS = 6;

/** Where a row opens. No chat page takes a conversation id yet, so a conversation opens its agent. */
const AGENT_HREF: Record<AgentKey, string> = {
  'support-engineer': '/chat',
  fabinsight: '/chat?agent=fabinsight',
  'master-data-load': '/modeling-agent',
  'coding-agent': '/backend-agent',
};

/** A Master Data Load run in plain words: "<package> validated", "<package> load failed". */
function runText(operation: 'VALIDATE' | 'LOAD', status: string): { text: string; ok: boolean | null; active: boolean } {
  const validate = operation === 'VALIDATE';
  switch (status) {
    case 'QUEUED':
      return { text: validate ? 'validation queued' : 'load queued', ok: null, active: true };
    case 'RUNNING':
      return { text: validate ? 'validation in progress' : 'load in progress', ok: null, active: true };
    case 'SUCCESS':
      return { text: validate ? 'validated' : 'loaded', ok: true, active: false };
    case 'FAILURE':
      return { text: validate ? 'validation failed' : 'load failed', ok: false, active: false };
    case 'EXPIRED':
      return { text: validate ? 'validation expired' : 'load expired', ok: false, active: false };
    default:
      return { text: validate ? 'validation' : 'load', ok: null, active: false };
  }
}

/** A dashboard request's status in plain words. */
function requestText(status: string): { text: string; active: boolean } {
  switch (status) {
    case 'requested':
      return { text: 'pending approval', active: false };
    case 'approved':
    case 'compiling':
      return { text: 'being prepared', active: true };
    case 'compile_failed':
      return { text: 'could not be prepared', active: false };
    case 'preview_ready':
      return { text: 'preview ready', active: false };
    case 'live':
      return { text: 'live', active: false };
    case 'denied':
      return { text: 'declined', active: false };
    case 'cancelled':
      return { text: 'cancelled', active: false };
    default:
      return { text: 'requested', active: false };
  }
}

/**
 * GET /api/user/activity — the signed-in user's recent work across the four agents.
 *
 * Newest first, at most six rows, drawn from the user's conversations, Master Data
 * Load runs and dashboard requests; plus per-agent usage and the totals the
 * cockpit's "Live ops" tiles show. Everything is scoped to the caller.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const access = await dashboardAccess(user.id);
    const me = { id: user.id, roleId: user.roleId ?? null, isAdmin: access.isAdmin };

    const [conversations, byAgent, conversationsThisWeek, runs, dataLoads, requests, dashboardsPending, dashboards] =
      await Promise.all([
        prisma.conversation.findMany({
          where: { userId: user.id, deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: MAX_ITEMS,
          select: { id: true, title: true, agent: true, updatedAt: true, lastMessageAt: true },
        }),
        prisma.conversation.groupBy({
          by: ['agent'],
          where: { userId: user.id, deletedAt: null },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
        prisma.conversation.count({ where: { userId: user.id, deletedAt: null, updatedAt: { gte: weekAgo } } }),
        prisma.run.findMany({
          where: { userId: user.id },
          orderBy: { startedAt: 'desc' },
          take: MAX_ITEMS,
          select: {
            id: true,
            packageId: true,
            operation: true,
            status: true,
            startedAt: true,
            endedAt: true,
            package: { select: { name: true } },
          },
        }),
        prisma.run.count({ where: { userId: user.id } }),
        prisma.dashboardRequest.findMany({
          where: { requesterId: user.id },
          orderBy: { updatedAt: 'desc' },
          take: MAX_ITEMS,
          select: { id: true, title: true, status: true, updatedAt: true },
        }),
        prisma.dashboardRequest.count({ where: { requesterId: user.id, status: 'requested' } }),
        prisma.dashboard.count({ where: visibilityWhere(me) }),
      ]);

    const items: ActivityItem[] = [];

    for (const c of conversations) {
      const agent = agentKeyFrom(c.agent);
      items.push({
        agent,
        label: AGENT_LABELS[agent],
        description: c.title?.trim() || 'New conversation',
        at: (c.lastMessageAt ?? c.updatedAt).toISOString(),
        href: AGENT_HREF[agent],
      });
    }

    for (const r of runs) {
      const t = runText(r.operation, r.status);
      items.push({
        agent: 'master-data-load',
        label: AGENT_LABELS['master-data-load'],
        description: `${r.package.name} ${t.text}`,
        at: (r.endedAt ?? r.startedAt).toISOString(),
        href: `/modeling-agent/loader/${encodeURIComponent(r.packageId)}`,
        active: t.active || undefined,
      });
    }

    for (const d of requests) {
      const t = requestText(d.status);
      items.push({
        agent: 'fabinsight',
        label: AGENT_LABELS.fabinsight,
        description: `${d.title} · ${t.text}`,
        at: d.updatedAt.toISOString(),
        href: '/reports',
        active: t.active || undefined,
      });
    }

    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const agents = Object.fromEntries(
      AGENT_KEYS.map((k) => [k, { conversations: 0, lastActiveAt: null }]),
    ) as Record<AgentKey, AgentUsage>;
    for (const row of byAgent) {
      const usage = agents[agentKeyFrom(row.agent)];
      usage.conversations += row._count._all;
      const at = row._max.updatedAt?.toISOString() ?? null;
      if (at && (!usage.lastActiveAt || at > usage.lastActiveAt)) usage.lastActiveAt = at;
    }

    const latestRun = runs[0];
    const lastDataLoad = latestRun
      ? (() => {
          const t = runText(latestRun.operation, latestRun.status);
          return { text: `${latestRun.package.name} ${t.text}`, ok: t.ok };
        })()
      : null;

    const body: UserActivity = {
      items: items.slice(0, MAX_ITEMS),
      agents,
      totals: {
        conversations: byAgent.reduce((n, row) => n + row._count._all, 0),
        conversationsThisWeek,
        dashboards,
        dashboardsPending,
        dataLoads,
        lastDataLoad,
      },
    };
    return NextResponse.json(body);
  } catch (error) {
    return handleApiError(error, req, { route: '/api/user/activity', userId: user.id });
  }
}
