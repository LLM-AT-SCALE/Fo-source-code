/**
 * MCP (Model Context Protocol) Client
 * Handles connection to MCP servers and tool execution
 */

import { getMcpConnection } from '@/shared/lib/storage';
import { decrypt } from '@/shared/lib/encryption';
import { tool } from 'ai';
import { z } from 'zod';
import {
  FabOrchError,
  isFabOrchError,
} from '@/shared/lib/errors/faborch-errors';
import { logger } from '@/shared/lib/logger';
import { isLambdaInvokeUrl, functionNameFromUrl, invokeLambdaRpc } from './mcp-lambda';
import { captureError, summarize, type ErrorDetail } from '@/shared/lib/errors/error-detail';
import { readErrorPayload } from '@/shared/lib/errors/mcp-error-payload';
import { mcpToolKey, type McpResultMeta } from './mcp-tool-key';

// Re-exported so callers that already import from mcp-client keep one import.
// The implementations live in the dependency-free ./mcp-tool-key so display
// components and unit tests can use them without loading prisma.
export {
  mcpToolKey,
  parseMcpToolKey,
  isMcpToolKey,
  stripMcpToolKey,
  mcpConnShort,
  MCP_TOOL_KEY_RE,
  MCP_TOOL_KEY_PREFIX_RE,
  type McpResultMeta,
} from './mcp-tool-key';

/** Per-connection metadata handed to `convertMcpToolsToAiTools` so each
 *  tool's `execute` can stamp its result without a DB round-trip per call. */
export interface McpConnectionMeta {
  registryId?: string | null;
  serverUrl: string;
  name: string;
}

/** One entry per connection in `loadActiveMcpToolsWithDescriptions().groups`. */
export interface McpToolGroup {
  connectionId: string;
  name: string;
  serverUrl: string;
  registryId: string | null;
  toolKeys: string[];
}

const NEWLINE = String.fromCharCode(10);

/**
 * Capture a failed tool call in full and package it as the tool result the AI
 * SDK expects.
 *
 * Three things happen here, and the order matters:
 *
 *  1. `captureError` reads the REAL error object — name, message, driver codes,
 *     cause chain, stack, plus anything else it happens to carry. Nothing is
 *     matched against a list of known failures, so an error this codebase has
 *     never seen is recorded just as completely as a familiar one.
 *  2. The whole record is persisted to `error_audit_logs` as the row's
 *     request_context, so the action button can read back exactly what
 *     happened rather than a summary of it.
 *  3. `detail` rides along on the result. The chat route lifts it off the step
 *     and streams it to the client, so the UI renders the failure from data
 *     instead of from whatever the model chose to say about it.
 */
function toolFailure(
  fabErr: FabOrchError,
  ctx: {
    connector?: string;
    connectorUrl?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    httpStatus?: number;
    responseBody?: string;
    rpcCode?: number;
    rpcMessage?: string;
    userId?: string | null;
    method?: string;
  },
): McpToolResult {
  const detail = captureError({
    errorId: fabErr.errorId,
    // Prefer the original thrown value; the FabOrchError wrapper carries the
    // catalog line, the cause carries what actually went wrong.
    cause: (fabErr as { cause?: unknown }).cause ?? fabErr,
    type: fabErr.type,
    priority: fabErr.priority as 'HIGH' | 'MEDIUM',
    connector: ctx.connector,
    connectorUrl: ctx.connectorUrl,
    toolName: ctx.toolName,
    toolArgs: ctx.toolArgs,
    httpStatus: ctx.httpStatus,
    responseBody: ctx.responseBody,
    rpcCode: ctx.rpcCode,
    rpcMessage: ctx.rpcMessage,
  });

  // Persist the FULL record. request_context is jsonb, so the detail page can
  // render every field that was actually observed.
  import('@/shared/lib/errors/error-audit')
    .then((m) =>
      m.recordError(fabErr, {
        userId: ctx.userId ?? null,
        route: ctx.connectorUrl ?? null,
        method: ctx.method ?? 'POST',
        technicalMessage: detail.message ?? null,
        stackPreview: detail.stack ?? null,
        requestContext: detail as unknown as Record<string, unknown>,
      }),
    )
    .catch(() => {});

  return {
    content: [{ type: 'text', text: `${summarize(detail)} (errorId=${detail.errorId})` }],
    isError: true,
    detail,
  };
}

/**
 * Detect a failure an MCP server reported INSIDE a successful response.
 *
 * The MCP spec lets a server flag a failed call with `isError: true`, but many
 * servers answer a broken call with a perfectly normal JSON-RPC *result* whose
 * text is an error payload. Nothing in the transport says anything is wrong, so
 * these used to be treated as DATA and handed to the model, which turned a
 * precise database error into "I couldn't retrieve that information."
 *
 * Parsing lives in ./errors/mcp-error-payload, which reads the reason out of
 * the payload by SHAPE (never by message text) and discards the bookkeeping
 * keys around it, so the user reads the reason rather than the envelope.
 *
 * Returns the reason when the result is really a failure, else null.
 */
function errorInsideResult(result: McpToolResult | undefined): string | null {
  if (!result) return null;

  // Spec-compliant servers say so outright.
  if (result.isError) {
    const t = result.content?.find((c) => c.type === 'text')?.text;
    return t?.trim() || 'The tool reported an error.';
  }

  const text = result.content
    ?.filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(NEWLINE)
    .trim();
  if (!text) return null;

  // A readable reason for any top-level error key (string, object, `true`),
  // or null when the key is a success marker (None / null / false / 0 / "").
  return readErrorPayload(text);
}
/** Decrypt the Bearer token stored on a connection (api_key auth), if any. */
function bearerFromConnection(conn: { authType?: string; authCredentialsEncrypted?: string | null }): string | undefined {
  if (conn.authType === 'api_key' && conn.authCredentialsEncrypted) {
    try {
      return JSON.parse(decrypt(conn.authCredentialsEncrypted)).apiKey as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  /**
   * Structured diagnosis, present only when `isError` is true. Carried up to
   * the chat route, which streams it to the client so the failure is rendered
   * from data rather than from the model's prose.
   */
  detail?: ErrorDetail;
}

/**
 * Get authentication headers for an MCP connection
 */
async function getAuthHeaders(connectionId: string): Promise<{ headers: Record<string, string>; sessionId?: string | null }> {
  const connection = await getMcpConnection(connectionId);

  if (!connection) {
    throw new Error('MCP connection not found');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };

  // Add session ID for stateful MCP servers
  if (connection.sessionId) {
    headers['Mcp-Session-Id'] = connection.sessionId;
  }

  if (connection.authCredentialsEncrypted) {
    try {
      const credentials = JSON.parse(decrypt(connection.authCredentialsEncrypted));

      if (connection.authType === 'api_key' && credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`;
      }
      // OAuth would require token refresh flow - simplified here
    } catch (error) {
      console.error('Error decrypting MCP credentials:', error);
    }
  }

  return { headers, sessionId: connection.sessionId };
}

/**
 * Parse SSE (Server-Sent Events) response stream
 * Returns the final JSON-RPC result from the event stream
 */
async function parseSSEResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';

  // If it's regular JSON, parse directly
  if (contentType.includes('application/json')) {
    return response.json();
  }

  // If it's SSE, parse the event stream
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const lines = text.split('\n');

    let lastData: unknown = null;

    for (const line of lines) {
      // SSE format: "data: {json}"
      if (line.startsWith('data:')) {
        const jsonStr = line.slice(5).trim();
        if (jsonStr && jsonStr !== '[DONE]') {
          try {
            lastData = JSON.parse(jsonStr);
          } catch {
            // Skip non-JSON data lines
          }
        }
      }
    }

    if (lastData) {
      return lastData;
    }

    throw new Error('No valid JSON-RPC response found in SSE stream');
  }

  // Fallback: try to parse as JSON anyway
  return response.json();
}

/**
 * Re-initialize MCP connection to get a new session ID
 */
async function refreshMcpSession(connectionId: string): Promise<string | null> {
  const connection = await getMcpConnection(connectionId);
  if (!connection) return null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };

  // Add auth if configured
  if (connection.authCredentialsEncrypted) {
    try {
      const credentials = JSON.parse(decrypt(connection.authCredentialsEncrypted));
      if (connection.authType === 'api_key' && credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`;
      }
    } catch (error) {
      console.error('[MCP] Error decrypting credentials for session refresh:', error);
    }
  }

  try {
    console.log('[MCP] Refreshing session for connection:', connectionId);
    const response = await fetch(connection.serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'llmatscale-ai', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error('[MCP] Session refresh failed:', response.status);
      return null;
    }

    // Get new session ID from headers
    const newSessionId = response.headers.get('mcp-session-id') || response.headers.get('x-session-id');

    if (newSessionId) {
      // Update session ID in database
      const { updateMcpConnection } = await import('@/shared/lib/storage');
      await updateMcpConnection(connectionId, { sessionId: newSessionId });
      console.log('[MCP] Session refreshed successfully:', newSessionId);
      return newSessionId;
    }

    return null;
  } catch (error) {
    console.error('[MCP] Session refresh error:', error);
    return null;
  }
}

/**
 * Check if error indicates session expiry
 */
function isSessionExpiredError(error: string): boolean {
  const sessionErrors = [
    'missing session',
    'invalid session',
    'session expired',
    'session not found',
    'unauthorized',
    'session id',
  ];
  const lowerError = error.toLowerCase();
  return sessionErrors.some(se => lowerError.includes(se));
}

/**
 * Execute a tool on an MCP server with automatic session refresh
 */
export async function executeMcpTool(
  connectionId: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
  userId: string | null = null
): Promise<McpToolResult> {
  const connection = await getMcpConnection(connectionId);

  if (!connection) {
    throw new Error('MCP connection not found');
  }

  if (connection.status !== 'connected') {
    throw new Error('MCP connection is not active');
  }

  // On-the-fly servers (lambda-invoke://) are called via the IAM Lambda API, not
  // HTTP — no session/SSE. Short-circuit to that path.
  if (isLambdaInvokeUrl(connection.serverUrl)) {
    try {
      const bearer = bearerFromConnection(connection);
      const rpc = await invokeLambdaRpc(functionNameFromUrl(connection.serverUrl), bearer, {
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: toolArguments },
      }) as { error?: { message?: string; code?: number }; result?: McpToolResult };

      if (rpc.error) {
        const code = rpc.error.code;
        const errMsg = rpc.error.message || 'MCP tool execution failed';
        const fabErr = code === -32601
          ? FabOrchError.unlistedStoredProc(toolName, { route: connection.serverUrl })
          : code === -32602
          ? FabOrchError.invalidParameter(toolName, undefined, new Error(errMsg))
          : FabOrchError.lambdaMcpCrash(new Error(errMsg), { toolName, route: connection.serverUrl, extra: { jsonRpcCode: code } });
        logger.fabOrchError(fabErr);
        return toolFailure(fabErr, {
          connector: connection.name,
          connectorUrl: connection.serverUrl,
          toolName,
          toolArgs: toolArguments,
          rpcCode: code,
          rpcMessage: rpc.error.message,
          userId,
          method: 'LAMBDA',
        });
      }
      // A server can report failure inside a 200/OK result — catch that too,
      // otherwise the model receives an error as if it were data.
      const embedded = errorInsideResult(rpc.result);
      if (embedded) {
        const fabErr = FabOrchError.sqlCallFailure(new Error(embedded), {
          toolName, route: connection.serverUrl,
        });
        logger.fabOrchError(fabErr);
        return toolFailure(fabErr, {
          connector: connection.name,
          connectorUrl: connection.serverUrl,
          toolName,
          toolArgs: toolArguments,
          responseBody: embedded,
          userId,
          method: 'LAMBDA',
        });
      }
      return rpc.result || { content: [{ type: 'text', text: 'No result returned' }] };
    } catch (error) {
      const fabErr = FabOrchError.lambdaMcpCrash(error, { toolName, route: connection.serverUrl });
      logger.fabOrchError(fabErr);
      return toolFailure(fabErr, {
        connector: connection.name,
        connectorUrl: connection.serverUrl,
        toolName,
        toolArgs: toolArguments,
        userId,
        method: 'LAMBDA',
      });
    }
  }

  // Try to execute tool, with automatic session refresh on expiry
  const executeWithRetry = async (retryCount: number = 0): Promise<McpToolResult> => {
    const { headers } = await getAuthHeaders(connectionId);

    try {
      const response = await fetch(connection.serverUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: toolArguments,
          },
        }),
        signal: AbortSignal.timeout(30000), // 30 second timeout for tool execution
      });

      if (!response.ok) {
        const errorText = await response.text();

        // Check if session expired and retry once
        if (retryCount === 0 && isSessionExpiredError(errorText)) {
          console.log('[MCP] Session expired, attempting refresh...');
          const newSessionId = await refreshMcpSession(connectionId);
          if (newSessionId) {
            return executeWithRetry(1);
          }
        }

        // Classify into REQ-01 categories for structured logging.
        const fabErr = response.status >= 500
          ? FabOrchError.lambdaMcpCrash(new Error(`HTTP ${response.status}: ${errorText}`), {
              toolName, route: connection.serverUrl, extra: { httpStatus: response.status },
            })
          : response.status === 404
          ? FabOrchError.unlistedStoredProc(toolName, { route: connection.serverUrl })
          : response.status === 400
          ? FabOrchError.invalidParameter(toolName, undefined, new Error(errorText), {
              httpStatus: response.status,
            })
          : FabOrchError.lambdaMcpCrash(new Error(`HTTP ${response.status}: ${errorText}`), {
              toolName, route: connection.serverUrl, extra: { httpStatus: response.status },
            });
        logger.fabOrchError(fabErr);

        return toolFailure(fabErr, {
          connector: connection.name,
          connectorUrl: connection.serverUrl,
          toolName,
          toolArgs: toolArguments,
          httpStatus: response.status,
          // The body the endpoint actually returned — often the only place the
          // real reason appears (a gateway HTML page, a driver dump, a JSON
          // error object). Previously read and then discarded.
          responseBody: errorText,
          userId,
        });
      }

      // Parse response (handles both JSON and SSE)
      const result = await parseSSEResponse(response) as { error?: { message?: string; code?: number }; result?: McpToolResult };

      if (result.error) {
        // Check if session expired and retry once
        if (retryCount === 0 && isSessionExpiredError(result.error.message || '')) {
          console.log('[MCP] Session expired (from response), attempting refresh...');
          const newSessionId = await refreshMcpSession(connectionId);
          if (newSessionId) {
            return executeWithRetry(1);
          }
        }

        const errMsg = result.error.message || 'MCP tool execution failed';
        const code = result.error.code;
        // JSON-RPC -32601 = Method not found, -32602 = Invalid params
        const fabErr = code === -32601
          ? FabOrchError.unlistedStoredProc(toolName, { route: connection.serverUrl })
          : code === -32602
          ? FabOrchError.invalidParameter(toolName, undefined, new Error(errMsg))
          : FabOrchError.lambdaMcpCrash(new Error(errMsg), {
              toolName, route: connection.serverUrl, extra: { jsonRpcCode: code },
            });
        logger.fabOrchError(fabErr);

        return toolFailure(fabErr, {
          connector: connection.name,
          connectorUrl: connection.serverUrl,
          toolName,
          toolArgs: toolArguments,
          rpcCode: code,
          rpcMessage: result.error.message,
          userId,
        });
      }

      const embeddedHttp = errorInsideResult(result.result);
      if (embeddedHttp) {
        const fabErr = FabOrchError.sqlCallFailure(new Error(embeddedHttp), {
          toolName, route: connection.serverUrl,
        });
        logger.fabOrchError(fabErr);
        return toolFailure(fabErr, {
          connector: connection.name,
          connectorUrl: connection.serverUrl,
          toolName,
          toolArgs: toolArguments,
          responseBody: embeddedHttp,
          userId,
        });
      }
      return result.result || { content: [{ type: 'text', text: 'No result returned' }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if session expired and retry once
      if (retryCount === 0 && isSessionExpiredError(errorMessage)) {
        console.log('[MCP] Session expired (from exception), attempting refresh...');
        const newSessionId = await refreshMcpSession(connectionId);
        if (newSessionId) {
          return executeWithRetry(1);
        }
      }

      const errName = error instanceof Error ? error.name : '';
      const fabErr = errName === 'AbortError' || errName === 'TimeoutError'
        ? FabOrchError.responseTimeout(error, {
            toolName, route: connection.serverUrl,
          })
        : FabOrchError.lambdaMcpCrash(error, {
            toolName, route: connection.serverUrl,
          });
      logger.fabOrchError(fabErr);

      return toolFailure(fabErr, {
        connector: connection.name,
        connectorUrl: connection.serverUrl,
        toolName,
        toolArgs: toolArguments,
        userId,
      });
    }
  };

  return executeWithRetry(0);
}

/**
 * Why a selected connector produced no tools.
 *
 * These are not transport errors — nothing threw. The connector is simply not
 * usable, and the old code returned an empty array with a console.log. The
 * model then answered the question with NO tools: confidently, from nothing,
 * while the user believed their connector was in play. That is the most
 * misleading failure in the product, and it was completely invisible.
 */
export interface UnusableConnector {
  connectionId: string;
  name: string;
  /** Plain-language reason, naming what an admin would need to change. */
  reason: string;
}

/**
 * Get tools from an MCP connection.
 *
 * `unusable` (when supplied) collects the reason a connector yielded nothing,
 * so the caller can tell the user instead of silently answering without it.
 */
export async function getMcpTools(
  connectionId: string,
  unusable?: UnusableConnector[],
): Promise<McpTool[]> {
  console.log(`[MCP] getMcpTools called for connectionId: ${connectionId}`);
  const connection = await getMcpConnection(connectionId);

  if (!connection) {
    console.log(`[MCP] Connection ${connectionId} NOT FOUND in database`);
    unusable?.push({
      connectionId,
      name: 'Unknown connector',
      reason:
        'This connector no longer exists — it was removed, or the assignment that granted it was revoked.',
    });
    return [];
  }
  return toolsFromConnection(connection, unusable);
}

/** The cached tool list on an already-loaded connection row (no DB access). */
function toolsFromConnection(
  connection: NonNullable<Awaited<ReturnType<typeof getMcpConnection>>>,
  unusable?: UnusableConnector[],
): McpTool[] {
  const connectionId = connection.id;

  console.log(`[MCP] Found connection: name='${connection.name}', status='${connection.status}', isActive=${connection.isActive}`);

  if (connection.status !== 'connected') {
    console.log(`[MCP] Connection '${connection.name}' status is '${connection.status}', not 'connected'. Tools will not be loaded.`);
    unusable?.push({
      connectionId,
      name: connection.name,
      // The last real failure is far more useful than the status word.
      reason: connection.status === 'error'
        ? `Could not connect to this connector: ${connection.lastError ?? 'no detail was recorded'}. It is retried automatically every 2 minutes.`
        : connection.status === 'disconnected'
          ? 'This connector is switched off (disconnected). Connect it again from Settings → MCP Connections to use it.'
          : `This connector is not connected (status "${connection.status}")${connection.lastError ? `. Last error: ${connection.lastError}` : ''}.`,
    });
    return [];
  }

  // Return cached tools
  const availableTools = connection.availableTools as unknown;
  console.log(`[MCP] availableTools type: ${typeof availableTools}, isArray: ${Array.isArray(availableTools)}`);

  if (Array.isArray(availableTools)) {
    console.log(`[MCP] availableTools has ${availableTools.length} items`);
    if (availableTools.length > 0) {
      console.log(`[MCP] First tool:`, JSON.stringify(availableTools[0]));
      console.log(`[MCP] Loaded ${availableTools.length} tools from connection '${connection.name}'`);
      return availableTools as McpTool[];
    }
  }

  console.log(`[MCP] Connection '${connection.name}' has no discovered tools. Run tool discovery first.`);
  unusable?.push({
    connectionId,
    name: connection.name,
    reason: connection.lastError
      // Up, but listing its tools failed — say how (saved by mcp-connect).
      ? `This connector is connected but has no tools, so it could not answer. ${connection.lastError}`
      : 'This connector is connected but the server reported no tools, so it could not answer anything.',
  });
  return [];
}

/**
 * Convert MCP tools to AI SDK tool format
 * Creates Vercel AI SDK compatible tools from MCP tool definitions
 */
export function convertMcpToolsToAiTools(
  mcpTools: McpTool[],
  connectionId: string,
  userId: string | null = null,
  meta?: McpConnectionMeta
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiTools: Record<string, any> = {};
  // The connector's display name, so a failure can say WHICH connected
  // system failed rather than just "a tool".
  const connectorName = meta?.name;

  for (const mcpTool of mcpTools) {
    // Build Zod schema from MCP tool input schema
    const zodSchema = buildZodSchema(mcpTool.inputSchema);

    // Namespaced per connection (`mcp_<conn8>__<name>`) so two connections
    // exposing the same tool name cannot overwrite each other in the tool map.
    const toolKey = mcpToolKey(connectionId, mcpTool.name);

    // Stamped on every successful result — see McpResultMeta.
    const resultMeta: McpResultMeta = {
      connectionId,
      registryId: meta?.registryId ?? null,
      serverUrl: meta?.serverUrl ?? '',
      toolName: mcpTool.name,
    };

    console.log(`[MCP] Converting tool: ${mcpTool.name} -> ${toolKey}`);

    aiTools[toolKey] = tool({
      description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
      inputSchema: zodSchema,
      execute: async (args) => {
        console.log(`[MCP] ========== TOOL EXECUTION START ==========`);
        console.log(`[MCP] Tool: ${mcpTool.name}`);
        console.log(`[MCP] Args:`, JSON.stringify(args, null, 2));

        try {
          const result = await executeMcpTool(connectionId, mcpTool.name, args, userId);
          console.log(`[MCP] Raw MCP result:`, JSON.stringify(result, null, 2));

          // Convert MCP result to string for AI consumption
          const textContent = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');

          if (result.isError) {
            console.error(`[MCP] Tool ${mcpTool.name} returned error:`, textContent);
            console.log(`[MCP] ========== TOOL EXECUTION END (ERROR) ==========`);
            // `errorDetail` rides along so the chat route can stream the
            // structured diagnosis to the client. The model reads `error`.
            return {
              error: textContent || 'MCP tool execution failed',
              isError: true,
              ...(result.detail ? { errorDetail: result.detail } : {}),
            };
          }

          console.log(`[MCP] Tool ${mcpTool.name} result preview:`, textContent.substring(0, 500));
          console.log(`[MCP] ========== TOOL EXECUTION END (SUCCESS) ==========`);

          // Return the result in a format the AI can process
          // Try to parse as JSON first, otherwise return as text
          let payload: unknown;
          try {
            payload = JSON.parse(textContent);
          } catch {
            payload = { data: textContent, success: true };
          }
          return annotateMcpResult(payload, resultMeta);
        } catch (error) {
          const fabErr = isFabOrchError(error)
            ? error
            : (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
              ? FabOrchError.responseTimeout(error, { toolName: mcpTool.name })
              : FabOrchError.lambdaMcpCrash(error, { toolName: mcpTool.name }));
          logger.fabOrchError(fabErr);
          console.error(`[MCP] Tool ${mcpTool.name} execution failed:`, fabErr.userMessage);
          console.log(`[MCP] ========== TOOL EXECUTION END (EXCEPTION) ==========`);
          // This is the path for failures BEFORE the transport ran — a missing
          // or inactive connection, a decrypt failure. `toolFailure` records it
          // in full, same as every other failure site.
          const failed = toolFailure(fabErr, {
            connector: connectorName,
            toolName: mcpTool.name,
            toolArgs: args as Record<string, unknown>,
            userId,
          });
          return {
            error: failed.content[0]?.text ?? `${fabErr.userMessage} (errorId=${fabErr.errorId})`,
            isError: true,
            type: fabErr.type,
            ...(failed.detail ? { errorDetail: failed.detail } : {}),
          };
        }
      },
    });
  }

  return aiTools;
}

/**
 * Attach `_mcp` provenance to a successful tool result.
 *
 * A plain object keeps its shape and gains one extra `_mcp` property, so
 * everything that reads `file_id` / `content` / `rows` off the result (chat
 * route file extraction, prompt-audit, the tool card) is unaffected. Anything
 * else (array, string, number, null) cannot carry a property, so it is
 * wrapped as `{ result, _mcp }`; nothing downstream depends on those raw
 * shapes (the tool card's table detection unwraps a single-key object).
 */
export function annotateMcpResult(payload: unknown, meta: McpResultMeta): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), _mcp: meta };
  }
  return { result: payload, _mcp: meta };
}

/**
 * Build a Zod schema from MCP tool input schema
 */
function buildZodSchema(inputSchema?: McpTool['inputSchema']): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!inputSchema || !inputSchema.properties) {
    return z.object({});
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const required = inputSchema.required || [];

  for (const [key, propSchema] of Object.entries(inputSchema.properties)) {
    const prop = propSchema as { type?: string; description?: string; enum?: string[] };
    let zodType: z.ZodTypeAny;

    switch (prop.type) {
      case 'string':
        zodType = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
        break;
      case 'number':
      case 'integer':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.unknown());
        break;
      case 'object':
        zodType = z.record(z.string(), z.unknown());
        break;
      default:
        zodType = z.unknown();
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

/**
 * Load all active MCP tools for a conversation
 */
export async function loadActiveMcpTools(
  activeMcpIds: string[],
  userId: string | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  const result = await loadActiveMcpToolsWithDescriptions(activeMcpIds, userId);
  return result.tools;
}

/**
 * Load all active MCP tools with their descriptions for system prompt
 * Returns both the AI SDK tools and descriptions for the LLM
 */
export async function loadActiveMcpToolsWithDescriptions(
  activeMcpIds: string[],
  userId: string | null = null
): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  descriptions: { name: string; description: string }[];
  groups: McpToolGroup[];
  /**
   * Connectors the user selected that produced NO tools, and why.
   *
   * Without this the model answers with fewer tools than the user believes it
   * has — or none at all — and nothing anywhere says so.
   */
  unusable: UnusableConnector[];
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: Record<string, any> = {};
  const allDescriptions: { name: string; description: string }[] = [];
  const groups: McpToolGroup[] = [];
  const unusable: UnusableConnector[] = [];

  console.log(`[MCP] loadActiveMcpToolsWithDescriptions called with ${activeMcpIds.length} connection IDs:`, activeMcpIds);

  if (!activeMcpIds || activeMcpIds.length === 0) {
    console.log('[MCP] No active MCP IDs provided, returning empty tools');
    return { tools: allTools, descriptions: allDescriptions, groups, unusable };
  }

  for (const connectionId of activeMcpIds) {
    console.log(`[MCP] Processing connection: ${connectionId}`);
    try {
      // One DB read per connection: the row supplies both the cached tool list
      // and the metadata every tool result is stamped with.
      const connection = await getMcpConnection(connectionId);
      if (!connection) {
        console.log(`[MCP] Connection ${connectionId} NOT FOUND in database`);
        unusable.push({
          connectionId,
          name: 'Unknown connector',
          reason:
            'This connector no longer exists — it was removed, or the assignment that granted it was revoked.',
        });
        continue;
      }
      const mcpTools = toolsFromConnection(connection, unusable);
      console.log(`[MCP] getMcpTools returned ${mcpTools.length} tools for ${connectionId}`);

      if (mcpTools.length > 0) {
        const meta: McpConnectionMeta = {
          registryId: connection.registryId ?? null,
          serverUrl: connection.serverUrl,
          name: connection.name,
        };
        const aiTools = convertMcpToolsToAiTools(mcpTools, connectionId, userId, meta);
        const toolKeys = Object.keys(aiTools);
        console.log(`[MCP] Converted to AI SDK tools:`, toolKeys);
        for (const key of toolKeys) {
          if (allTools[key]) {
            // Only possible if the same connection id is listed twice, or two
            // UUIDs share their first 8 hex chars AND a tool name.
            console.warn(`[MCP] Tool key collision on ${key}; keeping the first definition`);
            continue;
          }
          allTools[key] = aiTools[key];
        }

        // Collect descriptions for the system prompt, under the namespaced key
        // the model must actually call.
        for (const mcpTool of mcpTools) {
          allDescriptions.push({
            name: mcpToolKey(connectionId, mcpTool.name),
            description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
          });
        }

        groups.push({
          connectionId,
          name: connection.name,
          serverUrl: connection.serverUrl,
          registryId: connection.registryId ?? null,
          toolKeys,
        });
      }
    } catch (error) {
      // A connector that threw while loading is unusable for this turn, and
      // the user is entitled to know which one and why.
      console.error(`[MCP] Error loading MCP tools for ${connectionId}:`, error);
      unusable.push({
        connectionId,
        name: 'Connector',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(`[MCP] Total MCP tools loaded: ${Object.keys(allTools).length}`);
  console.log(`[MCP] Tool descriptions for prompt: ${allDescriptions.length}`);
  return { tools: allTools, descriptions: allDescriptions, groups, unusable };
}
