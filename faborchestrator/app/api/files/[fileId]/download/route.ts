import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { getAnthropicFilesClient, inferMimeType } from '@/modules/support-engineer/lib/anthropic-files';
import { contentDispositionAttachment } from '@/shared/lib/content-disposition';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { fileId } = await params;

  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return NextResponse.json({ error: 'Invalid file ID format' }, { status: 400 });
  }

  try {
    const client = getAnthropicFilesClient();

    // Get metadata for filename and mime type
    let filename = 'download';
    let mimeType = 'application/octet-stream';

    try {
      const metadata = await client.beta.files.retrieveMetadata(fileId);
      filename = metadata.filename || 'download';
      mimeType = metadata.mime_type || inferMimeType(filename);
    } catch {
      // If metadata fails, continue with defaults - download may still work
      console.warn('[Files] Could not fetch metadata for', fileId);
    }

    // Download the file content
    const response = await client.beta.files.download(fileId);

    // Get the response as an ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    const body = Buffer.from(arrayBuffer);

    const headers = new Headers({
      'Content-Type': mimeType,
      // Non-ASCII names (e.g. Tamil) must NOT go raw into the header: Node
      // rejects non-Latin-1 header values, which used to 500 this route.
      'Content-Disposition': contentDispositionAttachment(filename),
      'Content-Length': String(body.byteLength),
    });

    return new Response(body, { status: 200, headers });
  } catch (error: unknown) {
    console.error('[Files] Download error:', error);
    const status = (error as { status?: number })?.status;
    if (status === 404) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (status === 410) {
      return NextResponse.json({ error: 'File has expired. Files are only available for 30 days after creation.' }, { status: 410 });
    }
    // 404/410 above are precise and stay as they are. Everything else was
    // collapsed into one line with no record — relay the real cause instead.
    return handleApiError(error, req, { route: '/api/files/[fileId]/download' });
  }
}
