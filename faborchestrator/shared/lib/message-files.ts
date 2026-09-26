/**
 * The attachments on a chat message, in the shape `sendMessage({ files })` takes.
 *
 * Retry and Edit resend a question under its own id; the chat SDK rebuilds the
 * message from what is passed, so passing only the text silently dropped every
 * attachment and the model answered without the document it was asked about.
 * Both resends carry the original file parts through this helper.
 */
export type FilePart = { type: 'file'; mediaType: string; url: string; filename?: string };

export function fileParts(message: { parts?: unknown } | undefined | null): FilePart[] {
  const parts = Array.isArray(message?.parts) ? (message!.parts as Array<Record<string, unknown>>) : [];
  return parts
    .filter((p) => p?.type === 'file' && typeof p.url === 'string' && typeof p.mediaType === 'string')
    .map((p) => ({
      type: 'file' as const,
      mediaType: p.mediaType as string,
      url: p.url as string,
      ...(typeof p.filename === 'string' ? { filename: p.filename } : {}),
    }));
}

/**
 * A v4 UUID that works everywhere the chat runs. `crypto.randomUUID()` exists
 * only in a secure context (https or localhost); reached over plain http on an
 * internal address it is undefined and every send would throw. The fallback
 * builds the same format from crypto.getRandomValues, which has no such limit.
 */
export function newMessageId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
