import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { updateUser } from '@/shared/lib/storage';
import { encrypt, decrypt } from '@/shared/lib/encryption';

// GET /api/user/anthropic - Get Anthropic API key status (masked)
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const hasApiKey = !!user.anthropicApiKeyEncrypted;

    let maskedKey = '';
    if (hasApiKey && user.anthropicApiKeyEncrypted) {
      try {
        const apiKey = decrypt(user.anthropicApiKeyEncrypted);
        maskedKey = apiKey.slice(0, 7) + '****' + apiKey.slice(-4);
      } catch {
        maskedKey = 'sk-ant-****';
      }
    }

    return NextResponse.json({
      hasApiKey,
      maskedKey,
    });
  } catch (error) {
    console.error('Error fetching Anthropic API key status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch API key status' },
      { status: 500 }
    );
  }
}

// POST /api/user/anthropic - Save Anthropic API key
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { apiKey } = await req.json();

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key is required' },
        { status: 400 }
      );
    }

    // Validate Anthropic API key format
    if (!apiKey.startsWith('sk-ant-')) {
      return NextResponse.json(
        { error: 'Invalid Anthropic API key format. Key should start with "sk-ant-"' },
        { status: 400 }
      );
    }

    // Encrypt and store
    const encryptedKey = encrypt(apiKey);

    await updateUser(user.id, {
      anthropicApiKeyEncrypted: encryptedKey,
    });

    return NextResponse.json({
      success: true,
      message: 'Anthropic API key saved successfully',
    });
  } catch (error) {
    console.error('Error saving Anthropic API key:', error);
    return NextResponse.json(
      { error: 'Failed to save API key' },
      { status: 500 }
    );
  }
}
