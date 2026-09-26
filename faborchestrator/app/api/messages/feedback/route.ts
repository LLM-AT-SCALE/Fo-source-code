/**
 * Message Feedback API
 * POST /api/messages/feedback - Store feedback for a message
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { updateMessage, getConversation } from '@/shared/lib/storage';
import prisma from '@/shared/lib/db';
import {
  MessageFeedbackSchema,
  validate,
  formatValidationErrors,
} from '@/shared/lib/validation';

export async function POST(req: NextRequest) {
  // Require authentication
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const body = await req.json();

    // Validate request body
    const validation = validate(MessageFeedbackSchema, body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatValidationErrors(validation.errors!) },
        { status: 400 }
      );
    }

    const { messageId, feedback, comment } = validation.data!;

    // Get current message to preserve existing metadata
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });

    if (!message) {
      return NextResponse.json(
        { error: 'Message not found' },
        { status: 404 }
      );
    }

    // Verify the message belongs to a conversation owned by the user
    const conversation = await getConversation(message.conversationId);
    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to provide feedback on this message' },
        { status: 403 }
      );
    }

    // Update message metadata with feedback
    const existingMetadata = (message.metadata as Record<string, unknown>) || {};
    const updatedMetadata = {
      ...existingMetadata,
      feedback: {
        rating: feedback,
        comment: comment || null,
        timestamp: new Date().toISOString(),
      },
    };

    // Update the message
    const updatedMessage = await updateMessage(messageId, {
      metadata: updatedMetadata,
    });

    if (!updatedMessage) {
      return NextResponse.json(
        { error: 'Failed to save feedback' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      messageId,
      feedback,
    });
  } catch (error) {
    console.error('Feedback error:', error);
    return NextResponse.json(
      { error: 'Failed to save feedback' },
      { status: 500 }
    );
  }
}
