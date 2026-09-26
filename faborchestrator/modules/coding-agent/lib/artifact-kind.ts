/**
 * WHAT A FILE IN THE DEPLOYMENT UNIT IS FOR.
 *
 * Ported from the standalone app, where the unit card labels each file by its
 * ROLE rather than its size. A character count answers a question nobody asked:
 * an engineer looking at this list is deciding what to import and in what order,
 * and "26,424 chars" helps with neither. "query, import first" does.
 *
 * The order matters and is load-bearing at import time — a page imported before
 * the queries it binds to imports cleanly and then finds nothing to read — so
 * the label carries that instruction where it is relevant.
 *
 * Derived from the file NAME because that is all the unit listing has, and the
 * names are ours: the pipeline numbers them for import order and prefixes the
 * master-data file `000-`.
 */
type ArtifactKind =
  | "report"
  | "master data"
  | "query"
  | "UI page"
  | "";

function artifactKind(name: string): ArtifactKind {
  if (name.startsWith("reports/")) return "report";
  if (/\.json$/.test(name)) return "master data";
  if (/^\d*_?Custom(Retrieve|Get)/.test(name) || /Query/i.test(name)) return "query";
  if (/\.xml$/.test(name)) return "UI page";
  return "";
}

/** The kind, with the import instruction attached where there is one. */
export function artifactRole(name: string): string {
  switch (artifactKind(name)) {
    case "report":      return "report";
    case "master data": return "master data, deploys the set";
    case "query":       return "query, import first";
    case "UI page":     return "UI page";
    default:            return "";
  }
}
