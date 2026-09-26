import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { mcpAccess } from '@/modules/mcp/lib/mcp-access';
import prisma from '@/shared/lib/db';
import { decrypt } from '@/shared/lib/encryption';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// POST /api/mcp/connections/[id]/discover - Discover available tools from MCP server
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const connection = await prisma.mcpConnection.findUnique({ where: { id } });

    if (!connection) {
      return NextResponse.json(
        { error: 'MCP connection not found' },
        { status: 404 }
      );
    }

    // Verify ownership
    if (connection.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to access this MCP connection' },
        { status: 403 }
      );
    }

    // Changing a connection needs the role's personal-MCP configuration right.
    if (!(await mcpAccess(user.id)).canEditPersonal) {
      return NextResponse.json(
        { error: 'Your role does not allow configuring MCP connections' },
        { status: 403 }
      );
    }

    if (connection.status !== 'connected') {
      return NextResponse.json(
        { error: 'Connection must be established before discovering tools' },
        { status: 400 }
      );
    }

    // Prepare headers for authentication
    // MCP servers require Accept header for both JSON and SSE (Server-Sent Events)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    if (connection.authCredentialsEncrypted) {
      try {
        const credentials = JSON.parse(decrypt(connection.authCredentialsEncrypted));

        if (connection.authType === 'api_key' && credentials.apiKey) {
          headers['Authorization'] = `Bearer ${credentials.apiKey}`;
        }
      } catch (decryptError) {
        console.error('Error decrypting credentials:', decryptError);
      }
    }

    // Helper function to parse SSE or JSON response
    const parseResponse = async (response: Response): Promise<unknown> => {
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        return response.json();
      }

      if (contentType.includes('text/event-stream')) {
        const text = await response.text();
        const lines = text.split('\n');
        let lastData: unknown = null;

        for (const line of lines) {
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

        if (lastData) return lastData;
        throw new Error('No valid JSON-RPC response in SSE stream');
      }

      return response.json();
    };

    try {
      // Add session ID to headers if available (required for stateful MCP servers)
      if (connection.sessionId) {
        headers['Mcp-Session-Id'] = connection.sessionId;
        console.log('[MCP Discover] Using session ID:', connection.sessionId);
      }

      // Send tools/list request via JSON-RPC
      const response = await fetch(connection.serverUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return NextResponse.json({
          success: false,
          error: `Server returned ${response.status}`,
        });
      }

      const result = await parseResponse(response) as { error?: { message?: string }; result?: { tools?: McpTool[] } };

      if (result.error) {
        return NextResponse.json({
          success: false,
          error: result.error.message || 'Failed to list tools',
        });
      }

      // Extract tools from response
      const tools: McpTool[] = result.result?.tools || [];

      // Store discovered tools with full schema for AI SDK conversion
      const toolsWithSchema = tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      }));

      await prisma.mcpConnection.update({
        where: { id },
        // Prisma Json column accepts the discovered tool list; cast is unavoidable.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { availableTools: toolsWithSchema as any },
      });

      return NextResponse.json({
        success: true,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      });
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : 'Discovery failed';

      return NextResponse.json({
        success: false,
        error: errorMessage,
      });
    }
  } catch (error) {
    console.error('Error discovering MCP tools:', error);
    return NextResponse.json(
      { error: 'Failed to discover MCP tools' },
      { status: 500 }
    );
  }
}
