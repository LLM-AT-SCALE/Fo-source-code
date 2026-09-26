/**
 * Let the model choose the data probe for an MCP server.
 *
 * The health check's data stage needs one cheap, read-only tool call that
 * touches the server's database. The heuristic picker covers servers with a
 * `health_check` or a no-argument listing tool; for every other server the
 * model reads the tool list (names, descriptions, input schemas) and proposes
 * a few candidate calls with minimal arguments. Nothing the model proposes is
 * trusted on its own: the checker runs each candidate and keeps the first one
 * that returns data. Admins never type a tool or arguments by hand.
 */
import { generateObject } from 'ai';
import { z } from 'zod';

import { anthropic } from '@/shared/lib/anthropic';

export type ProbeCandidate = { tool: string; arguments: Record<string, unknown>; reason: string };

type ToolLike = { name: string; description?: string; inputSchema?: unknown };

const MODEL = () => process.env.MCP_HEALTH_PROBE_MODEL || 'claude-sonnet-5';
const MAX_TOOLS_IN_PROMPT = 60;
const MAX_SCHEMA_CHARS = 1200;

const CandidatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        tool: z.string().min(1).max(120),
        arguments: z.record(z.string(), z.unknown()).default({}),
        reason: z.string().max(300),
      })
    )
    .max(3),
});

function describeTools(tools: ToolLike[]): string {
  return tools
    .slice(0, MAX_TOOLS_IN_PROMPT)
    .map((t) => {
      let schema = '';
      try {
        schema = JSON.stringify(t.inputSchema ?? {});
      } catch {
        schema = '{}';
      }
      if (schema.length > MAX_SCHEMA_CHARS) schema = schema.slice(0, MAX_SCHEMA_CHARS) + '…';
      return `- ${t.name}: ${(t.description || '').replace(/\s+/g, ' ').slice(0, 300)}\n  inputSchema: ${schema}`;
    })
    .join('\n');
}

/**
 * Up to three candidate calls, best first. Tools in `exclude` (already tried
 * and failed) are not proposed again. Returns [] when the model finds nothing
 * safe or the call fails — the caller reports that honestly.
 */
export async function suggestProbeCandidates(
  server: { displayName: string; description?: string | null },
  tools: ToolLike[],
  exclude: string[] = []
): Promise<ProbeCandidate[]> {
  if (!tools.length) return [];
  const names = new Set(tools.map((t) => t.name));
  try {
    const { object } = await generateObject({
      model: anthropic(MODEL()),
      schema: CandidatesSchema,
      system:
        'You pick health-check probes for MCP servers that sit in front of manufacturing databases. ' +
        'A probe is ONE tool call that is read-only, cheap (a listing, a schema lookup, or a query limited to one row), ' +
        'needs no knowledge the tool list does not give you, and proves the database behind the server answers. ' +
        'Never propose anything that writes, loads, registers, deletes, creates, updates, or triggers a job. ' +
        'Arguments must satisfy the tool\'s inputSchema exactly; prefer the smallest valid values (limit 1, first page, empty filters). ' +
        'If a tool takes a table or view name, only use a name that appears in a tool description or enum; otherwise choose another tool. ' +
        'Return up to three candidates, best first, each with a one-sentence reason.',
      prompt:
        `Server: ${server.displayName}${server.description ? ` — ${server.description}` : ''}\n` +
        (exclude.length ? `Do not propose these tools (already tried, they failed): ${exclude.join(', ')}\n` : '') +
        `Tools:\n${describeTools(tools)}\n\nReturn the candidates as JSON.`,
    });
    return object.candidates
      .filter((c) => names.has(c.tool) && !exclude.includes(c.tool))
      .map((c) => ({ tool: c.tool, arguments: c.arguments ?? {}, reason: c.reason }));
  } catch (e) {
    console.warn('[mcp-health] probe suggestion failed:', e instanceof Error ? e.message : e);
    return [];
  }
}
