import { createAnthropic, forwardAnthropicContainerIdFromLastStep } from '@ai-sdk/anthropic';

export const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Create an Anthropic provider that injects container_upload blocks into the
 * Anthropic API request body via a custom fetch wrapper. Used for unsupported
 * file types (xlsx, docx, pptx, csv) that need code execution to process.
 */
export function createAnthropicWithContainerUploads(fileIds: string[]) {
  return createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    fetch: async (url, init) => {
      if (fileIds.length > 0 && init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body);
          if (Array.isArray(body.messages)) {
            // Find the last user message and inject container_upload blocks
            for (let i = body.messages.length - 1; i >= 0; i--) {
              if (body.messages[i].role === 'user' && Array.isArray(body.messages[i].content)) {
                for (const fileId of fileIds) {
                  body.messages[i].content.push({
                    type: 'container_upload',
                    file_id: fileId,
                  });
                }
                break;
              }
            }
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch {
          // If body parsing fails, pass through unchanged
        }
      }
      return fetch(url, init);
    },
  });
}

export { forwardAnthropicContainerIdFromLastStep };
