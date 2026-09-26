/**
 * THE DEPLOYMENT UNIT — everything a run produced, as one download.
 *
 * A generated page is not deployable alone (F-98). The screen needs:
 *   - the UI Page export
 *   - every query it consumes, imported BEFORE it
 *   - the master-data file that declares its new labels, creates the menu entry,
 *     and lists the artifacts in dependency order
 *
 * The web UI used to hand over `GENERATED.xml` and nothing else, so an engineer
 * got one file out of a run that had written four — and importing it into a
 * system without the queries produces a page whose data sources bind to nothing.
 *
 * FILE NAMES FOLLOW ATHENA'S OWN CONVENTION, because the numeric prefix IS the
 * load order and their own master data reads that way: 100 queries, 200 step,
 * 201 wizard, 300 the page. Config supplies the numbers (`masterData.loadOrder`),
 * so a client who orders things differently changes JSON, not this file.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zip, type ZipEntry } from "./zip";
import type { PipelineConfig } from "./generate/config";

export interface PackagedRun {
  buffer: Buffer;
  /** what went in, for the UI to list and for the log */
  files: string[];
  /** anything expected but absent — surfaced, never silently omitted */
  missing: string[];
  /**
   * The entries as they went in, UNCOMPRESSED.
   *
   * Here because `packageRuns` needs the parts of each single-page package in
   * order to merge them, and it used to recover them by walking the finished
   * zip's local file headers. That reader took each entry's stored bytes and
   * never inflated them, while `zip()` deflates whenever deflate is smaller —
   * so every entry it recovered from a compressed file was a raw deflate
   * stream, and it re-compressed those into the multi-page archive.
   *
   * MEASURED 2026-08-31, on the first multi-page unit built through the web
   * app since: `200_CustomChangePriorityStep.xml` arrived as **3,353 bytes of
   * deflate stream instead of 30,113 bytes of XML**, and the master-data JSON
   * was dropped entirely because `JSON.parse` of those bytes threw into a
   * silent catch — while the README said "Every artifact the page needs is
   * present" and the manifest reported `missing: []`.
   *
   * Carrying the entries removes the round trip rather than teaching the reader
   * to inflate, so the compression method stops being something a second piece
   * of code has to agree about. Additive: no existing caller reads it.
   */
  entries: ZipEntry[];
}

const DEFAULT_ORDER: Record<string, number> = { query: 100, step: 200, wizard: 201, page: 300 };

/**
 * Collect a run directory into an archive.
 *
 * `pageName` names the page file the way CMF expects it (the object's Name),
 * rather than the internal `GENERATED.xml`, so the archive can be imported as-is.
 */
/**
 * Which load-order slot a page occupies.
 *
 * The numeric filename prefix is load ORDER, not decoration: CMF imports the
 * files in name order, and a page that consumes a query must come after it.
 * Athena's own convention is 100 queries, 200 step, 201 wizard, 300 page, so a
 * wizard packaged as `300_` would import before the step it embeds.
 */
export type PageKind = "page" | "wizard" | "step";

export function packageRun(
  dir: string, pageName: string, cfg?: PipelineConfig, kind: PageKind = "page",
): PackagedRun {
  const order = { ...DEFAULT_ORDER, ...(cfg?.masterData?.loadOrder ?? {}) };
  const entries: ZipEntry[] = [];
  const files: string[] = [];
  const missing: string[] = [];

  const take = (from: string, to: string): void => {
    if (!existsSync(from)) { missing.push(to); return; }
    entries.push({ name: to, data: readFileSync(from) });
    files.push(to);
  };

  // --- queries first: a page that consumes one must import after it
  const qDir = join(dir, "queries");
  const built = new Set<string>();
  if (existsSync(qDir)) {
    for (const f of readdirSync(qDir).filter((n) => n.endsWith(".xml")).sort()) {
      built.add(f.replace(/\.xml$/, ""));
      take(join(qDir, f), `${order["query"]}_${f}`);
    }
  }

  // --- the page itself, under the load-order slot its KIND occupies
  const pagePath = join(dir, "GENERATED.xml");
  take(pagePath, `${order[kind] ?? order["page"]}_${pageName}.xml`);

  /* A query the page CONSUMES but the run did not BUILD is the one absence that
     matters, and listing the queries directory cannot see it: the directory
     holds what was produced, not what was needed.
     Found 2026-08-20 in a real download — the page bound two queries, one
     artifact existed, and the README said "Every expected artifact is present."
     A page imported without a query it binds to gets a data source pointing at
     nothing, and CMF's import validator will not catch it (F-44). */
  for (const name of queriesConsumedBy(pagePath)) {
    if (!built.has(name)) missing.push(`${name}.xml (the page binds to it; this run did not produce it)`);
  }

  // --- the master-data file, which is what actually deploys the set
  const md = readdirSync(dir).find((f) => /^\d{3}-.*\.json$/.test(f));
  if (md) take(join(dir, md), md);
  else missing.push("master-data .json");

  /* THE MANIFEST MUST NAME FILES THAT ARE IN THIS ARCHIVE.
     The master data is what deploys the set, so an ImportObject row pointing at
     a name the zip does not contain imports nothing — silently. It shipped that
     way once: the manifest listed `CustomRetrievePOMaterials.xml` while the zip
     held `100_CustomRetrievePOMaterials.xml`, so the labels and the menu entry
     deployed, the queries did not, and the page ran against the tenant's older
     queries. The two names are produced by different modules from the same
     config, which is exactly the seam that drifts; check it against the file
     list rather than trusting they agree. */
  if (md) {
    const shipped = new Set(files);
    for (const p of importPathsIn(join(dir, md))) {
      // Their own manifests carry a version folder (`2.1.0/300_Page.xml`); the
      // archive is flat, so compare on the file name.
      if (!shipped.has(p.split("/").pop() ?? p)) {
        missing.push(`${p} (the master data imports it; no such file in this package)`);
      }
    }
  }

  // --- the reports, so the engineer has the gaps and the verdict in the same place
  /* QUERY_CHANGES.md is written only when a query the client already ships was
     edited. It carries the one thing a reader must not miss — that importing
     this unit OVERWRITES an object already in their tenant. */
  for (const r of ["GAP_REPORT.md", "REPORT.txt", "GUI_REPORT.md", "QUERY_CHANGES.md"]) {
    const p = join(dir, r);
    if (existsSync(p)) { entries.push({ name: `reports/${r}`, data: readFileSync(p) }); files.push(`reports/${r}`); }
  }

  entries.push({ name: "README.txt", data: readme(files, missing, pageName) });
  files.push("README.txt");

  return { buffer: zip(entries), files, missing, entries };
}

/**
 * Which pages are STEP pages, decided from evidence rather than from `uiType`.
 *
 * A step page's `uiType` really is `Page` - that is what Athena ship, and the
 * PRD says so explicitly. So classifying on `uiType` puts a step in the `300`
 * slot and its wizard in `201`, and the wizard then imports BEFORE the page it
 * embeds. Measured on a live three-page run, which is the only reason this was
 * caught: the stub had no XML to read.
 *
 * The reliable signal is the artifact itself. A wizard embeds its step through a
 * `UiPageWidget` whose settings name the target page, so any page NAMED BY
 * another page is a step of that page. Read from the generated XML because that
 * is what will actually be imported.
 */
export function classifyPages(
  pages: ReadonlyArray<{ dir: string; name: string; uiType?: string }>,
): Array<{ dir: string; name: string; kind: PageKind }> {
  const referenced = new Set<string>();
  for (const p of pages) {
    const xml = join(p.dir, "GENERATED.xml");
    if (!existsSync(xml)) continue;
    const text = readFileSync(xml, "utf-8");
    for (const other of pages) {
      if (other.name === p.name) continue;
      // The name appears XML-escaped inside the Settings payload.
      if (text.includes(`&quot;${other.name}&quot;`) || text.includes(`"${other.name}"`)) {
        referenced.add(other.name);
      }
    }
  }
  return pages.map((p) => ({
    dir: p.dir,
    name: p.name,
    kind: p.uiType === "Wizard" ? "wizard" : referenced.has(p.name) ? "step" : "page",
  }));
}

/**
 * ONE master-data file for the whole story, not one per page.
 *
 * `writeMasterData` runs inside `run()`, which builds a single page, so a story
 * that produces three pages produced three master-data files — each declaring
 * only its own page's labels and its own import entry. Athena ship ONE per
 * story: `000-455386-POManagementUI.json` declares every label and every
 * artifact in the unit.
 *
 * Three files instead of one is not cosmetic. Each declares its own `<SM>Features`
 * entry, so importing all three would register three features for one story, and
 * a label shared by two pages would be declared twice.
 *
 * Sections are keyed by a 1-based string index, so merging means renumbering.
 * Entries are deduplicated by `Name` where they carry one: the same label
 * legitimately appears in several pages' files and must be declared once.
 */
type SmDoc = Record<string, Record<string, Record<string, unknown>>>;

export function mergeMasterData(docs: readonly SmDoc[]): SmDoc | null {
  if (docs.length === 0) return null;
  if (docs.length === 1) return docs[0]!;
  const out: SmDoc = {};
  for (const doc of docs) {
    for (const [section, entries] of Object.entries(doc)) {
      if (!entries || typeof entries !== "object") continue;
      const bucket = (out[section] ??= {});
      /*
       * IDENTITY IS PER SECTION, and `Name` alone is not it.
       *
       * `<SM>Features` and `<SM>LocalizedMessageKey` entries are keyed by `Name`.
       * `<SM>ImportObject` entries have **no `Name` at all** — they are keyed by
       * `XmlFileRelativePath`. Deduplicating on `Name` therefore did nothing for
       * imports, and a query consumed by two pages of one story was listed
       * TWICE: the page and the wizard it opens routinely share a query, so this
       * is the ordinary case rather than an edge one. CMF would be asked to
       * import the same artifact twice.
       *
       * Verified before the fix: merging two pages that share
       * `CustomRetrieveProductionOrders` produced it twice in the import list.
       */
      const idOf = (e: unknown): string => {
        const o = e as { Name?: unknown; XmlFileRelativePath?: unknown };
        return String(o.Name ?? o.XmlFileRelativePath ?? "");
      };
      const seenIds = new Set(Object.values(bucket).map(idOf));
      for (const entry of Object.values(entries)) {
        const id = idOf(entry);
        // An entry with neither key cannot be deduplicated; keep it, since
        // dropping it would silently lose an import.
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        bucket[String(Object.keys(bucket).length + 1)] = entry;
      }
    }
  }
  return out;
}

/**
 * One deployment unit for a story that produced SEVERAL pages.
 *
 * A requirement asking for a page, a wizard and the wizard's step produces three
 * artifacts that have to be imported together and in order. Handing over one of
 * them, or three separate zips the engineer must sequence by hand, is the same
 * class of mistake as shipping a page without its queries (F-98).
 *
 * Each page is packaged by the existing single-page routine and the results are
 * merged, so there is one implementation of what a unit contains. Duplicate
 * entries are dropped by name: several pages legitimately share queries and a
 * master-data file, and a zip with the same query twice is not a valid unit.
 * Reports are kept per page, since each has its own gaps and verdict.
 */
export function packageRuns(
  pages: ReadonlyArray<{ dir: string; name: string; kind?: PageKind }>,
  cfg?: PipelineConfig,
): PackagedRun {
  if (pages.length === 1) {
    const p = pages[0]!;
    return packageRun(p.dir, p.name, cfg, p.kind ?? "page");
  }
  const entries: ZipEntry[] = [];
  const files: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  // Master-data documents are collected rather than copied, then merged into one.
  const mdDocs: SmDoc[] = [];
  let mdName = "";

  for (const p of pages) {
    const one = packageRun(p.dir, p.name, cfg, p.kind ?? "page");
    for (const e of one.entries) {
      // The story's master data: hold it back and merge, do not ship three.
      if (/^\d{3}-.*\.json$/.test(e.name)) {
        /*
         * A master-data file we cannot read is REPORTED, not skipped.
         *
         * This catch was empty, and that is what hid the defect above: the
         * parse failed on every multi-page unit, `mdDocs` stayed empty, no
         * merged file was emitted, and `missing` said nothing — so the unit
         * shipped without the one file that actually deploys it while the
         * README announced it was complete. Defect 18's family: a line that
         * says everything is present is worse than one that says it is not.
         */
        const text = (Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)).toString("utf-8");
        try { mdDocs.push(JSON.parse(text) as SmDoc); }
        catch {
          missing.push(`${p.name}: ${e.name} could not be read as JSON, so it is ` +
                       `not in this unit — the pages will import with no menu entry ` +
                       `and no new labels`);
        }
        // The story token is shared; the feature token is the page. Name the
        // merged file after the FIRST page, which is the story's main screen.
        if (!mdName) mdName = e.name;
        continue;
      }
      // Reports are namespaced per page; everything else is shared and deduped.
      const name = e.name.startsWith("reports/")
        ? `reports/${p.name}/${e.name.slice("reports/".length)}`
        : e.name;
      if (name === "README.txt" || seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, data: e.data });
      files.push(name);
    }
    for (const m of one.missing) {
      const label = `${p.name}: ${m}`;
      if (!missing.includes(label)) missing.push(label);
    }
  }

  const merged = mergeMasterData(mdDocs);
  if (merged && mdName) {
    entries.push({ name: mdName, data: Buffer.from(JSON.stringify(merged, null, 1), "utf-8") });
    files.push(mdName);
  }

  entries.push({
    name: "README.txt",
    data: readme(files, missing, pages.map((p) => p.name).join(", ")),
  });
  files.push("README.txt");
  return { buffer: zip(entries), files, missing, entries };
}

/**
 * The query names a page's data sources bind to.
 *
 * Read from the artifact rather than the descriptor: the artifact is what will
 * actually be imported, so it is the only honest answer to "what does this page
 * need in the target system?"
 */
function queriesConsumedBy(pagePath: string): string[] {
  if (!existsSync(pagePath)) return [];
  try {
    const xml = readFileSync(pagePath, "utf-8");
    const raw = /<Settings value="([^"]*)"/.exec(xml)?.[1];
    if (!raw) return [];
    const json = raw
      .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#xD;/g, "\r").replace(/&#xA;/g, "\n").replace(/&#x9;/g, "\t")
      .replace(/&amp;/g, "&");
    const s = JSON.parse(json) as { dataSources?: Array<{ settings?: { query?: unknown } }> };
    const names: string[] = [];
    for (const d of s.dataSources ?? []) {
      const q = d.settings?.query;
      const n = q && typeof q === "object" ? (q as { Name?: string }).Name : undefined;
      if (n && n !== "UNKNOWN") names.push(n);
    }
    return [...new Set(names)];
  } catch { return []; }
}

/**
 * The artifact paths a master-data file says it will import.
 *
 * Read from the JSON that will actually be shipped, for the same reason
 * `queriesConsumedBy` reads the page: the deployed file is the only honest
 * answer to "what will this try to import?"
 */
function importPathsIn(mdPath: string): string[] {
  if (!existsSync(mdPath)) return [];
  try {
    const doc = JSON.parse(readFileSync(mdPath, "utf-8")) as
      Record<string, Record<string, { XmlFileRelativePath?: unknown }>>;
    return Object.values(doc["<SM>ImportObject"] ?? {})
      .map((e) => e.XmlFileRelativePath)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch { return []; }
}

function readme(files: readonly string[], missing: readonly string[], pageName: string): string {
  const arts = files.filter((f) => !f.startsWith("reports/") && f !== "README.txt");
  return [
    `DEPLOYMENT UNIT — ${pageName}`,
    "",
    "The numeric prefix is the LOAD ORDER, not decoration. A page that consumes a",
    "query must be imported after it, so import in the order listed:",
    "",
    ...arts.map((f, i) => `  ${i + 1}. ${f}`),
    "",
    "The .json master-data file is what actually deploys the set: it declares the",
    "new localized messages, creates the menu entry, and lists the artifacts to",
    "import. Importing the .xml files without it gives you a page nobody can reach",
    "whose new column headers are blank.",
    "",
    ...(missing.length
      ? ["!! INCOMPLETE — THIS UNIT WILL NOT DEPLOY AS-IS.",
         "",
         "Missing:",
         ...missing.map((m) => `  - ${m}`),
         "",
         "A page whose data source binds to a query that does not exist in the target",
         "system imports cleanly and shows nothing. CMF's import validator does not",
         "check this, so nothing downstream will tell you. Supply the missing query",
         "(or the structure needed to generate it) before importing."]
      : ["Every artifact the page needs is present."]),
    /* A unit that OVERWRITES an object already in their tenant must say so
       here, not only in a report. Importing over a live query is not something
       to discover afterwards. */
    ...(files.includes("reports/QUERY_CHANGES.md")
      ? ["",
         "!! THIS UNIT REPLACES QUERIES THAT ALREADY EXIST IN YOUR SYSTEM.",
         "   The queries here are YOUR delivered exports with specific edits, made",
         "   because the page cannot work without them. Every edit is listed, with",
         "   its reason, in reports/QUERY_CHANGES.md. Read that before importing."]
      : []),
    "",
    "reports/ holds the validator verdict, the gap report (what could not be",
    "determined and must be confirmed), and the GUI-test selector check.",
    "",
    "Generated by the CMF artifact generator. Nothing here has been imported into",
    "any CMF system; validation was performed offline.",
    "",
  ].join("\n");
}
