import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

// POST /api/user/anthropic/test - Test Anthropic API key
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { apiKey } = await req.json();

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key is required' },
        { status: 400 }
      );
    }

    // Create a temporary Anthropic client with provided key
    const testAnthropic = createAnthropic({ apiKey });

    // Make a lightweight call to validate the key
    await generateText({
      model: testAnthropic('claude-haiku-4-5-20251001'),
      prompt: 'Say "ok"',
      maxOutputTokens: 5,
    });

    return NextResponse.json({
      success: true,
      message: 'Anthropic API key is valid.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('authentication') || errorMessage.includes('api_key') || errorMessage.includes('401')) {
      return NextResponse.json({
        success: false,
        error: 'Invalid API key',
      }, { status: 401 });
    }

    if (errorMessage.includes('permission') || errorMessage.includes('403')) {
      return NextResponse.json({
        success: false,
        error: 'Insufficient permissions for this API key.',
      }, { status: 403 });
    }

    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 });
  }
}
