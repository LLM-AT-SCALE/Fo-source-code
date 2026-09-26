/**
 * The agents a user can work in. Every MCP connection — admin-assigned or
 * personal — belongs to exactly one agent, and an agent lists only its own.
 *
 * Conversations carry an older vocabulary (`chat`, `modeling`, `backend`);
 * `agentKeyFrom` maps either form to the canonical key.
 */
export const AGENT_KEYS = ['support-engineer', 'fabinsight', 'master-data-load', 'coding-agent'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_LABELS: Record<AgentKey, string> = {
  'support-engineer': 'AI Support Engineer',
  fabinsight: 'FabInsight',
  'master-data-load': 'Master Data Load Agent',
  'coding-agent': 'Coding Agent',
};

/** Where each agent's conversations are stored (`conversations.agent`). */
export const CONVERSATION_AGENT: Record<AgentKey, string> = {
  'support-engineer': 'chat',
  fabinsight: 'fabinsight',
  'master-data-load': 'modeling',
  'coding-agent': 'backend',
};

const FROM_CONVERSATION: Record<string, AgentKey> = { chat: 'support-engineer', fabinsight: 'fabinsight', modeling: 'master-data-load', backend: 'coding-agent' };

export function isAgentKey(v: unknown): v is AgentKey {
  return typeof v === 'string' && (AGENT_KEYS as readonly string[]).includes(v);
}

/** Canonical key from an agent key or a conversation agent; unknown → the chat agent. */
export function agentKeyFrom(v: unknown): AgentKey {
  if (isAgentKey(v)) return v;
  if (typeof v === 'string' && FROM_CONVERSATION[v]) return FROM_CONVERSATION[v];
  return 'support-engineer';
}
