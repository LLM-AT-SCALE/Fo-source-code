/**
 * DOCUMENT TEXT — pull readable text out of an uploaded user story.
 *
 * .docx is a ZIP holding word/document.xml. We read the archive and inflate that
 * one entry ourselves rather than take a dependency: this app's whole claim is
 * that its output is traceable, and every library in the path is one more thing
 * that can change under us.
 *
 * Only the text is wanted. Formatting, images and revision history are dropped.
 *
 * COMMENTS ARE NOT DROPPED, and that was learned the hard way.
 *   Athena negotiate requirements in Word's review comments and act on the
 *   result. `US-455386-POManagementUI_New.docx` carries, in `word/comments.xml`
 *   and nowhere else:
 *       "Add 1 more filter for Product"
 *       "update name as Production Order"
 *       "Traveler print button can be added? (Reuse for E-Lot travel button)"
 *       "Ok. We will incorporate this minor changes in Lot Traveler"
 *   Those are three of the four ways their as-built page was recorded as
 *   "diverging from the requirement document" (F-54) — the Product filter, the
 *   extra query that feeds it, and the fourth action button. The page did not
 *   diverge from the document; we were reading two thirds of the document.
 *   16 of the documents they have sent carry comments of this kind.
 *
 *   So comments are extracted and appended under a heading, never merged into the
 *   body: a comment is a discussion, and some are questions rather than
 *   instructions. Labelling them lets the model weigh them as such.
 */
/*
 * Lives in `src/`, not `src/web/`, because it is not a web concern.
 *
 * It reads text out of a `.docx`, imports `node:zlib` and nothing else, and
 * is used by four generation CLIs, two build scripts and the HTTP layer
 * alike. Filed under `web/` it was the ONLY reason the generation pipeline
 * imported from the web layer at all - which mattered the moment this
 * codebase had to be split, the core kept and the HTTP layer replaced.
 * Moved 2026-09-01 so that boundary is exact rather than nearly exact.
 */
import { inflateRawSync } from "node:zlib";

export class DocumentError extends Error {}

/** Local-file-header signature: "PK\x03\x04" */
const LOCAL_HEADER = 0x04034b50;

interface ZipEntry { name: string; data: Buffer }

/**
 * Walk the local file headers. We deliberately do not use the central directory:
 * scanning forward handles the streamed archives Word sometimes produces, where
 * sizes live in a trailing data descriptor.
 */
function readZip(buf: Buffer, want: (name: string) => boolean): ZipEntry[] {
  const out: ZipEntry[] = [];
  let off = 0;

  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== LOCAL_HEADER) break;

    const method = buf.readUInt16LE(off + 8);
    const compressed = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compressed > buf.length) break;

    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf-8");
    if (want(name) && compressed > 0) {
      const raw = buf.subarray(dataStart, dataStart + compressed);
      try {
        out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
      } catch {
        /* an entry we cannot inflate is skipped, not fatal */
      }
    }
    off = dataStart + compressed;
  }
  return out;
}

/**
 * Word's XML to plain text.
 *
 * Paragraph and row boundaries become newlines, tabs and cell boundaries become
 * spaces, everything else is dropped. Entities are decoded last so that a `&lt;`
 * in the source never turns into a tag we then strip.
 */
function wordXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Text of an uploaded document. `.docx` is unpacked; anything else is treated as
 * plain text, which covers .txt, .md and pasted content.
 */
export function documentText(filename: string, bytes: Buffer): string {
  // A .docx IS a zip, so trust the magic bytes over the extension: a story saved
  // with the wrong extension still unpacks, and a .docx that is really a PDF is
  // caught with a message that says what to do about it.
  const isDocx = bytes.length > 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;

  if (!isDocx) {
    if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      throw new DocumentError(
        `${filename} is a PDF. Save the story as .docx, or paste its text here.`,
      );
    }
    // legacy .doc is an OLE compound file: D0 CF 11 E0
    if (bytes.length > 4 && bytes.readUInt32BE(0) === 0xd0cf11e0) {
      throw new DocumentError(
        `${filename} is a legacy .doc. Open it in Word and use Save As to make a .docx.`,
      );
    }
    const text = bytes.toString("utf-8");
    // A NUL byte means binary. Written as the ESCAPE "\0", never as a literal
    // control character: this line held a real 0x00 byte until 2026-08-18, which
    // was invisible in every editor and diff. Any tool that normalised control
    // characters would have turned it into includes("") — always true — and every
    // .txt and .md upload would have been rejected as binary.
    if (text.includes("\0")) {
      throw new DocumentError(
        `${filename} looks like a binary file. Upload a .docx, .txt or .md, ` +
        `or paste the story directly.`,
      );
    }
    const plain = text.trim();
    // An empty upload used to come back as "" and be accepted as a story, which
    // then spent a model call on `---\n\n---`. The docx path already refuses a
    // document with no text; the plain-text path must refuse one too, and a
    // 0-byte file lands here because it has no zip signature (T-22).
    if (!plain) {
      throw new DocumentError(
        `${filename} is empty — there is no story in it. Upload a file with the ` +
        `requirement text, or paste the story directly.`,
      );
    }
    return plain;
  }

  const parts = readZip(bytes, (n) =>
    n === "word/document.xml" || n === "word/comments.xml" ||
    /^word\/(header|footer)\d*\.xml$/.test(n));

  const body = parts.find((p) => p.name === "word/document.xml");
  if (!body) {
    throw new DocumentError(
      `Could not find the document body inside ${filename}. ` +
      `If it opens in Word, try re-saving it as .docx.`,
    );
  }

  const text = wordXmlToText(body.data.toString("utf-8"));
  if (!text) {
    throw new DocumentError(
      `${filename} unpacked but contains no text — it may be all images or tracked changes.`,
    );
  }

  const comments = parts.find((p) => p.name === "word/comments.xml");
  const notes = comments ? commentsToText(comments.data.toString("utf-8")) : [];
  if (notes.length === 0) return text;

  return [
    text,
    "",
    "## Review comments on this document",
    "",
    "Comments left in the document by its reviewers. They are part of the request:",
    "some are decisions, some are questions, and some are answers to the questions.",
    "Read them as discussion, not as body text — but do not ignore them, because",
    "requirements are agreed here and then built.",
    "",
    ...notes.map((c) => `- ${c.author ? `**${c.author}:** ` : ""}${c.text}`),
  ].join("\n");
}

export interface DocumentComment {
  author?: string;
  text: string;
}

/**
 * Reviewers' comments, in document order, one entry per `<w:comment>`.
 *
 * The author sits on the element rather than in the text, and it matters: an
 * exchange reads as a question and an answer only when you can see that two
 * different people wrote them.
 */
export function commentsToText(xml: string): DocumentComment[] {
  const out: DocumentComment[] = [];
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attrs = m[1] ?? "";
    const author = /w:author="([^"]*)"/.exec(attrs)?.[1];
    // Runs inside one comment are joined without a separator: Word splits a
    // sentence across runs at every formatting change, so "Ok.  We will
    // incorporate" + " this minor changes" + " in Lot Traveler" is one sentence.
    const text = wordXmlToText(m[2] ?? "").replace(/\s*\n\s*/g, " ").trim();
    if (text) out.push(author ? { author, text } : { text });
  }
  return out;
}
