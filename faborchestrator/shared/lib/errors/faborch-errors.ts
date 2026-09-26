/**
 * FabOrch Audit — REQ-01 canonical error catalog.
 *
 * Runtime source of truth is the `error_catalog` table in RDS, read
 * via `error-catalog-loader.ts`. The frozen `FABORCH_ERROR_CATALOG`
 * (re-exported from `error-catalog-defaults.ts`) is the emergency
 * fallback used when the DB read fails or before first refresh.
 *
 * The defaults live in their own leaf module so the loader and this
 * file don't form a circular import — see error-catalog-defaults.ts
 * for the back-story.
 */

import { getErrorEntry } from './error-catalog-loader';
import {
  FABORCH_ERROR_CATALOG,
  FabOrchErrorPriority,
  FabOrchErrorType,
  ROW_CAP_LIMIT,
} from './error-catalog-defaults';

// Re-export so the rest of the codebase can keep importing from
// `./faborch-errors` unchanged.
export { FABORCH_ERROR_CATALOG, FabOrchErrorPriority, FabOrchErrorType, ROW_CAP_LIMIT };

export interface FabOrchErrorContext {
  route?: string;
  method?: string;
  userId?: string;
  sessionId?: string;
  parameter?: string;
  toolName?: string;
  validOptions?: ReadonlyArray<string>;
  extra?: Record<string, unknown>;
}

export interface FabOrchErrorEnvelope {
  errorId: string;
  type: FabOrchErrorType;
  priority: FabOrchErrorPriority;
  userMessage: string;
  httpStatus: number;
  context?: FabOrchErrorContext;
}

function generateErrorId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class FabOrchError extends Error {
  readonly errorId: string;
  readonly type: FabOrchErrorType;
  readonly priority: FabOrchErrorPriority;
  readonly userMessage: string;
  readonly httpStatus: number;
  readonly context?: FabOrchErrorContext;

  constructor(
    type: FabOrchErrorType,
    options: {
      cause?: unknown;
      context?: FabOrchErrorContext;
      messageOverride?: string;
    } = {}
  ) {
    // Read from the runtime catalog loader. Source of truth at runtime
    // is the `error_catalog` table in RDS; FABORCH_ERROR_CATALOG above
    // is now ONLY the emergency fallback used when the DB read fails.
    // The loader-vs-this-file is a circular import, but it's safe
    // because both sides only USE the cross-module bindings inside
    // function bodies (runtime), never at module init time.
    const entry = getErrorEntry(type);
    super(options.messageOverride ?? entry.userMessage);
    this.name = 'FabOrchError';
    this.errorId = generateErrorId();
    this.type = type;
    this.priority = entry.priority;
    this.userMessage = options.messageOverride ?? entry.userMessage;
    this.httpStatus = entry.httpStatus;
    this.context = options.context;
    if (options.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = options.cause;
    }
  }

  toEnvelope(): FabOrchErrorEnvelope {
    return {
      errorId: this.errorId,
      type: this.type,
      priority: this.priority,
      userMessage: this.userMessage,
      httpStatus: this.httpStatus,
      context: this.context,
    };
  }

  static sqlCallFailure(cause?: unknown, context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.SQL_CALL_FAILURE, { cause, context });
  }
  static responseTimeout(cause?: unknown, context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.RESPONSE_TIMEOUT, { cause, context });
  }
  static noRowsReturned(context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.NO_ROWS_RETURNED, { context });
  }
  static missingFilter(context?: FabOrchErrorContext, customQuestion?: string) {
    return new FabOrchError(FabOrchErrorType.MISSING_FILTER, {
      context,
      messageOverride: customQuestion,
    });
  }
  static invalidParameter(
    parameter: string,
    validOptions?: ReadonlyArray<string>,
    cause?: unknown,
    extra?: Record<string, unknown>
  ) {
    return new FabOrchError(FabOrchErrorType.INVALID_PARAMETER, {
      cause,
      context: { parameter, validOptions, extra },
    });
  }
  static ddlDmlRejected(cause?: unknown, context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.DDL_DML_REJECTED, { cause, context });
  }
  static lambdaMcpCrash(cause?: unknown, context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.LAMBDA_MCP_CRASH, { cause, context });
  }
  static sessionTimeout(context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.SESSION_TIMEOUT, { context });
  }
  static rowCapExceeded(context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.ROW_CAP_EXCEEDED, { context });
  }
  static unlistedStoredProc(toolName: string, context?: FabOrchErrorContext) {
    return new FabOrchError(FabOrchErrorType.UNLISTED_STORED_PROC, {
      context: { ...context, toolName },
    });
  }
}

export function isFabOrchError(value: unknown): value is FabOrchError {
  return value instanceof FabOrchError;
}
