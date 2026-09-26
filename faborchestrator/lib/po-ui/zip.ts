/**
 * A minimal ZIP writer — for shipping a whole deployment unit as one download.
 *
 * WHY BY HAND
 *   `docx.ts` already reads ZIPs with `node:zlib` and no dependency, for the
 *   reason recorded there: this app's claim is that its output is traceable, and
 *   every library in the path is one more thing that can change under us. Writing
 *   one is the same job in reverse and about sixty lines.
 *
 * WHY AT ALL
 *   A generated `.xml` is not deployable on its own (F-98). A screen ships as a
 *   page, the queries it consumes, and the master-data file that declares its
 *   labels and imports the artifacts in dependency order. The web UI used to
 *   offer only `GENERATED.xml`, so an engineer downloaded one file, tried to
 *   import it, and had none of the rest — the queries the page binds to did not
 *   exist in the target system.
 *
 * Deflate is used where it helps and stored where it does not, which is what any
 * unzip tool expects. No ZIP64 and no encryption: a small archive of text files
 * is all this needs to be.
 *
 * DIRECTORY ENTRIES ARE SYNTHESISED, and they were not always.
 *   This file used to say "no directory entries: a FLAT archive of small text
 *   files". That was true when it was written and stopped being true when the
 *   unit gained `reports/` — the archive became nested and nothing was declaring
 *   the folder.
 *
 *   `unzip`, `Expand-Archive` and the Explorer shell API all cope: measured
 *   2026-09-02, all three listed `reports/` and its three files at full size.
 *   Explorer's own BROWSE view is the one that does not reliably, and it is what
 *   an engineer double-clicks first — the reports read as an empty folder, which
 *   is how this was reported. A deliverable that looks empty to the person
 *   receiving it is broken however well-formed the bytes are.
 *
 *   So every parent path now gets an explicit entry, and external attributes
 *   carry the MS-DOS directory bit rather than zero. `version made by` is 20 —
 *   host 0, FAT — which is what makes those attribute bits meaningful.
 */
import { deflateRawSync, crc32 } from "node:zlib";

export interface ZipEntry {
  /** path inside the archive, forward slashes, no leading slash */
  name: string;
  data: Buffer | string;
}

/** MS-DOS file attributes, in the low byte of the external-attributes field. */
const ATTR_FILE = 0x20;       // archive
const ATTR_DIRECTORY = 0x10;  // directory

/**
 * Every directory implied by the entry names, in the order they must appear.
 *
 * A parent is written BEFORE anything inside it: tools that build a tree as they
 * read expect to have seen the folder by the time a file claims to be in it.
 * Sorting is what guarantees that — "reports/" sorts before "reports/X".
 */
function directoriesOf(entries: readonly ZipEntry[]): string[] {
  const dirs = new Set<string>();
  for (const e of entries) {
    const parts = e.name.split("/");
    parts.pop();                                    // the file itself
    let path = "";
    for (const p of parts) {
      path += p + "/";
      dirs.add(path);
    }
  }
  return [...dirs].sort();
}

const DOS_TIME = 0;   // deterministic: the same inputs produce the same archive
const DOS_DATE = 33;  // 1980-01-01 — a fixed stamp, so a diff means real change

function entryBuffers(e: ZipEntry): { name: Buffer; body: Buffer; raw: Buffer } {
  const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf-8");
  /* A directory record is empty and must stay STORED. Deflating nothing yields
     two bytes, which would make the entry larger than its own declared content
     and is not what a directory record is. */
  if (raw.length === 0) {
    return { name: Buffer.from(e.name, "utf-8"), body: raw, raw };
  }
  const deflated = deflateRawSync(raw);
  // Storing is better than deflating when deflate would grow the entry, which
  // happens on very small files.
  const body = deflated.length < raw.length ? deflated : raw;
  return { name: Buffer.from(e.name, "utf-8"), body, raw };
}

/** Build a ZIP archive in memory. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  /* Directories first, each before anything it contains - see `directoriesOf`.
     A directory entry is a zero-length STORED record whose name ends in "/". */
  const all: Array<{ name: string; data: Buffer; isDir: boolean }> = [
    ...directoriesOf(entries).map((d) => ({
      name: d, data: Buffer.alloc(0), isDir: true,
    })),
    ...entries.map((e) => ({
      name: e.name,
      data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf-8"),
      isDir: false,
    })),
  ];

  for (const e of all) {
    const { name, body, raw } = entryBuffers(e);
    const stored = body === raw;
    const method = stored ? 0 : 8;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    /* BIT 11 = the name is UTF-8, and it is not optional here.
       Names are written with `Buffer.from(name,"utf-8")`, so a non-ASCII
       character is already correct BYTES — but an archive that does not declare
       UTF-8 is decoded as CP437 by every unzip tool, and the bytes come back as
       mojibake. Found by packaging this repository for deployment: the samples
       live under `AI Requirement Document – PO Management UI_Medium` with an en
       dash, and the extracted tree named it `Document ÔÇô PO Management`, so the
       config's `samplesDir` pointed at a directory that no longer existed. The
       server started, served every route, and had NO SAMPLE PAGES. */
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filename
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    locals.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);     // central directory signature
    cen.writeUInt16LE(20, 4);             // version made by
    cen.writeUInt16LE(20, 6);             // version needed
    cen.writeUInt16LE(0x0800, 8);         // same flag, same reason (see above)
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(sum, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);             // extra
    cen.writeUInt16LE(0, 32);             // comment
    cen.writeUInt16LE(0, 34);             // disk
    cen.writeUInt16LE(0, 36);             // internal attrs
    /* MS-DOS attributes. Zero here left Explorer with nothing saying "this is a
       folder", which is half of why a nested `reports/` read as empty. */
    cen.writeUInt32LE(e.isDir ? ATTR_DIRECTORY : ATTR_FILE, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(all.length, 8);
  end.writeUInt16LE(all.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}
