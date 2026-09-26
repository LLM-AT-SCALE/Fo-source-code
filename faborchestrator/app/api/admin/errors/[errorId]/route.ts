/**
 * GET /api/admin/errors/[errorId]
 *
 * The destination of the "View error details" button in the Fab chat.
 *
 * Returns ONE error_audit_logs row, read back from the database. Nothing here
 * re-derives or re-words what happened: the row's `request_context` holds the
 * record captured at failure time (lib/errors/error-detail.ts), and this route
 * hands it over as stored. Whatever the runtime actually observed is what the
 * admin sees — including for failure modes nobody anticipated.
 *
 * `errorId` accepts either identifier, because the two halves of the product
 * show different ones: chat shows users the UUID (`error_uuid`), while the
 * audit table's own key is the human `ERR-YYYYMMDD-NNNN` (`error_id`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ errorId: string }> },
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { errorId } = await params;
    if (!errorId) throw FabOrchError.missingFilter({ parameter: 'errorId' }, 'An error id is required.');

    const rows = (await prisma.$queryRawUnsafe(
      `SELECT l.id,
              l.error_id,
              l.error_uuid,
              l.error_type,
              l.user_id,
              u.name  AS user_name,
              u.email AS user_email,
              l.datetime,
              l.user_message,
              l.technical_message,
              l.priority,
              l.status,
              l.resolved_by,
              ru.name AS resolved_by_name,
              l.resolved_at,
              l.resolution_note,
              l.route,
              l.http_method,
              l.http_status,
              l.stack_preview,
              l.request_context,
              l.created_at
         FROM "error_audit_logs" l
         LEFT JOIN "users" u  ON u.id  = l.user_id
         LEFT JOIN "users" ru ON ru.id = l.resolved_by
        WHERE l.error_uuid = $1 OR l.error_id = $1
        ORDER BY l.datetime DESC
        LIMIT 1`,
      errorId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any[];

    const r = rows[0];
    if (!r) {
      return NextResponse.json(
        {
          error: {
            type: 'NOT_FOUND',
            message:
              'No error record matches that id. It may have been purged by the 90-day retention sweep, or the id may be mistyped.',
          },
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      id: r.id,
      errorId: r.error_id,
      errorUuid: r.error_uuid,
      errorType: r.error_type,
      priority: r.priority,
      status: r.status,
      datetime: r.datetime,
      createdAt: r.created_at,

      user: r.user_id ? { id: r.user_id, name: r.user_name, email: r.user_email } : null,

      /** The calm catalog line the user originally saw. */
      userMessage: r.user_message,
      /** The real underlying error text. */
      technicalMessage: r.technical_message,
      stackPreview: r.stack_preview,

      route: r.route,
      httpMethod: r.http_method,
      httpStatus: r.http_status,

      /**
       * The full capture. Everything the runtime observed — driver codes, the
       * cause chain, the response body, the tool and its arguments, plus any
       * properties the error carried that we never named. Rendered as-is.
       */
      detail: r.request_context ?? null,

      resolution: {
        resolvedBy: r.resolved_by,
        resolvedByName: r.resolved_by_name,
        resolvedAt: r.resolved_at,
        note: r.resolution_note,
      },
    });
  } catch (error) {
    return handleApiError(error, req, { route: '/api/admin/errors/[errorId]' });
  }
}
