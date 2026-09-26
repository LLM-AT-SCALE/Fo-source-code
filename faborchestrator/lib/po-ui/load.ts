/**
 * Load a CMF UI Page export: parse the XML envelope, then the JSON page
 * definition carried XML-escaped inside <Settings value="...">.
 *
 * XML on the outside, JSON on the inside — see LEDGER section 4.
 */
import { readFileSync, existsSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { PageSettings, Result } from "./types";

export const ATTR = "@_";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  allowBooleanAttributes: true,
  parseAttributeValue: false, // keep every attribute a string; ids are 19 digits
  trimValues: false,
});

export type XmlNode = Record<string, unknown>;

/** first descendant element with this tag, document order (mirrors ET `.//tag`) */
export function findDescendant(node: unknown, tag: string): XmlNode | undefined {
  if (node === null || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node as XmlNode)) {
    if (key.startsWith(ATTR)) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (key === tag && item !== null && typeof item === "object") {
        return item as XmlNode;
      }
      const hit = findDescendant(item, tag);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** direct child element with this tag (mirrors ET `.find(tag)`) */
export function child(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!node) return undefined;
  const value = node[tag];
  if (value === undefined || value === null) return undefined;
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === "object" ? (item as XmlNode) : undefined;
}

export function attr(node: XmlNode | undefined, name: string): string | undefined {
  const v = node?.[ATTR + name];
  return typeof v === "string" ? v : undefined;
}

export interface Loaded {
  root?: XmlNode;
  rootTag?: string;
  settings?: PageSettings;
}

/**
 * Returns whatever could be parsed, pushing FAIL/PASS results as it goes.
 * Never throws — a malformed file is a finding, not an exception.
 */
export function load(path: string, results: Result[]): Loaded {
  if (!existsSync(path)) {
    results.push({ level: "FAIL", name: "file exists", detail: path });
    return {};
  }

  const raw = readFileSync(path, "utf-8");

  const check = XMLValidator.validate(raw, { allowBooleanAttributes: true });
  if (check !== true) {
    results.push({ level: "FAIL", name: "well-formed XML", detail: check.err.msg });
    return {};
  }
  results.push({ level: "PASS", name: "well-formed XML", detail: "" });

  const doc = parser.parse(raw) as XmlNode;
  const rootTag = Object.keys(doc).find((k) => !k.startsWith("?") && !k.startsWith(ATTR));
  const root = rootTag ? (doc[rootTag] as XmlNode) : undefined;

  const settingsEl = findDescendant(doc, "Settings");
  if (!settingsEl) {
    results.push({ level: "FAIL", name: "<Settings> element present", detail: "" });
    return { root, rootTag };
  }

  const value = attr(settingsEl, "value");
  let settings: PageSettings;
  try {
    settings = JSON.parse(value ?? "") as PageSettings;
  } catch (e) {
    results.push({
      level: "FAIL",
      name: "Settings holds valid JSON",
      detail: e instanceof Error ? e.message : String(e),
    });
    return { root, rootTag };
  }
  results.push({ level: "PASS", name: "Settings holds valid JSON", detail: "" });
  return { root, rootTag, settings };
}
