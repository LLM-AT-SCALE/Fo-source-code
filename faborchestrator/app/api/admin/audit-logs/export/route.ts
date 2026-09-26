import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const format = url.searchParams.get('format') || 'csv';

    const logs = await prisma.auditLog.findMany({
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    if (format === 'json') {
      return new NextResponse(JSON.stringify(logs, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="audit-logs.json"',
        },
      });
    }

    // CSV
    const header = 'Date,Action,User,Target Type,Target ID,IP Address\n';
    const rows = logs.map((l) =>
      `"${l.createdAt.toISOString()}","${l.action}","${l.user?.email || 'system'}","${l.targetType || ''}","${l.targetId || ''}","${l.ipAddress || ''}"`
    ).join('\n');

    return new NextResponse(header + rows, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="audit-logs.csv"',
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json({ error: 'Failed to export' }, { status: 500 });
  }
}
