import { getSessionByToken, updateUser } from '@/shared/lib/storage';
import { encrypt } from '@/shared/lib/encryption';

// Helper to get user from request
async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const session = await getSessionByToken(token);

  if (!session || session.expiresAt < new Date()) {
    return null;
  }

  return session.user;
}

// GET /api/user/settings - Get user settings
export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return Response.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Don't send encrypted credentials, just indicate if they're set
    return Response.json({
      name: user.name,
      avatarUrl: user.avatarUrl,
      hasAnthropicApiKey: !!user.anthropicApiKeyEncrypted,
      preferences: user.preferences,
    });
  } catch (error) {
    console.error('Get settings error:', error);
    return Response.json(
      { error: 'Failed to get settings' },
      { status: 500 }
    );
  }
}

// PATCH /api/user/settings - Update user settings
export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return Response.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { name, avatarUrl, anthropicApiKey, preferences } = body;

    // Build update object
    const updates: Record<string, unknown> = {};

    if (name !== undefined) updates.name = name;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
    if (preferences !== undefined) updates.preferences = preferences;

    // Encrypt Anthropic API key if provided
    if (anthropicApiKey !== undefined) {
      updates.anthropicApiKeyEncrypted = anthropicApiKey ? encrypt(anthropicApiKey) : null;
    }

    // Update user
    const updatedUser = await updateUser(user.id, updates);

    if (!updatedUser) {
      return Response.json(
        { error: 'Failed to update settings' },
        { status: 500 }
      );
    }

    return Response.json({
      name: updatedUser.name,
      avatarUrl: updatedUser.avatarUrl,
      hasAnthropicApiKey: !!updatedUser.anthropicApiKeyEncrypted,
      preferences: updatedUser.preferences,
    });
  } catch (error) {
    console.error('Update settings error:', error);
    return Response.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
