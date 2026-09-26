/**
 * Context Window Management
 *
 * Two-phase trimming to keep conversations within the Anthropic API's
 * 200K token context window:
 *   Phase 1 — Shrink bloated tool results (code execution, web fetch HTML)
 *   Phase 2 — Remove oldest message groups until total fits under budget
 */

// Types from Vercel AI SDK (ModelMessage union)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelMessage = { role: string; content: any; providerOptions?: any };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONTEXT_WINDOW_TOKENS = 200_000;
const MAX_OUTPUT_TOKENS = 65_536;
const SAFETY_BUFFER_TOKENS = 4_000;

/** Max characters allowed in a single tool-result output value */
const TOOL_RESULT_CHAR_LIMIT = 12_000;
const TOOL_RESULT_HEAD_CHARS = 4_000;
const TOOL_RESULT_TAIL_CHARS = 2_000;

export interface ContextWindowOptions {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  safetyBufferTokens?: number;
  keepFirstUserMessage?: boolean;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 characters per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a single model message (all content types). */
function estimateMessageTokens(msg: ModelMessage): number {
  const content = msg.content;
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content));

  let tokens = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text':
        tokens += estimateTokens(part.text ?? part.value ?? '');
        break;
      case 'reasoning':
        tokens += estimateTokens(part.text ?? '');
        break;
      case 'tool-call':
        tokens += estimateTokens(part.toolName ?? '');
        tokens += estimateTokens(
          typeof part.input === 'string'
            ? part.input
            : JSON.stringify(part.input ?? {}),
        );
        break;
      case 'tool-result':
        tokens += estimateToolResultTokens(part.output);
        break;
      case 'image':
      case 'file':
        // Images/files use a fixed budget — the actual data is base64 or a URL
        tokens += 1000;
        break;
      default:
        tokens += estimateTokens(JSON.stringify(part));
    }
  }
  return tokens;
}

function estimateToolResultTokens(output: unknown): number {
  if (output == null) return 0;
  if (typeof output === 'string') return estimateTokens(output);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = output as any;
  switch (out.type) {
    case 'text':
    case 'error-text':
      return estimateTokens(out.value ?? '');
    case 'json':
    case 'error-json':
      return estimateTokens(JSON.stringify(out.value ?? {}));
    case 'content':
      if (Array.isArray(out.value)) {
        let t = 0;
        for (const v of out.value) {
          if (v.type === 'text') t += estimateTokens(v.text ?? '');
          else t += estimateTokens(JSON.stringify(v));
        }
        return t;
      }
      return estimateTokens(JSON.stringify(out.value ?? ''));
    default:
      return estimateTokens(JSON.stringify(output));
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Trim bloated tool results
// ---------------------------------------------------------------------------

function truncateString(value: string, limit: number, head: number, tail: number): string {
  if (value.length <= limit) return value;
  return (
    value.slice(0, head) +
    `\n\n[...truncated ${value.length - head - tail} characters...]\n\n` +
    value.slice(-tail)
  );
}

function trimToolResultOutput(output: unknown): unknown {
  if (output == null) return output;
  if (typeof output === 'string') {
    return truncateString(output, TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = output as any;
  switch (out.type) {
    case 'text':
    case 'error-text':
      if (typeof out.value === 'string' && out.value.length > TOOL_RESULT_CHAR_LIMIT) {
        return {
          ...out,
          value: truncateString(out.value, TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS),
        };
      }
      return out;
    case 'json':
    case 'error-json': {
      const serialized = JSON.stringify(out.value ?? {});
      if (serialized.length > TOOL_RESULT_CHAR_LIMIT) {
        return {
          ...out,
          type: out.type === 'json' ? 'text' : 'error-text',
          value: truncateString(serialized, TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS),
        };
      }
      return out;
    }
    case 'content':
      if (Array.isArray(out.value)) {
        return {
          ...out,
          value: out.value.map((v: { type: string; text?: string }) => {
            if (v.type === 'text' && typeof v.text === 'string' && v.text.length > TOOL_RESULT_CHAR_LIMIT) {
              return {
                ...v,
                text: truncateString(v.text, TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS),
              };
            }
            return v;
          }),
        };
      }
      return out;
    default:
      return out;
  }
}

/** Phase 1: Return a new array with oversized tool results trimmed. */
function trimToolResults(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((part: { type?: string; output?: unknown }) => {
      if (part.type === 'tool-result' && part.output != null) {
        const trimmed = trimToolResultOutput(part.output);
        if (trimmed !== part.output) {
          changed = true;
          return { ...part, output: trimmed };
        }
      }
      return part;
    });

    return changed ? { ...msg, content: newContent } : msg;
  });
}

// ---------------------------------------------------------------------------
// Phase 1.5 — Ensure tool_use / tool_result pairing
// ---------------------------------------------------------------------------

/**
 * Scan messages for tool-call blocks in assistant messages that lack a
 * corresponding tool-result in the immediately following tool/user message.
 *
 * This happens when conversations are reloaded from the DB: the onFinish
 * handler stores both tool call (input) and tool result (output) as combined
 * parts inside a single assistant message row. When convertToModelMessages()
 * reconstructs model messages, it may create tool-call blocks without
 * matching tool-result messages.
 *
 * Fix: For any unpaired tool-call, synthesize a tool-result message.
 */
function ensureToolResultPairing(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;

  const result: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    // Only check assistant messages with array content
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    // Collect tool-call IDs from this assistant message
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCallIds: Array<{ toolCallId: string; toolName: string; args: any }> = [];
    for (const part of msg.content) {
      if (part?.type === 'tool-call' && part.toolCallId) {
        toolCallIds.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName || 'unknown',
          args: part.args ?? part.input ?? {},
        });
      }
    }

    if (toolCallIds.length === 0) continue;

    // Check if the NEXT message already has matching tool-results
    const nextMsg = messages[i + 1];
    const existingResultIds = new Set<string>();
    if (nextMsg && (nextMsg.role === 'tool' || nextMsg.role === 'user') && Array.isArray(nextMsg.content)) {
      for (const part of nextMsg.content) {
        if (part?.type === 'tool-result' && part.toolCallId) {
          existingResultIds.add(part.toolCallId);
        }
      }
    }

    // Find unpaired tool-call IDs
    const unpaired = toolCallIds.filter((tc) => !existingResultIds.has(tc.toolCallId));

    if (unpaired.length === 0) continue;

    // Synthesize a tool-result message for unpaired calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResultParts: any[] = unpaired.map((tc) => ({
      type: 'tool-result',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result: { type: 'text', value: '[Tool result from previous session]' },
    }));

    // Insert a synthetic tool message right after the assistant message
    result.push({
      role: 'tool',
      content: toolResultParts,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 2 — Group-based truncation
// ---------------------------------------------------------------------------

interface MessageGroup {
  startIndex: number;
  endIndex: number; // inclusive
  tokens: number;
}

/**
 * Group messages by user-message boundaries.
 * Each group starts with a 'user' message and includes all subsequent
 * assistant/tool messages until the next user message. This keeps
 * tool-call / tool-result pairs together and maintains role alternation.
 */
function identifyMessageGroups(messages: ModelMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' || msg.role === 'system') {
      if (currentGroup != null) {
        currentGroup.endIndex = i - 1;
        groups.push(currentGroup);
      }
      currentGroup = { startIndex: i, endIndex: i, tokens: 0 };
    } else if (currentGroup == null) {
      // Assistant/tool message before any user message — start a group
      currentGroup = { startIndex: i, endIndex: i, tokens: 0 };
    }
    if (currentGroup) {
      currentGroup.tokens += estimateMessageTokens(msg);
      currentGroup.endIndex = i;
    }
  }
  if (currentGroup != null) {
    groups.push(currentGroup);
  }
  return groups;
}

/** Phase 2: Drop oldest message groups until total fits within tokenBudget. */
function truncateMessages(
  messages: ModelMessage[],
  tokenBudget: number,
  keepFirstUserMessage = false,
): ModelMessage[] {
  const groups = identifyMessageGroups(messages);
  if (groups.length === 0) return messages;

  const totalTokens = groups.reduce((sum, g) => sum + g.tokens, 0);
  if (totalTokens <= tokenBudget) return messages;

  // Always keep the last group (current exchange)
  let keptTokens = groups[groups.length - 1].tokens;
  let firstKeptGroupIndex = groups.length - 1;

  // Optionally keep the first group (original context)
  const firstGroupKept = keepFirstUserMessage && groups.length > 2;
  if (firstGroupKept) {
    keptTokens += groups[0].tokens;
  }

  // Walk backwards from second-to-last group, adding groups as budget allows
  for (let i = groups.length - 2; i >= (firstGroupKept ? 1 : 0); i--) {
    if (keptTokens + groups[i].tokens <= tokenBudget) {
      keptTokens += groups[i].tokens;
      firstKeptGroupIndex = i;
    } else {
      break; // Once we can't fit one, stop (groups are chronological)
    }
  }

  // Build the resulting message array
  const result: ModelMessage[] = [];

  // Add first group if kept separately
  if (firstGroupKept && firstKeptGroupIndex > 0) {
    for (let i = groups[0].startIndex; i <= groups[0].endIndex; i++) {
      result.push(messages[i]);
    }
  }

  // Add truncation indicator
  const droppedGroups = firstGroupKept
    ? firstKeptGroupIndex - 1
    : firstKeptGroupIndex;
  if (droppedGroups > 0) {
    result.push({
      role: 'user',
      content: `[Note: ${droppedGroups} earlier message group(s) were omitted to fit within the context window. The conversation continues below.]`,
    });
    // Need an assistant ack to maintain role alternation
    result.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'Understood, continuing from the available context.' }],
    });
  }

  // Add kept groups from firstKeptGroupIndex onward
  for (let i = firstKeptGroupIndex; i < groups.length; i++) {
    const g = groups[i];
    for (let j = g.startIndex; j <= g.endIndex; j++) {
      result.push(messages[j]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fit messages into the Anthropic context window.
 *
 * 1. Trims oversized tool results (code execution output, web fetch HTML)
 * 2. Removes oldest message groups until total fits under the token budget
 */
export function fitMessagesToContextWindow(
  messages: ModelMessage[],
  systemPrompt: string,
  options?: ContextWindowOptions,
): ModelMessage[] {
  const contextWindow = options?.contextWindowTokens ?? CONTEXT_WINDOW_TOKENS;
  const maxOutput = options?.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const safetyBuffer = options?.safetyBufferTokens ?? SAFETY_BUFFER_TOKENS;
  const keepFirst = options?.keepFirstUserMessage ?? false;

  const systemPromptTokens = estimateTokens(systemPrompt);
  const tokenBudget = contextWindow - maxOutput - safetyBuffer - systemPromptTokens;

  console.log(`[ContextWindow] Budget calculation: ${contextWindow} - ${maxOutput} - ${safetyBuffer} - ${systemPromptTokens} (system) = ${tokenBudget} tokens for messages`);

  // Phase 1: Trim bloated tool results
  const trimmed = trimToolResults(messages);

  // Phase 1.5: Ensure every tool_use has a matching tool_result
  const paired = ensureToolResultPairing(trimmed);
  const afterPhase1Tokens = paired.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  console.log(`[ContextWindow] After phase 1 (tool trimming + pairing): ~${afterPhase1Tokens} tokens across ${paired.length} messages`);

  if (afterPhase1Tokens <= tokenBudget) {
    console.log(`[ContextWindow] Messages fit within budget, no truncation needed`);
    return paired;
  }

  // Phase 2: Remove oldest message groups
  console.log(`[ContextWindow] Messages exceed budget by ~${afterPhase1Tokens - tokenBudget} tokens, truncating...`);
  const truncated = truncateMessages(paired, tokenBudget, keepFirst);

  // Final safety: ensure truncation didn't break any tool pairs
  const finalMessages = ensureToolResultPairing(truncated);
  const afterPhase2Tokens = finalMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  console.log(`[ContextWindow] After phase 2 (truncation): ~${afterPhase2Tokens} tokens across ${finalMessages.length} messages`);

  return finalMessages;
}
