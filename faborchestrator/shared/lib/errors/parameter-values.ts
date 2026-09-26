/**
 * FabOrch Audit — REQ-01 list_parameter_values implementation.
 *
 * The requirements doc says invalid-parameter errors should "Return valid
 * options via list_parameter_values()". This module is the FabOrch
 * implementation: a registry that, given a parameter name, returns its
 * known-valid set.
 */

export const ALLOWED_MODELS: ReadonlyArray<string> = Object.freeze([
  'claude-sonnet-5',   // FabOrchestrator 1
  'claude-opus-5',     // FabOrchestrator 2
  'claude-fable-5',    // FabOrchestrator 3
  'claude-fable-5-1',  // FabOrchestrator 4
]);

const ALLOWED_THEMES: ReadonlyArray<string> = Object.freeze([
  'light',
  'dark',
  'system',
]);

const ALLOWED_MESSAGE_ROLES: ReadonlyArray<string> = Object.freeze([
  'user',
  'assistant',
  'tool',
]);

export const ALLOWED_USER_STATUSES: ReadonlyArray<string> = Object.freeze([
  'ACTIVE',
  'INVITED',
  'SUSPENDED',
  'DELETED',
]);

export const ALLOWED_MCP_AUTH_TYPES: ReadonlyArray<string> = Object.freeze([
  'none',
  'api_key',
  'oauth',
]);

const ALLOWED_MCP_STATUSES: ReadonlyArray<string> = Object.freeze([
  'connected',
  'disconnected',
  'error',
]);

const ALLOWED_MESSAGE_DENSITIES: ReadonlyArray<string> = Object.freeze([
  'compact',
  'comfortable',
  'spacious',
]);

const ALLOWED_FEEDBACK_VALUES: ReadonlyArray<string> = Object.freeze([
  'positive',
  'negative',
]);

const STATIC_REGISTRY: Record<string, ReadonlyArray<string>> = {
  model: ALLOWED_MODELS,
  modelId: ALLOWED_MODELS,
  theme: ALLOWED_THEMES,
  role: ALLOWED_MESSAGE_ROLES,
  authType: ALLOWED_MCP_AUTH_TYPES,
  status: ALLOWED_MCP_STATUSES,
  messageDensity: ALLOWED_MESSAGE_DENSITIES,
  feedback: ALLOWED_FEEDBACK_VALUES,
};

type ListParameterValuesResult = {
  parameter: string;
  validOptions: ReadonlyArray<string>;
};

/**
 * Synchronous lookup for parameters with statically-known valid sets.
 * Returns null for parameters that are not registered (caller should
 * fall back to the async resolver if dynamic lookup is appropriate).
 */
export function listParameterValuesSync(
  parameter: string
): ListParameterValuesResult | null {
  const validOptions = STATIC_REGISTRY[parameter];
  if (!validOptions) return null;
  return { parameter, validOptions };
}
