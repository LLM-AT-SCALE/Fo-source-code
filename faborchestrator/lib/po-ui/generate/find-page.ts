/**
 * FIND A DELIVERED PAGE BY ITS OWN NAME.
 *
 * WHY THIS EXISTS
 *   `--templates-from` ports hand-written `customTemplate` markup from a named
 *   export rather than authoring it (A-49). It works, and it is the difference
 *   between our best measured result and a plainer page: with it, four Materials
 *   columns match Athena's byte for byte; without it they are plain typed
 *   columns and the hold icon, the state icons and the navigation links are gone.
 *
 *   But the flag is CLI-only. The web app never passed it, so every chat run
 *   produced **0 templated columns** where the CLI produced 4. The tool's own
 *   users were getting the worse of its two outputs.
 *
 * WHY THERE IS STILL NO DEFAULT SOURCE
 *   A-49 refused a default deliberately, and that reasoning has not changed:
 *   templates vary per page — `Name` carries two different ones across Athena's
 *   own artifacts — so an unnamed source would silently apply markup from an
 *   unrelated screen.
 *
 *   What this adds is narrower and is evidence, not a default: if the client has
 *   already delivered a page **with the same name as the one being built**, that
 *   page's templates are the ones for these columns. Not a similar page, not the
 *   closest match — the same page.
 *
 * MATCHED ON THE PAGE'S OWN `<Name>`, NEVER THE FILENAME
 *   Same rule as query transcription: exports carry load-order prefixes
 *   (`300_CustomProductionOrderManagementUI.xml`) and the same page appears under
 *   several feature folders.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FoundPage {
  /** absolute path to the export */
  path: string;
  /** the page's own <Name>, which matched */
  name: string;
}

/** The page's declared name, or null if this file is not a UI Page export. */
function pageNameOf(xml: string): string | null {
  // A UI Page carries its definition as escaped JSON in <Settings value="…">.
  // Anything without widgets is a query, a rule or something else entirely.
  const i = xml.indexOf('<Settings value="');
  if (i < 0) return null;
  const j = xml.indexOf('"', i + 17);
  if (j < 0 || !xml.slice(i + 17, j).includes("&quot;widgets&quot;")) return null;
  return /<Name value="([^"]+)"/.exec(xml)?.[1] ?? null;
}

/**
 * Search `roots` for a delivered page whose own name is `pageName`.
 *
 * Returns the first match. Where several copies exist — and they do, the same
 * page appears in up to four feature folders — they are copies of one artifact,
 * so the first is as good as any.
 */
export function findDeliveredPage(
  roots: readonly string[], pageName: string, limit = 4000,
): FoundPage | null {
  let seen = 0;
  const walk = (dir: string): FoundPage | null => {
    let entries;
    try { entries = readdirSync(dir); } catch { return null; }
    for (const entry of entries) {
      if (seen > limit) return null;
      const p = join(dir, entry);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
        continue;
      }
      if (!entry.toLowerCase().endsWith(".xml")) continue;
      seen += 1;
      let xml;
      try { xml = readFileSync(p, "utf-8"); } catch { continue; }
      // Cheap reject before parsing: the name must appear somewhere in the file.
      if (!xml.includes(pageName)) continue;
      if (pageNameOf(xml) === pageName) return { path: p, name: pageName };
    }
    return null;
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const hit = walk(root);
    if (hit) return hit;
  }
  return null;
}
