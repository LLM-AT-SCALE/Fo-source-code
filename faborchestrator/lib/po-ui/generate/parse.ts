/**
 * RESPONSE PARSING — pulling the two fenced blocks out of a model response.
 *
 * Deliberately strict. A parser that guesses when the shape is wrong hides the
 * failure until much later, when the artifact is already on disk.
 */

export class ParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

const FENCE = /```([a-zA-Z]*)\r?\n([\s\S]*?)```/g;

export interface Block {
  lang: string;
  body: string;
}

export function fencedBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const m of text.matchAll(FENCE)) {
    out.push({ lang: (m[1] ?? "").toLowerCase(), body: (m[2] ?? "").trim() });
  }
  return out;
}

/** The first block of a given language, or the first block at all if unlabelled. */
export function blockOf(blocks: Block[], lang: string): string | undefined {
  return blocks.find((b) => b.lang === lang)?.body
      ?? blocks.find((b) => b.lang === "")?.body;
}

export interface Generated {
  settings: Record<string, unknown>;
  gapReport: string;
}

export function parseGeneration(text: string): Generated {
  const blocks = fencedBlocks(text);
  if (blocks.length === 0) {
    throw new ParseError(
      "the response contained no fenced code blocks — expected a ```json block " +
      "with the settings and a ```markdown block with the gap report",
      text,
    );
  }

  const jsonBody = blockOf(blocks, "json");
  if (jsonBody === undefined) {
    throw new ParseError(
      `no \`\`\`json block found (saw: ${blocks.map((b) => b.lang || "<unlabelled>").join(", ")})`,
      text,
    );
  }

  let settings: unknown;
  try {
    settings = JSON.parse(jsonBody);
  } catch (e) {
    throw new ParseError(
      `the json block is not valid JSON: ${(e as Error).message}`,
      jsonBody,
    );
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new ParseError("the json block is not a JSON object", jsonBody);
  }

  const gapReport =
    blocks.find((b) => b.lang === "markdown" || b.lang === "md")?.body
    ?? blocks.filter((b) => b !== blocks.find((x) => x.lang === "json"))[0]?.body
    ?? "";

  return { settings: settings as Record<string, unknown>, gapReport };
}

export function parseJsonBlock(text: string): unknown {
  const blocks = fencedBlocks(text);
  const body = blockOf(blocks, "json") ?? (blocks.length === 0 ? text.trim() : undefined);
  if (body === undefined) {
    throw new ParseError("no JSON found in the response", text);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new ParseError(`response is not valid JSON: ${(e as Error).message}`, body);
  }
}
