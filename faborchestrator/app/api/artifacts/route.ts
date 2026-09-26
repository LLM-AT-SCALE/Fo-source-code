import { NextRequest, NextResponse } from 'next/server';
import { getConversationArtifacts, createArtifact, getConversation } from '@/shared/lib/storage';
import { requireAuth } from '@/shared/lib/auth-middleware';

// GET /api/artifacts?conversationId=xxx - Get all artifacts for a conversation
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const conversationId = req.nextUrl.searchParams.get('conversationId');

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 }
      );
    }

    // Verify user owns this conversation
    const conversation = await getConversation(conversationId);
    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to access this conversation' },
        { status: 403 }
      );
    }

    const artifacts = await getConversationArtifacts(conversationId);

    return NextResponse.json(
      artifacts.map((a) => ({
        id: a.id,
        conversationId: a.conversationId,
        messageId: a.messageId,
        type: a.type,
        title: a.title,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        // Don't include full content in list response for performance
        contentLength: a.content.length,
      }))
    );
  } catch (error) {
    console.error('Error fetching artifacts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch artifacts' },
      { status: 500 }
    );
  }
}

// POST /api/artifacts - Create a new artifact
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const body = await req.json();
    const { conversationId, messageId, type, title, content } = body;

    if (!conversationId || !messageId || !title || !content) {
      return NextResponse.json(
        { error: 'conversationId, messageId, title, and content are required' },
        { status: 400 }
      );
    }

    // Verify user owns this conversation
    const conversation = await getConversation(conversationId);
    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to access this conversation' },
        { status: 403 }
      );
    }

    const artifact = await createArtifact({
      conversationId,
      messageId,
      userId: user.id,
      type: type || 'html',
      title,
      content,
    });

    return NextResponse.json({
      id: artifact.id,
      conversationId: artifact.conversationId,
      messageId: artifact.messageId,
      type: artifact.type,
      title: artifact.title,
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating artifact:', error);
    return NextResponse.json(
      { error: 'Failed to create artifact' },
      { status: 500 }
    );
  }
}
