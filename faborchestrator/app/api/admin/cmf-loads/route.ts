import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';

/**
 * CMF Master-Data Loader (Modeling Agent) oversight metrics for the admin
 * "Data Loader" dashboard view. READ-ONLY and resilient: if the cmf_* tables
 * don't exist yet, every block degrades to zeros/empty instead of a 500.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const [totalPackages, totalRuns, success, failure, inFlight, recentRaw] = await Promise.all([
      prisma.package.count(),
      prisma.run.count(),
      prisma.run.count({ where: { result: 0 } }),
      prisma.run.count({ where: { result: 1 } }),
      prisma.run.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
      prisma.run.findMany({
        take: 12,
        orderBy: { startedAt: 'desc' },
        include: {
          package: { select: { name: true } },
          user: { select: { email: true } },
        },
      }),
    ]);

    const decided = success + failure;
    const successRate = decided > 0 ? Math.round((success / decided) * 1000) / 10 : null;

    const recent = recentRaw.map((r) => ({
      id: r.id,
      packageName: r.package?.name ?? '—',
      operation: r.operation,
      status: r.status,
      result: r.result,
      user: r.user?.email ?? '—',
      startedAt: r.startedAt.toISOString(),
    }));

    return NextResponse.json({
      totalPackages,
      totalRuns,
      success,
      failure,
      inFlight,
      successRate,
      recent,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/cmf-loads] failed (cmf_* tables missing?):', error);
    return NextResponse.json({
      totalPackages: 0,
      totalRuns: 0,
      success: 0,
      failure: 0,
      inFlight: 0,
      successRate: null,
      recent: [],
      degraded: true,
    });
  }
}
