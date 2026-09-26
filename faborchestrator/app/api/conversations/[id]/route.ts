import { NextRequest, NextResponse } from 'next/server';
import {
  getConversation,
  updateConversation,
  deleteConversation,
  toConversationResponse,
  toUIMessage,
} from '@/shared/lib/storage';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/conversations/[id] - Get single conversation with messages
export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const conversation = await getConversation(id);

    if (!conversation) {
      throw FabOrchError.noRowsReturned({ extra: { conversationId: id } });
    }

    if (conversation.userId !== user.id) {
      throw FabOrchError.ddlDmlRejected(undefined, {
        extra: { reason: 'cross-user access', conversationId: id },
      });
    }

    return NextResponse.json({
      ...toConversationResponse(conversation),
      messages: conversation.messages.map(toUIMessage),
    });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/conversations/[id]',
      userId: user.id,
    });
  }
}

// PATCH /api/conversations/[id] - Update conversation
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;

    const existing = await getConversation(id);
    if (!existing) {
      throw FabOrchError.noRowsReturned({ extra: { conversationId: id } });
    }
    if (existing.userId !== user.id) {
      throw FabOrchError.ddlDmlRejected(undefined, {
        extra: { reason: 'cross-user update', conversationId: id },
      });
    }

    const body = await req.json();
    const { title, isPinned, isShared, model } = body;

    const conversation = await updateConversation(id, {
      title,
      isPinned,
      isShared,
      model,
    });

    if (!conversation) {
      throw FabOrchError.sqlCallFailure(undefined, { extra: { reason: 'update returned null' } });
    }

    return NextResponse.json(toConversationResponse(conversation));
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/conversations/[id]',
      userId: user.id,
    });
  }
}

// DELETE /api/conversations/[id] - Delete conversation
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;

    const existing = await getConversation(id);
    if (!existing) {
      throw FabOrchError.noRowsReturned({ extra: { conversationId: id } });
    }
    if (existing.userId !== user.id) {
      throw FabOrchError.ddlDmlRejected(undefined, {
        extra: { reason: 'cross-user delete', conversationId: id },
      });
    }

    const deleted = await deleteConversation(id);
    if (!deleted) {
      throw FabOrchError.sqlCallFailure(undefined, { extra: { reason: 'delete returned false' } });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/conversations/[id]',
      userId: user.id,
    });
  }
}
