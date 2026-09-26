/**
 * MCP tool-key namespacing.
 *
 * Every MCP tool exposed to the model gets an AI SDK key of the form
 *
 *     mcp_<conn8>__<safeName>
 *
 * where `conn8` is the first 8 hex chars of the connection UUID (dashes
 * removed) and `safeName` is the MCP tool name with anything outside
 * `[A-Za-z0-9_]` replaced by `_`, capped at 50 chars. Two connections that
 * expose the same tool name (two FabInsight databases, two SEMI OPC servers)
 * therefore get DISTINCT keys instead of silently overwriting each other in
 * the tool map, and every persisted `tool-mcp_*` part names the connection it
 * came from.
 *
 * Anthropic caps tool names at 64 chars: `mcp_` (4) + 8 + `__` (2) + 50 = 64.
 *
 * This module is dependency-free on purpose: the display components
 * (client bundle) and the node:test suite import it without pulling in
 * prisma / storage through `lib/mcp-client.ts`.
 */

/** Namespaced form: captures `[conn8, toolName]`. */
export const MCP_TOOL_KEY_RE = /^mcp_([0-9a-f]{8})__(.+)$/;

/** Pre-namespacing form (`mcp_<toolName>`), kept so old persisted parts parse. */
const MCP_TOOL_KEY_LEGACY_RE = /^mcp_(.+)$/;

/**
 * Strips the `mcp_` prefix AND the optional `<conn8>__` segment — what a
 * display layer uses to get back to the plain tool name.
 */
export const MCP_TOOL_KEY_PREFIX_RE = /^mcp_(?:[0-9a-f]{8}__)?/;

const CONN_SHORT_LEN = 8;
const SAFE_NAME_MAX = 50;

/** First 8 hex chars of a connection UUID, dashes removed, lower-cased. */
export function mcpConnShort(connectionId: string): string {
  return connectionId.replace(/-/g, '').slice(0, CONN_SHORT_LEN).toLowerCase();
}

/** Build the namespaced AI SDK tool key for `toolName` on `connectionId`. */
export function mcpToolKey(connectionId: string, toolName: string): string {
  const safeName = toolName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, SAFE_NAME_MAX);
  return `mcp_${mcpConnShort(connectionId)}__${safeName}`;
}

/**
 * Parse a tool key back into its parts. Returns `connShort: ''` for a legacy
 * un-namespaced key, and `null` for anything that is not an MCP tool key.
 */
export function parseMcpToolKey(key: string): { connShort: string; toolName: string } | null {
  const namespaced = MCP_TOOL_KEY_RE.exec(key);
  if (namespaced) return { connShort: namespaced[1], toolName: namespaced[2] };
  const legacy = MCP_TOOL_KEY_LEGACY_RE.exec(key);
  if (legacy) return { connShort: '', toolName: legacy[1] };
  return null;
}

/** True for both the namespaced and the legacy key forms. */
export function isMcpToolKey(key: string): boolean {
  return MCP_TOOL_KEY_LEGACY_RE.test(key);
}

/**
 * Plain tool name for display: `mcp_1a2b3c4d__run_query` → `run_query`,
 * `mcp_run_query` → `run_query`. Non-MCP names pass through unchanged.
 */
export function stripMcpToolKey(key: string): string {
  return key.replace(MCP_TOOL_KEY_PREFIX_RE, '');
}

/**
 * Metadata stamped onto every successful MCP tool result as `_mcp`, so the
 * persisted `Message.parts` entry and the prompt-audit `tool_calls` row both
 * record which connection actually served the call.
 */
export interface McpResultMeta {
  connectionId: string;
  registryId: string | null;
  serverUrl: string;
  toolName: string;
}
