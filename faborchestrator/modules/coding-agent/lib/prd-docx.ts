/**
 * THE PRD AS A WORD DOCUMENT.
 *
 * The PRD is the artefact an engineer forwards, comments on and takes into a
 * review meeting. The standalone offered it as HTML — "opens in a browser or
 * Word" — which is true enough to read and useless to comment on: Word opens it
 * as a web page, tracked changes and comments do not behave, and forwarding it
 * to a client means sending something that says `.html` in the file name.
 *
 * So: a real `.docx`. Built with the `docx` package rather than hand-rolled
 * OOXML — the parts of a Word file that matter here (numbering definitions,
 * table grids, style ids) are exactly the parts that are fiddly to get right by
 * hand, and a malformed one fails at the reader's end, in front of a client.
 *
 * WHAT THIS CONVERTER COVERS is what the PRD generator actually emits, measured
 * from a real document rather than guessed: h1–h3, paragraphs, `-` bullets,
 * numbered lists, block quotes, GitHub-style tables, and inline `**bold**`,
 * `*italic*` and `` `code` ``. Anything else passes through as plain text rather
 * than being dropped, because a PRD that silently loses a line is worse than one
 * that renders it unstyled.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/** Split a line into runs, honouring `**bold**`, `*italic*` and `` `code` ``. */
function runsOf(text: string, opts: { bold?: boolean; italics?: boolean } = {}): TextRun[] {
  const runs: TextRun[] = [];
  /* One pass, alternating between the delimiters, so `**a** and `b`` does not
     need three nested passes that each have to re-escape the others' output. */
  const re = /(\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) runs.push(new TextRun({ text: text.slice(last, i), ...opts }));
    const tok = m[0];
    if (tok.startsWith("**")) {
      runs.push(new TextRun({ text: tok.slice(2, -2), ...opts, bold: true }));
    } else if (tok.startsWith("`")) {
      /* Monospace and shaded, so a CMF path or a message name is legible as a
         literal rather than reading as prose. */
      runs.push(new TextRun({
        text: tok.slice(1, -1),
        ...opts,
        font: "Consolas",
        size: 19,
        shading: { type: ShadingType.CLEAR, fill: "F1F3F5" },
      }));
    } else {
      runs.push(new TextRun({ text: tok.slice(1, -1), ...opts, italics: true }));
    }
    last = i + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...opts }));
  return runs.length ? runs : [new TextRun({ text, ...opts })];
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
] as const;

/** `| a | b |` → cells, with the `|---|` rule dropped. */
const cellsOf = (line: string): string[] =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

const isRule = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line);

function tableFrom(rows: string[]): Table {
  const grid = rows.filter((r) => !isRule(r)).map(cellsOf);
  const width = Math.max(...grid.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: grid.map((cells, r) =>
      new TableRow({
        tableHeader: r === 0,
        children: Array.from({ length: width }, (_, c) =>
          new TableCell({
            shading: r === 0
              ? { type: ShadingType.CLEAR, fill: "F1F3F5" }
              : undefined,
            children: [new Paragraph({
              spacing: { before: 40, after: 40 },
              children: runsOf(cells[c] ?? "", r === 0 ? { bold: true } : {}),
            })],
          })),
      })),
  });
}

export function prdToDocx(markdown: string, title: string): Promise<Buffer> {
  const body: Array<Paragraph | Table> = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) continue;

    /*
     * A FENCED BLOCK IS THE SCREEN OUTLINE, AND IT IS DRAWN WITH BOX CHARACTERS.
     *
     * The PRD's "Rough outline" is an ASCII sketch of the page — grids, action
     * bar, column names — inside a ``` fence. Rendered as ordinary prose it is
     * unreadable: proportional type makes every rule a different length, so the
     * box falls apart. Without this branch the fence markers also came through
     * as two literal "```" paragraphs.
     *
     * Monospace, small, no wrapping — the whole point is that the columns line
     * up. Consumed as a block, and an unterminated fence runs to the end of the
     * document rather than throwing, because half a PRD is worse than an ugly
     * one.
     */
    if (trimmed.startsWith("```")) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) code.push(lines[i++]!);
      for (const c of code) {
        body.push(new Paragraph({
          spacing: { before: 0, after: 0, line: 240 },
          shading: { type: ShadingType.CLEAR, fill: "F8F9FA" },
          children: [new TextRun({ text: c || " ", font: "Consolas", size: 15 })],
        }));
      }
      continue;
    }

    /* A table is consumed as a block: its rows only mean anything together. */
    if (trimmed.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(lines[i++]!);
      i--;
      if (rows.filter((r) => !isRule(r)).length) body.push(tableFrom(rows));
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      body.push(new Paragraph({
        heading: HEADINGS[heading[1]!.length - 1],
        spacing: { before: 240, after: 120 },
        children: runsOf(heading[2]!),
      }));
      continue;
    }

    if (trimmed.startsWith(">")) {
      /* The PRD opens with a standing caveat in a quote — "this is a draft for
         discussion, not a specification". It is the first thing a reviewer
         should read, so it keeps its own visual weight rather than flattening
         into the surrounding prose. */
      body.push(new Paragraph({
        indent: { left: 360 },
        spacing: { before: 60, after: 60 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: "9AA4B2", space: 8 } },
        children: runsOf(trimmed.replace(/^>\s?/, ""), { italics: true }),
      }));
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      body.push(new Paragraph({
        bullet: { level: Math.min(2, Math.floor((line.length - line.trimStart().length) / 2)) },
        spacing: { before: 40, after: 40 },
        children: runsOf(bullet[1]!),
      }));
      continue;
    }

    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      body.push(new Paragraph({
        numbering: { reference: "prd-ordered", level: 0 },
        spacing: { before: 40, after: 40 },
        children: runsOf(numbered[1]!),
      }));
      continue;
    }

    body.push(new Paragraph({ spacing: { before: 80, after: 80 }, children: runsOf(trimmed) }));
  }

  const doc = new Document({
    title,
    description: "Generated by the FabOrchestrator back-end agent",
    numbering: {
      config: [{
        reference: "prd-ordered",
        levels: [{
          level: 0,
          format: "decimal",
          text: "%1.",
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{ children: body }],
  });

  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
