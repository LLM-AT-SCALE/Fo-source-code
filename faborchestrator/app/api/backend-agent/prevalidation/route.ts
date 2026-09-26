/**
 * THE PRE-VALIDATION REPORT for a conversation.
 *
 * `GET /api/backend-agent/prevalidation?conversationId=…`
 *
 * Returns `{ status: "running" }` until the report lands, then the report
 * itself. The UI polls this after an upload; there is no socket, and there does
 * not need to be — the whole thing takes one model call.
 *
 * Owner-scoped like every other route in this family: the run directory is keyed
 * by conversation id, so without the ownership check any signed-in user could
 * read the analysis of someone else's requirement document.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { readPreValidation } from '@/modules/coding-agent/lib/prevalidation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const conversationId = req.nextUrl.searchParams.get('conversationId') ?? '';
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required.' }, { status: 400 });
  }

  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  return NextResponse.json(readPreValidation(conversationId));
}
