/**
 * Conversation Title Generation API
 * POST /api/conversations/[id]/title - Auto-generate title using Claude
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConversation, updateConversation } from '@/shared/lib/storage';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { anthropic } from '@/shared/lib/anthropic';
import { generateText } from 'ai';

// Generate a concise title for a conversation based on messages
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await context.params;

    // Get conversation with messages
    const conversation = await getConversation(id);

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Verify user owns this conversation
    if (conversation.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to access this conversation' },
        { status: 403 }
      );
    }

    // Need at least one user message and one assistant message
    if (conversation.messages.length < 2) {
      return NextResponse.json(
        { error: 'Not enough messages to generate title' },
        { status: 400 }
      );
    }

    // Get first user message and first assistant response
    const firstUserMessage = conversation.messages.find((m) => m.role === 'user');
    const firstAssistantMessage = conversation.messages.find((m) => m.role === 'assistant');

    if (!firstUserMessage || !firstAssistantMessage) {
      return NextResponse.json(
        { error: 'Missing user or assistant message' },
        { status: 400 }
      );
    }

    // Extract content (handle parts format)
    const userContent = firstUserMessage.content ||
      (firstUserMessage.parts as Array<{ type: string; text?: string }>)
        ?.filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('') || '';

    const assistantContent = firstAssistantMessage.content?.slice(0, 500) || '';

    // Generate title using Claude (use fast model)
    const { text: generatedTitle } = await generateText({
      model: anthropic('claude-haiku-4-5-20251001'),
      system: 'Generate a concise, descriptive title (3-6 words) for the conversation. The title should capture the main topic or intent. Do not use quotes or punctuation at the end. Only output the title, nothing else.',
      messages: [
        {
          role: 'user',
          content: `User's first message: "${userContent.slice(0, 300)}"

Assistant's response summary: "${assistantContent.slice(0, 200)}"

Generate a title:`,
        },
      ],
    });

    // Clean up the generated title
    const cleanTitle = generatedTitle
      .trim()
      .replace(/^["']|["']$/g, '') // Remove quotes
      .replace(/\.$/, '') // Remove trailing period
      .slice(0, 100); // Limit length

    // Update conversation with new title
    const updatedConversation = await updateConversation(id, {
      title: cleanTitle,
    });

    if (!updatedConversation) {
      return NextResponse.json(
        { error: 'Failed to update conversation title' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      title: cleanTitle,
      conversationId: id,
    });
  } catch (error) {
    console.error('Title generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate title' },
      { status: 500 }
    );
  }
}
