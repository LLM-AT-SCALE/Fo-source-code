// Database storage layer for conversations and messages
// Uses PostgreSQL with Prisma ORM

import prisma from './db';
import type {
  User,
  Conversation,
  Message,
  Artifact,
  McpConnection,
  Session,
  MemoryFile,
} from '@/lib/generated/prisma/client';

// Re-export types for use in other modules
export type {
  User,
  Conversation,
  Message,
  Artifact,
  McpConnection,
  Session,
  MemoryFile,
};

// ============================================
// User Operations
// ============================================

export async function getUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { email },
  });
}

export async function updateUser(
  id: string,
  data: Record<string, unknown>
): Promise<User | null> {
  return prisma.user.update({
    where: { id },
    data: data as Parameters<typeof prisma.user.update>[0]['data'],
  });
}

// ============================================
// Session Operations
// ============================================

export async function createSession(data: {
  userId: string;
  token: string;
  expiresAt: Date;
}): Promise<Session> {
  return prisma.session.create({
    data: {
      userId: data.userId,
      token: data.token,
      expiresAt: data.expiresAt,
    },
  });
}

export async function getSessionByToken(token: string): Promise<(Session & { user: User }) | null> {
  return prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });
}

export async function deleteSession(token: string): Promise<boolean> {
  try {
    await prisma.session.delete({ where: { token } });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Conversation Operations
// ============================================

export async function createConversation(data: {
  title?: string;
  model?: string;
  userId: string;
  agent?: string;
}): Promise<Conversation> {
  return prisma.conversation.create({
    data: {
      userId: data.userId,
      title: data.title || 'New Chat',
      model: data.model || 'claude-fable-5-1',
      agent: data.agent || 'chat',
    },
  });
}

export async function getConversation(id: string): Promise<(Conversation & { messages: Message[] }) | null> {
  return prisma.conversation.findFirst({
    where: { id, deletedAt: null },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

export async function getAllConversations(
  userId: string,
  agent = 'chat'
): Promise<Conversation[]> {
  return prisma.conversation.findMany({
    where: { userId, deletedAt: null, agent },
    orderBy: [
      { isPinned: 'desc' },
      { updatedAt: 'desc' },
    ],
  });
}

export async function updateConversation(
  id: string,
  data: Record<string, unknown>
): Promise<Conversation | null> {
  try {
    return await prisma.conversation.update({
      where: { id },
      data: data as Parameters<typeof prisma.conversation.update>[0]['data'],
    });
  } catch {
    return null;
  }
}

export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await prisma.conversation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Message Operations
// ============================================

export interface MessageInput {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  parts?: unknown[];
  metadata?: Record<string, unknown>;
  /**
   * Optional explicit id. The chat route passes the stream's own message id so
   * the id the client holds during a live turn is the id persisted here — which
   * is what lets an artifact be pinned (by message id) right after it streams.
   */
  id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id to save a user's message under: the one the browser already shows.
 *
 * The chat renders a message the moment it is sent, under an id the browser
 * made up. Saving it under a DIFFERENT, server-made id meant every action on
 * that message before a reload — Delete, Edit — asked the server for an id it
 * had never stored, and failed with "message not found". So the browser's id
 * is kept, when it is a real UUID that is not already in use; otherwise the
 * database assigns one as before, and nothing can break saving.
 */
/**
 * A message the browser RE-sends (Retry, or Save after an edit) arrives with an
 * id that is already stored. Saving it again duplicated the question; instead
 * keep the stored row and clear whatever came after it — the replies being
 * regenerated (a partial answer saved before a failure, or the answers to the
 * pre-edit text). Returns true when this was a resend, so the caller skips the insert.
 */
export async function prepareResend(
  conversationId: string,
  id: unknown,
  /** Called with the resent question's saved time BEFORE the old replies are
   *  deleted — so a stopped turn saving meanwhile can tell it was replaced. */
  onResend?: (questionAt: Date) => void,
): Promise<boolean> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return false;
  const existing = await prisma.message
    .findFirst({ where: { id, conversationId }, select: { createdAt: true } })
    .catch(() => null);
  if (!existing) return false;
  onResend?.(existing.createdAt);
  await prisma.message.deleteMany({ where: { conversationId, createdAt: { gt: existing.createdAt } } });
  return true;
}


export async function clientMessageId(id: unknown): Promise<string | undefined> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return undefined;
  const taken = await prisma.message.findUnique({ where: { id }, select: { id: true } }).catch(() => null);
  return taken ? undefined : id;
}

export async function addMessage(
  conversationId: string,
  data: MessageInput
): Promise<Message | null> {
  try {
    // Create message
    const message = await prisma.message.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        conversationId,
        role: data.role,
        content: data.content,
        parts: data.parts as object ?? null,
        metadata: data.metadata as object ?? {},
      },
    });

    // Update conversation's lastMessageAt (non-blocking)
    prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    }).catch(err => console.error('Error updating lastMessageAt:', err));

    return message;
  } catch (error) {
    console.error('Error adding message:', error);
    return null;
  }
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function clearMessages(conversationId: string): Promise<boolean> {
  try {
    await prisma.message.deleteMany({ where: { conversationId } });
    return true;
  } catch {
    return false;
  }
}

export async function updateMessage(
  id: string,
  data: { content?: string; parts?: unknown[]; metadata?: Record<string, unknown> }
): Promise<Message | null> {
  try {
    return await prisma.message.update({
      where: { id },
      data: {
        ...data,
        parts: data.parts as object ?? undefined,
        metadata: data.metadata as object ?? undefined,
        editedAt: new Date(),
      },
    });
  } catch {
    return null;
  }
}

// ============================================
// Artifact Operations
// ============================================

export async function createArtifact(data: {
  conversationId: string;
  messageId: string;
  userId: string;
  type?: string;
  title: string;
  content: string;
}): Promise<Artifact> {
  return prisma.artifact.create({
    data: {
      conversationId: data.conversationId,
      messageId: data.messageId,
      userId: data.userId,
      type: data.type || 'html',
      title: data.title,
      content: data.content,
    },
  });
}

export async function getArtifact(id: string): Promise<Artifact | null> {
  return prisma.artifact.findUnique({ where: { id } });
}

export async function getConversationArtifacts(conversationId: string): Promise<Artifact[]> {
  return prisma.artifact.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateArtifact(
  id: string,
  data: { title?: string; content?: string }
): Promise<Artifact | null> {
  try {
    return await prisma.artifact.update({
      where: { id },
      data,
    });
  } catch {
    return null;
  }
}

export async function deleteArtifact(id: string): Promise<boolean> {
  try {
    await prisma.artifact.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// MCP Connection Operations
// ============================================

export async function createMcpConnection(data: {
  userId: string;
  name: string;
  serverUrl: string;
  authType?: string;
  authCredentialsEncrypted?: string;
  /** The one agent this connection belongs to (shared/lib/agents.ts). */
  agent: string;
}): Promise<McpConnection> {
  return prisma.mcpConnection.create({
    data: {
      userId: data.userId,
      name: data.name,
      serverUrl: data.serverUrl,
      authType: data.authType || 'none',
      authCredentialsEncrypted: data.authCredentialsEncrypted,
      agent: data.agent,
    },
  });
}

export async function getMcpConnection(id: string): Promise<McpConnection | null> {
  return prisma.mcpConnection.findUnique({ where: { id } });
}

export async function getUserMcpConnections(userId: string, agent?: string): Promise<McpConnection[]> {
  return prisma.mcpConnection.findMany({
    where: { userId, ...(agent ? { agent } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateMcpConnection(
  id: string,
  data: Record<string, unknown>
): Promise<McpConnection | null> {
  try {
    return await prisma.mcpConnection.update({
      where: { id },
      data: data as Parameters<typeof prisma.mcpConnection.update>[0]['data'],
    });
  } catch {
    return null;
  }
}

// ============================================
// Memory File Operations
// ============================================

// Determine scope from path: /global/... → "global", everything else → "user"
function getMemoryScope(path: string): 'user' | 'global' {
  return path.startsWith('/global/') ? 'global' : 'user';
}

// Get a memory file - checks user-owned first, then global
export async function getMemoryFile(userId: string, path: string): Promise<MemoryFile | null> {
  const scope = getMemoryScope(path);
  if (scope === 'global') {
    // Global files: find by scope + path (any user could have created it)
    return prisma.memoryFile.findFirst({
      where: { scope: 'global', path },
    });
  }
  return prisma.memoryFile.findUnique({
    where: { userId_path: { userId, path } },
  });
}

// Get user's private memory files
export async function getUserMemoryFiles(userId: string): Promise<MemoryFile[]> {
  return prisma.memoryFile.findMany({
    where: { userId, scope: 'user' },
    orderBy: { updatedAt: 'desc' },
  });
}

// Get all global memory files (shared across users)
export async function getGlobalMemoryFiles(): Promise<MemoryFile[]> {
  return prisma.memoryFile.findMany({
    where: { scope: 'global' },
    orderBy: { updatedAt: 'desc' },
  });
}

// Get all memory files visible to a user (user + global)
export async function getAllVisibleMemoryFiles(userId: string): Promise<MemoryFile[]> {
  return prisma.memoryFile.findMany({
    where: {
      OR: [
        { userId, scope: 'user' },
        { scope: 'global' },
      ],
    },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function createMemoryFile(data: {
  userId: string;
  path: string;
  content: string;
}): Promise<MemoryFile> {
  const scope = getMemoryScope(data.path);
  return prisma.memoryFile.create({
    data: {
      userId: data.userId,
      path: data.path,
      content: data.content,
      scope,
    },
  });
}

export async function updateMemoryFileContent(
  userId: string,
  path: string,
  content: string
): Promise<MemoryFile | null> {
  try {
    const scope = getMemoryScope(path);
    if (scope === 'global') {
      // Global: find by scope+path, update regardless of who created it
      const file = await prisma.memoryFile.findFirst({
        where: { scope: 'global', path },
      });
      if (!file) return null;
      return await prisma.memoryFile.update({
        where: { id: file.id },
        data: { content },
      });
    }
    return await prisma.memoryFile.update({
      where: { userId_path: { userId, path } },
      data: { content },
    });
  } catch {
    return null;
  }
}

export async function deleteMemoryFile(userId: string, path: string): Promise<boolean> {
  try {
    const scope = getMemoryScope(path);
    if (scope === 'global') {
      const file = await prisma.memoryFile.findFirst({
        where: { scope: 'global', path },
      });
      if (!file) return false;
      await prisma.memoryFile.delete({ where: { id: file.id } });
      return true;
    }
    await prisma.memoryFile.delete({
      where: { userId_path: { userId, path } },
    });
    return true;
  } catch {
    return false;
  }
}

export async function renameMemoryFile(userId: string, oldPath: string, newPath: string): Promise<boolean> {
  try {
    const scope = getMemoryScope(oldPath);
    const newScope = getMemoryScope(newPath);
    if (scope === 'global') {
      const file = await prisma.memoryFile.findFirst({
        where: { scope: 'global', path: oldPath },
      });
      if (!file) return false;
      await prisma.memoryFile.update({
        where: { id: file.id },
        data: { path: newPath, scope: newScope },
      });
      return true;
    }
    await prisma.memoryFile.update({
      where: { userId_path: { userId, path: oldPath } },
      data: { path: newPath, scope: newScope },
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteAllMemoryFiles(userId: string, scope?: 'user' | 'global'): Promise<number> {
  if (scope === 'global') {
    const result = await prisma.memoryFile.deleteMany({ where: { scope: 'global' } });
    return result.count;
  }
  if (scope === 'user') {
    const result = await prisma.memoryFile.deleteMany({ where: { userId, scope: 'user' } });
    return result.count;
  }
  // Delete both user's private + all global
  const result = await prisma.memoryFile.deleteMany({
    where: { OR: [{ userId, scope: 'user' }, { scope: 'global' }] },
  });
  return result.count;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Convert message to UIMessage format for frontend
 * Handles all part types: text, reasoning, tool calls
 *
 * IMPORTANT: For reasoning parts, the AI SDK frontend expects { type: 'reasoning', text: '...' }
 * For tool parts, it expects { type: 'tool-<name>', toolCallId, toolName, input, output, state }
 */
export function toUIMessage(message: Message) {
  const storedParts = message.parts as Array<Record<string, unknown>> | null;
  const _metadata = message.metadata as Record<string, unknown> | null;

  // If no parts stored, create basic text part
  if (!storedParts || !Array.isArray(storedParts) || storedParts.length === 0) {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      parts: [{ type: 'text', text: message.content }],
      feedback: readFeedback(_metadata),
      editedAt: message.editedAt ?? null,
    };
  }

  // Process stored parts to ensure correct format for frontend
  const parts = storedParts.map((part) => {
    const partType = part.type as string;

    // Handle step-start parts (preserved from streaming for step interleaving)
    if (partType === 'step-start') {
      return { type: 'step-start' };
    }

    // Handle reasoning parts - frontend expects 'text' property
    if (partType === 'reasoning') {
      return {
        type: 'reasoning',
        text: part.text || part.reasoning || '',
      };
    }

    // Handle tool parts (type starts with "tool-")
    if (partType?.startsWith('tool-')) {
      return {
        type: partType,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input || part.args || {},
        output: part.output ?? part.result ?? undefined,
        state: part.state || 'output-available',
        // The chat saves each tool's timing so a reopened conversation still
        // shows what every round of tools cost; dropping them here threw that away.
        ...(typeof part.durationMs === 'number' ? { durationMs: part.durationMs } : {}),
        ...(typeof part.stepNumber === 'number' ? { stepNumber: part.stepNumber } : {}),
      };
    }

    // Handle text parts
    if (partType === 'text') {
      return {
        type: 'text',
        text: part.text || '',
      };
    }

    // Return as-is for unknown types (file-download, etc.)
    return part;
  });

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    parts,
    // Surface the stored rating so a thumbs-up survives a reload. The metadata
    // was read here and then dropped, which is why ratings appeared to save and
    // then silently reset.
    feedback: readFeedback(_metadata),
    editedAt: message.editedAt ?? null,
  };
}

/** 'positive' | 'negative' | null from the stored metadata blob. */
function readFeedback(metadata: Record<string, unknown> | null): 'positive' | 'negative' | null {
  const f = metadata?.feedback as { rating?: unknown } | undefined;
  const r = f?.rating;
  return r === 'positive' || r === 'negative' ? r : null;
}

/**
 * Convert conversation to API response format
 */
export function toConversationResponse(conversation: Conversation & { messages?: Message[] }) {
  const lastMessage = conversation.messages?.length
    ? conversation.messages[conversation.messages.length - 1]
    : null;

  return {
    id: conversation.id,
    title: conversation.title,
    isPinned: conversation.isPinned,
    isShared: conversation.isShared,
    model: conversation.model,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessage: lastMessage?.content.slice(0, 100) || null,
  };
}
