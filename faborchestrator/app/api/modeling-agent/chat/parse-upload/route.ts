import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { readUploadSheets } from '@/modules/master-data-load/lib/validation/template-check';
import { createStagedUpload } from '@/modules/master-data-load/lib/repo-cmf/validation';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Parse a plain (non-template) Excel upload into structured rows server-side so
 * the chat client can append the data to the conversation without shipping a
 * binary through the model. Also stages the raw bytes so generateExcel can
 * later append rows into THIS file (startFromStagingId).
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.user.id;

  let file: FormDataEntryValue | null;
  try {
    const form = await request.formData();
    file = form.get('file');
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Attach an .xlsx file in the 'file' field." }, { status: 400 });
  }
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (!file.name.toLowerCase().endsWith('.xlsx') && file.type !== XLSX_MIME) {
    return NextResponse.json(
      { error: `Only Excel (.xlsx) files are supported — "${file.name}" was rejected.` },
      { status: 400 }
    );
  }

  try {
    const bytes = await file.arrayBuffer();
    // Use the STREAMING reader (memory-safe on large workbooks), not the
    // full-load ExcelJS parse — a multi-MB upload through wb.xlsx.load OOMs the
    // instance. readUploadSheets streams rows and only falls back to the heavy
    // parser for unusual files.
    const parsed = await readUploadSheets(bytes);
    // Cap the per-sheet rows we echo back to the model — the model only needs to
    // SEE what's in the file, not every row. The full data is staged for load.
    const MAX_ECHO_ROWS = 50;
    const sheets = parsed.map((s) => ({
      objectType: s.objectType,
      headers: s.headers,
      rows: s.rows.slice(0, MAX_ECHO_ROWS),
      totalRows: s.rows.length,
    }));
    const staged = await createStagedUpload({
      userId,
      filename: file.name,
      bytes: Buffer.from(bytes),
      packageName: `upload_${file.name.replace(/\.xlsx$/i, '')}`,
    });
    return NextResponse.json({ filename: file.name, sheets, uploadStagingId: staged.id });
  } catch (err) {
    /*
     * "Could not read that file as an Excel workbook" was returned for every
     * failure — a password-protected file, an unsupported format, a truncated
     * upload and an out-of-memory parse all read the same, and "re-export it"
     * is useless advice for most of them. Relay what actually happened.
     */
    console.error('[modeling-agent/chat/parse-upload] failed', err);
    return handleApiError(err, request, { route: '/api/modeling-agent/chat/parse-upload' });
  }
}
