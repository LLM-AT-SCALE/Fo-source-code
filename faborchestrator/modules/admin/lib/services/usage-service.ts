/**
 * Usage Service - Usage aggregation for the admin dashboard.
 */

import prisma from '@/shared/lib/db';

/**
 * Get aggregated usage data for admin dashboard.
 */
export async function getSystemUsageSummary(days: number = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totals, perModel, perUser, dailyTrend] = await Promise.all([
    prisma.usageRecord.aggregate({
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, outputTokens: true, thinkingTokens: true },
    }),
    prisma.usageRecord.groupBy({
      by: ['model'],
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.usageRecord.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, outputTokens: true },
    }),
    // Daily trend - last 30 days grouped by date
    prisma.$queryRawUnsafe<Array<{ date: string; count: number; tokens: number }>>(
      `SELECT DATE(created_at) as date, COUNT(*)::int as count,
       COALESCE(SUM(input_tokens + output_tokens + thinking_tokens), 0)::int as tokens
       FROM usage_records WHERE created_at >= $1
       GROUP BY DATE(created_at) ORDER BY date`,
      since
    ).catch(() => []),
  ]);

  return {
    totalRequests: totals._count,
    totalTokens: (totals._sum.inputTokens || 0) + (totals._sum.outputTokens || 0) + (totals._sum.thinkingTokens || 0),
    perModel: perModel.map((m) => ({
      model: m.model,
      requests: m._count,
      tokens: (m._sum.inputTokens || 0) + (m._sum.outputTokens || 0),
    })),
    perUser,
    dailyTrend,
    days,
  };
}
