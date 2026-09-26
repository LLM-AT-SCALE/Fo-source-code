import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { getUserMemoryFiles, getGlobalMemoryFiles, deleteMemoryFile, deleteAllMemoryFiles } from '@/shared/lib/storage';

// GET /api/memory - List all memory files visible to the user (user + global)
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  const [userFiles, globalFiles] = await Promise.all([
    getUserMemoryFiles(user.id),
    getGlobalMemoryFiles(),
  ]);

  const formatFile = (f: { id: string; path: string; content: string; scope: string; createdAt: Date; updatedAt: Date }) => ({
    id: f.id,
    path: f.path,
    content: f.content,
    scope: f.scope,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  });

  return NextResponse.json({
    userFiles: userFiles.map(formatFile),
    globalFiles: globalFiles.map(formatFile),
  });
}

// DELETE /api/memory - Delete a memory file or all files
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  const body = await req.json();
  const { path, all, scope } = body as { path?: string; all?: boolean; scope?: 'user' | 'global' };

  if (all) {
    const count = await deleteAllMemoryFiles(user.id, scope);
    return NextResponse.json({ success: true, deleted: count });
  }

  if (!path) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  const deleted = await deleteMemoryFile(user.id, path);
  if (!deleted) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
