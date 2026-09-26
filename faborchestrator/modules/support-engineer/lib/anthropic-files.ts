import Anthropic from '@anthropic-ai/sdk';

export { inferMimeType } from '@/shared/lib/file-utils';

let client: Anthropic | null = null;

export function getAnthropicFilesClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
