import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { getStagedUpload } from '@/modules/master-data-load/lib/repo-cmf/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Download a generated, staged master-data file by its stagingId. Auth-gated
 * and scoped to the owner (getStagedUpload enforces userId ownership).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.user.id;

  const { id } = await params;
  const staged = await getStagedUpload(id, userId);
  if (!staged) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const safeName = staged.filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return new Response(new Uint8Array(staged.bytes), {
    headers: {
      'Content-Type': XLSX_CT,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(staged.bytes.length),
    },
  });
}
