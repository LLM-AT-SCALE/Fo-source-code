/**
 * FabOrch Audit — REQ-01 centralized API error handler.
 *
 * Converts any thrown value into a normalized FabOrchError envelope and
 * a NextResponse with the right HTTP status. Wrap your route handlers
 * in withErrorHandling() so every code path emits the canonical
 * messages defined in the requirements doc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  FabOrchError,
  FabOrchErrorContext,
  FabOrchErrorType,
  isFabOrchError,
} from './faborch-errors';
import { logger } from '../logger';
import { recordError } from './error-audit';

export interface ApiErrorBody {
  error: {
    errorId: string;
    type: FabOrchErrorType;
    priority: 'HIGH' | 'MEDIUM';
    message: string;
  };
}

/**
 * Best-effort classification of any thrown value into one of the 10
 * REQ-01 types. Falls back to LAMBDA_MCP_CRASH (generic backend
 * failure) when nothing else matches.
 */
export function classifyError(error: unknown): FabOrchErrorType {
  if (isFabOrchError(error)) return error.type;

  if (error instanceof ZodError) return FabOrchErrorType.INVALID_PARAMETER;

  if (error instanceof Error) {
    const name = error.name;
    const msg = error.message || '';
    const lower = msg.toLowerCase();

    if (name === 'AbortError' || lower.includes('timeout') || lower.includes('timed out')) {
      return FabOrchErrorType.RESPONSE_TIMEOUT;
    }
    if (name === 'PrismaClientKnownRequestError' || name === 'PrismaClientUnknownRequestError') {
      // Prisma "record not found" code is P2025
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (error as any).code as string | undefined;
      if (code === 'P2025') return FabOrchErrorType.NO_ROWS_RETURNED;
      return FabOrchErrorType.SQL_CALL_FAILURE;
    }
    if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError') {
      return FabOrchErrorType.SQL_CALL_FAILURE;
    }
    if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('database')) {
      return FabOrchErrorType.SQL_CALL_FAILURE;
    }
    if (lower.includes('rate_limit') || lower.includes('rate limit')) {
      return FabOrchErrorType.LAMBDA_MCP_CRASH;
    }
    if (lower.includes('unauthorized') || lower.includes('session')) {
      return FabOrchErrorType.SESSION_TIMEOUT;
    }
  }

  return FabOrchErrorType.LAMBDA_MCP_CRASH;
}

/**
 * Convert any thrown value into a FabOrchError. If it already is one,
 * returns it as-is.
 */
function toFabOrchError(
  error: unknown,
  context: FabOrchErrorContext = {}
): FabOrchError {
  if (isFabOrchError(error)) return error;
  const type = classifyError(error);
  return new FabOrchError(type, { cause: error, context });
}

function deriveContext(request?: NextRequest, extra: FabOrchErrorContext = {}): FabOrchErrorContext {
  if (!request) return extra;
  return {
    ...extra,
    route: extra.route || new URL(request.url).pathname,
    method: extra.method || request.method,
  };
}

/**
 * Convert any thrown value into a NextResponse carrying the canonical
 * envelope. Logs the error structurally before responding.
 */
export function handleApiError(
  error: unknown,
  request?: NextRequest,
  contextOverrides: FabOrchErrorContext = {}
): NextResponse<ApiErrorBody> {
  const context = deriveContext(request, contextOverrides);
  const fabErr = toFabOrchError(error, context);
  logger.fabOrchError(fabErr);

  // REQ-03 — persist to error_audit_logs. Fire-and-forget; never let
  // audit-log failure break the user-facing request.
  recordError(fabErr, {
    userId: context.userId ?? null,
    route: context.route ?? null,
    method: context.method ?? null,
    requestContext: context.extra ?? null,
  }).catch(() => {});

  const body: ApiErrorBody = {
    error: {
      errorId: fabErr.errorId,
      type: fabErr.type,
      priority: fabErr.priority,
      message: fabErr.userMessage,
    },
  };
  return NextResponse.json(body, { status: fabErr.httpStatus });
}

