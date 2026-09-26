/**
 * FabOrch Audit — structured logger.
 *
 * Emits one JSON line per event to stdout/stderr. In production
 * (Elastic Beanstalk) these lines are picked up by the EB log agent
 * and forwarded to CloudWatch without any additional configuration.
 */

import type {
  FabOrchErrorEnvelope,
  FabOrchErrorPriority,
  FabOrchErrorType,
} from './errors/faborch-errors';

// Type-only import above + a structural check here: faborch-errors → error-catalog-loader → logger
// would otherwise form a runtime import cycle.
function isFabOrchError(value: unknown): value is Error & { toEnvelope(): FabOrchErrorEnvelope } {
  return value instanceof Error && typeof (value as { toEnvelope?: unknown }).toEnvelope === 'function';
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  errorId?: string;
  type?: FabOrchErrorType;
  priority?: FabOrchErrorPriority;
  userId?: string;
  sessionId?: string;
  route?: string;
  method?: string;
  toolName?: string;
  parameter?: string;
  durationMs?: number;
  [key: string]: unknown;
}

interface LogRecord extends LogContext {
  ts: string;
  level: LogLevel;
  msg: string;
  app: string;
  stack?: string;
  cause?: unknown;
}

const APP_NAME = process.env.FABORCH_APP_NAME || 'faborch';

function emit(level: LogLevel, record: LogRecord) {
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function base(level: LogLevel, msg: string, ctx: LogContext = {}): LogRecord {
  return {
    ts: new Date().toISOString(),
    level,
    msg,
    app: APP_NAME,
    ...ctx,
  };
}

export const logger = {
  debug(msg: string, ctx?: LogContext) {
    emit('debug', base('debug', msg, ctx));
  },
  info(msg: string, ctx?: LogContext) {
    emit('info', base('info', msg, ctx));
  },
  warn(msg: string, ctx?: LogContext) {
    emit('warn', base('warn', msg, ctx));
  },
  error(msg: string, ctx?: LogContext) {
    emit('error', base('error', msg, ctx));
  },

  /**
   * Log a FabOrchError or any thrown value with full envelope details.
   * Adds the stack trace and originating cause when present.
   */
  fabOrchError(error: unknown, ctx: LogContext = {}) {
    if (isFabOrchError(error)) {
      const env: FabOrchErrorEnvelope = error.toEnvelope();
      const stack = (error as Error).stack;
      const cause = (error as { cause?: unknown }).cause;
      emit(
        'error',
        base('error', `[${env.type}] ${env.userMessage}`, {
          ...ctx,
          errorId: env.errorId,
          type: env.type,
          priority: env.priority,
          ...env.context,
          stack,
          cause: cause instanceof Error ? cause.message : cause,
        }) as LogRecord
      );
      return;
    }
    const err = error as Error;
    emit(
      'error',
      base('error', err?.message || 'Unhandled error', {
        ...ctx,
        stack: err?.stack,
      }) as LogRecord
    );
  },
};
