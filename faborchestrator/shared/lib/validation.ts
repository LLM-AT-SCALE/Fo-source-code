/**
 * Zod validation schemas for API request bodies
 * Provides type-safe validation for all API endpoints
 */

import { z } from 'zod';
import { FabOrchError } from './errors/faborch-errors';

// ============================================
// Auth Schemas
// ============================================

export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be less than 128 characters')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  );

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: PasswordSchema,
});

// ============================================
// User Settings Schemas
// ============================================

// ============================================
// Conversation Schemas
// ============================================

// ============================================
// Message Schemas
// ============================================

export const MessageFeedbackSchema = z.object({
  messageId: z.string().uuid('Invalid message ID'),
  // `null` clears a rating. Without it a misclick was permanent: the UI offers
  // a toggle, so the API has to accept the un-set.
  feedback: z.enum(['positive', 'negative']).nullable(),
  comment: z.string().max(1000).optional(),
});

// ============================================
// MCP Connection Schemas
// ============================================

// ============================================
// Chat Request Schema
// ============================================

export const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    /** The browser's message id — kept so Delete/Edit work before a reload. */
    id: z.string().max(100).optional(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().optional(),
    parts: z.array(z.unknown()).optional(),
  })).min(1),
  model: z.string().max(100).optional(),
  enableReasoning: z.boolean().optional(),
  conversationId: z.string().uuid().optional().nullable(),
  webSearch: z.boolean().optional(),
  activeMcpIds: z.array(z.string().uuid()).optional(),
  /** The client can render ask_user as clickable choices (the full chat does; cockpit does not). */
  interactiveChoices: z.boolean().optional(),
  /** Which agent this turn belongs to (agent key or conversation agent); decides which MCP connections apply. */
  agent: z.string().max(40).optional(),
});

// ============================================
// Validation Helper
// ============================================

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: z.ZodIssue[];
}

/**
 * Validate data against a Zod schema
 */
export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, errors: result.error.issues };
}

/**
 * Format Zod errors for API response
 */
export function formatValidationErrors(errors: z.ZodIssue[]): string {
  return errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

/**
 * Validate or throw the canonical INVALID_PARAMETER FabOrchError.
 * Use this in routes wrapped with withErrorHandling so validation
 * failures get the REQ-01 envelope automatically.
 */
export function validateOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  // NOTE: was a lazy `require('./errors/faborch-errors')` "to avoid circular
  // references". Under the Turbopack build that require resolved to a module
  // object WITHOUT `FabOrchError`, so every validation failure crashed with
  // "Cannot read properties of undefined (reading 'invalidParameter')" and was
  // reported to the user as a LAMBDA_MCP_CRASH ("backend service temporarily
  // unavailable"). There is no cycle between this module and faborch-errors, so
  // a static import is safe and correct.
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const firstIssue = result.error.issues[0];
  throw FabOrchError.invalidParameter(
    firstIssue?.path.join('.') || 'request',
    undefined,
    result.error,
    { issues: result.error.issues }
  );
}
