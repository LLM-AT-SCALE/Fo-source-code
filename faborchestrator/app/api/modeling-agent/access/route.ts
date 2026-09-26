import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { isPlatformAdmin } from '@/shared/lib/permissions';

export const runtime = 'nodejs';

/** Whether the signed-in user's role enables the Modeling Agent. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const dbUser = await prisma.user.findUnique({
    where: { id: auth.user.id },
    include: { role: true },
  });
  const perms = Array.isArray(dbUser?.role?.permissions)
    ? (dbUser!.role!.permissions as string[])
    : [];
  const enabled = isPlatformAdmin(dbUser) || perms.includes('modeling_agent');
  return NextResponse.json({ enabled });
}
