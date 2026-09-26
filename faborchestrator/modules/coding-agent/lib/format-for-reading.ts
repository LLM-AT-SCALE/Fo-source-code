/**
 * FORMAT A GENERATED ARTIFACT SO IT CAN BE READ.
 *
 * A CMF UI Page export is a single line. The one measured here is 43,784
 * characters on line 1 of 1 — which is correct for the file (CMF neither needs
 * nor preserves the whitespace) and unreadable on screen: the panel showed one
 * line, a horizontal scrollbar, and nothing else.
 *
 * FOR DISPLAY ONLY. The bytes on disk and in the deployment unit are untouched;
 * this runs on a copy, in the browser, on its way to the viewer. What imports
 * into a tenant is what the generator wrote, formatted or not.
 *
 * TEXTUAL, NOT A PARSE-AND-REBUILD. Re-serialising through an XML library would
 * make this a second writer of CMF XML — free to normalise a self-closing tag,
 * reorder an attribute or re-escape an entity, and so free to show the engineer
 * something subtly different from the file they are about to import. The whole
 * point of opening it is to check the real thing. So the only edit made is
 * inserting line breaks and indentation BETWEEN tags: no character inside a tag,
 * an attribute or a text node is touched.
 */

/** Break between adjacent tags and indent by depth. Nothing else changes. */
export function formatXmlForReading(xml: string): string {
  if (xml.includes("\n")) return xml;      // already formatted; leave it alone

  /* Only between `>` and `<`. A text node keeps its own content, and the JSON
     payload CMF carries inside a `value="…"` attribute is never split, because
     it lives inside a tag rather than between two. */
  const withBreaks = xml.replace(/>\s*</g, ">\n<");

  const out: string[] = [];
  let depth = 0;
  for (const line of withBreaks.split("\n")) {
    const isClose = /^<\//.test(line);
    const isSelfContained = /^<[^>]+\/>$/.test(line) || /^<([\w.:-]+)[^>]*>.*<\/\1>$/.test(line);
    const isDecl = /^<[?!]/.test(line);

    if (isClose) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + line);
    if (!isClose && !isSelfContained && !isDecl && /^<[^/]/.test(line)) depth += 1;
  }
  return out.join("\n");
}

/** Minified master-data JSON, re-indented. Parsed, so a malformed file is left
 *  exactly as it is rather than being half-formatted into something worse. */
function formatJsonForReading(json: string): string {
  if (json.includes("\n")) return json;
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function formatForReading(content: string, language: string): string {
  if (language === "xml") return formatXmlForReading(content);
  if (language === "json") return formatJsonForReading(content);
  return content;
}
