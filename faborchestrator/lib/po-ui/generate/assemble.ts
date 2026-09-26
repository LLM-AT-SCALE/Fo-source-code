/**
 * ENVELOPE ASSEMBLY — settings JSON to a CMF-importable .xml file.
 *
 * Two layers: XML on the outside, XML-escaped JSON inside <Settings value="…">.
 * Getting the boundary wrong produces a file that looks right and is malformed,
 * so the escaping here is verified byte-for-byte against the reference page
 * (see test/assemble.test.ts) rather than assumed.
 *
 * The model never sees this step. It writes the five arrays; our code writes the
 * part that must be exact.
 */
import { readFileSync } from "node:fs";
import { assignIds } from "./ids";

/** Placeholders the skeleton leaves open. */
export const PLACEHOLDERS = {
  settings: "{{SETTINGS_JSON}}",
  uiType: "{{UI_TYPE}}",
  pageName: "{{PAGE_NAME}}",
  objectId: "{{OBJECT_ID}}",
  pageUid: "{{PAGE_UID}}",
} as const;

/**
 * Escape a string for an XML attribute value, matching CMF's exported form.
 *
 * Order matters: & must be replaced first or the entities we introduce get
 * double-escaped.
 */
export function escapeAttribute(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#xD;")
    .replace(/\n/g, "&#xA;")
    .replace(/\t/g, "&#x9;");
}

/**
 * Read the escaped Settings payload out of an exported file.
 *
 * `[^"]*` rather than a lazy `.*?` — the closing quote is followed by
 * ` type="System.String…"`, and a lazy match backtracks straight past it and
 * swallows the type attribute. Safe because escaped JSON contains no raw ".
 */
export const SETTINGS_RE = /<Settings value="([^"]*)"/;

export function rawSettings(xml: string): string | null {
  const m = SETTINGS_RE.exec(xml);
  return m?.[1] ?? null;
}

export class AssembleError extends Error {}

export interface AssembleInput {
  /** the skeleton XML, with placeholders intact */
  skeleton: string;
  /** the complete settings object — post-$id or pre-$id, see `assignIds` */
  settings: unknown;
  pageName: string;
  uiType: string;
  objectId: string;
  /** apply $id in our code rather than trusting the model's markers */
  assignIds?: boolean;
}

export interface Assembled {
  xml: string;
  settings: unknown;
  /** the compact JSON that was escaped into the envelope */
  json: string;
}

export function assemble(input: AssembleInput): Assembled {
  const settings = input.assignIds === false ? input.settings : assignIds(input.settings);

  // CMF exports compact JSON — no spaces, no newlines.
  const json = JSON.stringify(settings);
  const escaped = escapeAttribute(json);

  let xml = input.skeleton;
  for (const [name, token] of [
    ["settings", PLACEHOLDERS.settings],
    ["uiType", PLACEHOLDERS.uiType],
    ["pageName", PLACEHOLDERS.pageName],
    ["objectId", PLACEHOLDERS.objectId],
  ] as const) {
    if (!xml.includes(token)) {
      throw new AssembleError(
        `skeleton has no ${token} placeholder — it may have been edited by hand ` +
        `or built from a different template (missing: ${name})`,
      );
    }
  }

  xml = xml
    .replace(PLACEHOLDERS.settings, () => escaped)
    .replace(PLACEHOLDERS.uiType, () => input.uiType)
    .replace(new RegExp(escapeRegExp(PLACEHOLDERS.pageName), "g"), () => input.pageName)
    .replace(new RegExp(escapeRegExp(PLACEHOLDERS.objectId), "g"), () => input.objectId);

  const leftover = xml.match(/\{\{(\w+)\}\}/g);
  if (leftover) {
    throw new AssembleError(
      `assembled file still contains placeholders: ${[...new Set(leftover)].join(", ")}`,
    );
  }

  return { xml, settings, json };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ShellValues {
  pageUid: string;
  pageTitle: string;
  layoutColumns: number;
  layoutWidth: number;
  /** page-level self-refresh; absent leaves the shell's own default in place */
  autoRefresh?: boolean;
  /** ISO 8601 duration, only honoured when autoRefresh is true */
  autoRefreshInterval?: string;
}

/**
 * Fill the settings shell's own placeholders.
 *
 * Done on the raw JSON *text*, not the parsed object, because `columns` and
 * `width` are quoted in the shell (`"{{LAYOUT_COLUMNS}}"`) and unquoted numbers
 * in real exports. Replacing the quotes along with the token is what turns
 * `"20"` into `20`; substituting after parsing would leave them as strings.
 *
 * PAGE_UID appears 15 times — once as `id` and once per left/right panel
 * property — so every occurrence is replaced, not just the first.
 */
export function fillShell(shellText: string, v: ShellValues): Record<string, unknown> {
  const filled = shellText
    .replace(/"\{\{LAYOUT_COLUMNS\}\}"/g, String(v.layoutColumns))
    .replace(/"\{\{LAYOUT_WIDTH\}\}"/g, String(v.layoutWidth))
    .replace(/\{\{PAGE_UID\}\}/g, () => v.pageUid)
    .replace(/\{\{PAGE_TITLE\}\}/g, () => jsonEscape(v.pageTitle));

  const leftover = filled.match(/\{\{(\w+)\}\}/g);
  if (leftover) {
    throw new AssembleError(
      `the settings shell has placeholders nothing fills: ${[...new Set(leftover)].join(", ")}`,
    );
  }

  let shell: Record<string, unknown>;
  try {
    shell = JSON.parse(filled) as Record<string, unknown>;
  } catch (e) {
    throw new AssembleError(
      `filling the settings shell produced invalid JSON: ${(e as Error).message}`,
    );
  }

  /*
   * Self-refresh, applied AFTER parsing rather than as a placeholder.
   *
   * The shell already ships `autoRefresh: false` / `autoRefreshInterval: "PT1M"`
   * as literals — every delivered page carries both — so there is no token to
   * substitute, and adding one would change a file the whole suite compares
   * against. Patching the parsed object leaves the shell untouched for every run
   * that does not ask for this, which is most of them.
   *
   * Only written when the descriptor STATED it. Absent means the story did not
   * say, and the shell's own default stands.
   */
  if (v.autoRefresh !== undefined) {
    const def = shell["definition"];
    if (def === null || typeof def !== "object") {
      throw new AssembleError(
        "the settings shell has no `definition` block, so page-level autoRefresh " +
        "has nowhere to go. The shell may have been edited by hand.",
      );
    }
    const d = def as Record<string, unknown>;
    d["autoRefresh"] = v.autoRefresh;
    if (v.autoRefresh && v.autoRefreshInterval) {
      d["autoRefreshInterval"] = v.autoRefreshInterval;
    }
  }
  return shell;
}

/** escape a value being substituted into a JSON string literal */
function jsonEscape(s: string): string {
  const q = JSON.stringify(s);
  return q.slice(1, -1);
}

/**
 * Merge the model's five arrays into the (already filled) settings shell.
 * The shell supplies the 14 top-level keys; the model fills the empty ones.
 */
/**
 * The model returns widget placements as a flat `layoutWidgets` array rather than
 * writing inside `layouts`, which the skeleton owns. We move it into place.
 */
export const LAYOUT_WIDGETS_KEY = "layoutWidgets";

/**
 * Custom page properties the model declares, keyed separately from `properties`.
 *
 * The shell's `properties` already holds twelve entries — `title`, `isLoaded`,
 * the header and comment plumbing — and `mergeSettings` replaces a top-level key
 * wholesale. So a model writing `properties` would DELETE all twelve. This key
 * is appended instead, which is why it is its own name rather than a convention
 * about merging.
 */
export const PAGE_PROPERTIES_KEY = "pageProperties";

/** `prop$Materials` in a link endpoint means "the page property named Materials". */
const PROP_REF = /^prop\$(.+)$/;

export interface PagePropertyOutcome {
  /** names declared, in order */
  declared: string[];
  /** how many link endpoints were rewritten to a minted id */
  wired: number;
}

/**
 * PAGE PROPERTIES, AND THE LINKS THAT REACH THEM.
 *
 * The single largest gap measured against Athena's delivered pages. Their wizard
 * carries `Materials`, `Priority` and `IsHot` as page properties and four links
 * that move values through them into a service call; their step page carries the
 * same three. We emitted none of it — not because the model could not work it
 * out, but because it had nowhere to put it: the settings shell declares only the
 * stock properties, so any `_p<id>` endpoint the model wrote would have been a
 * dangling reference, and it correctly refused and reported a gap instead.
 *
 * The split follows the one already in force for `$id` markers: the model says
 * WHAT the property is — name, type, whether it is a collection, what entity it
 * references — and our code mints the identity. So the model never invents an
 * id, and an endpoint can be written as `prop$Materials`, which is checkable.
 *
 * A reference to a property that was not declared is an ERROR, not a silent
 * drop. A dangling link imports cleanly into CMF and does nothing, which is the
 * failure mode this whole layer exists to prevent.
 */
export function applyPageProperties(
  settings: Record<string, unknown>, pageUid: string,
): PagePropertyOutcome {
  const raw = settings[PAGE_PROPERTIES_KEY];
  delete settings[PAGE_PROPERTIES_KEY];

  const declared: string[] = [];
  const idByName = new Map<string, string>();

  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new AssembleError(`${PAGE_PROPERTIES_KEY} must be an array of page properties`);
    }
    const existing = Array.isArray(settings["properties"])
      ? (settings["properties"] as Array<Record<string, unknown>>) : [];
    const taken = new Set(existing.map((p) => String(p["name"])));

    const minted: Array<Record<string, unknown>> = [];
    for (const [i, p] of raw.entries()) {
      const prop = p as Record<string, unknown>;
      const name = String(prop["name"] ?? "").trim();
      if (!name) throw new AssembleError(`${PAGE_PROPERTIES_KEY}[${i}] has no name`);
      if (taken.has(name)) {
        throw new AssembleError(
          `${PAGE_PROPERTIES_KEY}[${i}] redeclares "${name}", which the settings shell ` +
          `already defines. The shell's plumbing properties are not yours to restate.`,
        );
      }
      if (idByName.has(name)) {
        throw new AssembleError(`${PAGE_PROPERTIES_KEY} declares "${name}" twice`);
      }
      const type = prop["type"];
      if (type === null || typeof type !== "object") {
        throw new AssembleError(
          `${PAGE_PROPERTIES_KEY}[${i}] ("${name}") has no type. A property CMF cannot ` +
          `type is one it cannot bind, so this would import and do nothing.`,
        );
      }
      // Minted from the page's own uid, matching the shape in every delivered
      // page: `<pageUid>_p<n>`. Unique by construction, so no collision check.
      const id = `${pageUid}_p${i + 1}`;
      idByName.set(name, id);
      declared.push(name);
      minted.push({
        id, source: 0, name, type,
        value: prop["value"] ?? null,
        required: prop["required"] ?? false,
        emptyValue: prop["emptyValue"] ?? false,
      });
    }
    settings["properties"] = [...existing, ...minted];
  }

  /*
   * Rewrite the endpoints.
   *
   * `type: 0` is the PAGE itself — established from the delivered corpus, where
   * 910 of 910 such endpoints are the page (F-125 / A-63). Its `id` is therefore
   * ours to know, so whatever the model wrote there is replaced rather than
   * trusted; that removes the commonest way to write a dangling link.
   */
  let wired = 0;
  const links = settings["links"];
  if (Array.isArray(links)) {
    for (const l of links as Array<Record<string, unknown>>) {
      for (const [end, port] of [["source", "output"], ["target", "input"]] as const) {
        const e = l[end] as Record<string, unknown> | undefined;
        if (!e) continue;
        const isPage = Number(e["type"]) === 0;
        const ref = PROP_REF.exec(String(l[port] ?? ""));
        if (!ref && !isPage) continue;
        if (ref) {
          const id = idByName.get(ref[1]!);
          if (!id) {
            throw new AssembleError(
              `a link refers to page property "${ref[1]}", which ${PAGE_PROPERTIES_KEY} ` +
              `does not declare. Declare it or drop the link — a dangling endpoint ` +
              `imports cleanly into CMF and silently does nothing.`,
            );
          }
          l[port] = id;
          e["type"] = 0;
          wired += 1;
        }
        if (Number(e["type"]) === 0) e["id"] = pageUid;
      }
    }
  }
  return { declared, wired };
}

export function mergeSettings(
  shell: Record<string, unknown>,
  produced: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...shell };

  const placements = produced[LAYOUT_WIDGETS_KEY];
  if (placements !== undefined) {
    if (!Array.isArray(placements)) {
      throw new AssembleError(`${LAYOUT_WIDGETS_KEY} must be an array of placements`);
    }
    const layouts = out["layouts"];
    if (!Array.isArray(layouts) || layouts.length === 0) {
      throw new AssembleError("the settings shell has no layouts[0] to place widgets into");
    }
    out["layouts"] = layouts.map((l, i) =>
      i === 0 ? { ...(l as Record<string, unknown>), widgets: placements } : l);
  }

  for (const [k, v] of Object.entries(produced)) {
    if (k === LAYOUT_WIDGETS_KEY) continue;
    /* Carried through rather than rejected: it is not a shell key, and
       `applyPageProperties` consumes it after this merge — appending to
       `properties` rather than replacing it, which is the whole point. */
    if (k === PAGE_PROPERTIES_KEY) { out[k] = v; continue; }
    if (!(k in shell)) {
      throw new AssembleError(
        `the model produced a top-level key the skeleton does not define: "${k}". ` +
        `CMF ignores unknown keys silently, so this would import cleanly and not work. ` +
        `Valid keys: ${Object.keys(shell).join(", ")}`,
      );
    }
    out[k] = v;
  }
  return out;
}

export function readSkeleton(path: string): string {
  return readFileSync(path, "utf-8");
}
