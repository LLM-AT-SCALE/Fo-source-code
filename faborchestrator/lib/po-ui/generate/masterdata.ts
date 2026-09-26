/**
 * MASTER DATA — the deployment unit for a generated screen.
 *
 * WHY THIS EXISTS
 *   A generated `.xml` is NOT deployable on its own. Discovered 2026-08-19 from
 *   Entegris' own repository (F-98): every UI page ships with a master-data JSON
 *   that does three things the artifacts cannot do for themselves.
 *
 *     <SM>Features             the menu entry — without it nobody can reach the page
 *     <SM>LocalizedMessageKey  the NEW labels, with text per culture
 *     <SM>ImportObject         which artifacts to import, IN DEPENDENCY ORDER
 *
 *   Ship the XML alone and the page imports, sits unreachable, and shows blank
 *   column headers where its new labels should be. Same silent-failure family as
 *   defects 11, 16 and 17: valid file, inert result.
 *
 * MEASURED, NOT INFERRED
 *   Every shape below was counted across all 96 master-data files in MES_CORE —
 *   201 message entries, 8 feature entries, 36 import entries — not read off the
 *   single example for our pilot story. Where something varies, it is config.
 *
 * THE DIVISION OF LABOUR HOLDS
 *   Our code decides structure, ordering and which labels need declaring. The one
 *   judgement call — the human-readable text for a brand-new label — is DERIVED
 *   with a documented rule and then REPORTED, never silently accepted.
 */
import { readFileSync, existsSync } from "node:fs";
import { isPlaceholderMessage } from "../platform";

/* ------------------------------------------------------------------ shapes */

/** An artifact to be imported, and what kind it is — kind decides load order. */
export interface MasterDataArtifact {
  /** file name as written, e.g. "CustomRetrievePOMaterials.xml" */
  file: string;
  kind: "query" | "step" | "wizard" | "page";
}

export interface MasterDataInput {
  /** the story identifier, e.g. "455386" */
  storyId: string;
  /** the feature this screen belongs to, e.g. "POManagement" */
  featureName: string;
  artifacts: readonly MasterDataArtifact[];
  /** every $(MessageName) the artifacts reference */
  messageNames: readonly string[];
  /** message names that already exist and must NOT be redeclared */
  knownMessages: ReadonlySet<string>;
  /** display text for a new message, where something better than the derived default is known */
  text?: Readonly<Record<string, string>>;
  config: MasterDataConfig;
}

export interface MasterDataConfig {
  /** cultures to emit. VARIES in the wild — 5 on older files, 8 on newer ones */
  cultures: readonly string[];
  /** the culture carrying the real text; the rest are left empty for translation */
  primaryCulture: string;
  /** feature naming, e.g. "Entegris" -> Entegris.POManagement / "Entegris POManagement" */
  featurePrefix: string;
  /** 201/201 live entries use "Message" */
  messageType: string;
  /** filename number prefix per kind — dependencies first */
  loadOrder: Readonly<Record<MasterDataArtifact["kind"], number>>;
}

export interface MasterDataResult {
  /** the JSON to write */
  document: Record<string, unknown>;
  /** labels this screen introduces */
  declared: string[];
  /** labels it reuses from the platform */
  inherited: string[];
  /**
   * Labels the story asked for that have NO evidenced message name.
   *
   * Reported, never declared. Each one needs a real name from the client before
   * the screen ships, and a reader must be able to see that list — an artifact
   * carrying `$(UNKNOWN_Batch)` renders a broken key, which is loud, whereas an
   * invented `$(CustomBatchLabel)` renders perfectly and is wrong.
   */
  placeholders: string[];
  /**
   * Display texts we DERIVED rather than were given. Reported, never hidden:
   * the rule is documented and mostly right, and mostly right is exactly the
   * kind of thing a human should confirm.
   */
  derivedText: Array<{ name: string; text: string }>;
  /** suggested file name, following their convention */
  fileName: string;
  /** set when storyId/featureName had to be sanitised to make a usable filename */
  renamed?: string;
}

export class MasterDataError extends Error {}

/* ------------------------------------------------------------- label text */

/**
 * A human-readable label from a message name.
 *
 * `CustomHoldCountColumnLabel` -> "Hold Count". Strip the `Custom` prefix and the
 * `…ColumnLabel` / `…GridLabel` / `…Label` suffix, then split the remaining
 * PascalCase on word boundaries.
 *
 * ACCURACY, MEASURED against the pilot story's own declared texts: 2 of 3 exact.
 * It produces "Track In Resource" where Athena wrote "TrackIn Resource" — because
 * "TrackIn" is domain vocabulary, not two words, and no casing rule can know that.
 * Hence `derivedText`: every derived string is handed back for confirmation rather
 * than quietly shipped.
 */
export function deriveText(messageName: string): string {
  const stem = messageName
    .replace(/^Custom/, "")
    .replace(/(Column|Grid|ActionButtonAction)?(Label|Name)$/, "");
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim() || messageName;
}

/* -------------------------------------------------------------- assembly */

/** sequential string keys "1","2","3" — the shape every section uses */
function keyed<T>(items: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  items.forEach((v, i) => { out[String(i + 1)] = v; });
  return out;
}

/**
 * A filename-safe story token.
 *
 * `storyId` reaches us from a MODEL, and a model does not always answer the
 * question the field name asks. On 2026-08-20 an extraction put the whole story
 * summary in it — "US-455386 (Entegris KSP): Perform Hold and Release on multiple
 * materials selected from the materials of a chosen Production Order. …" — and
 * `000-${storyId}-${feature}.json` became a 300-character path with colons in it.
 * `writeFileSync` threw ENOENT, the run's own catch logged it, and **the master
 * data was silently missing from the deployment unit** while the page and queries
 * looked fine.
 *
 * So: never interpolate a model-supplied value into a path unchecked.
 *   1. If the text contains a run of digits that looks like a work-item id, use it —
 *      "US-455386 (Entegris KSP): …" is really story 455386.
 *   2. Otherwise there is NO story id, and the segment is dropped.
 * `changed` is returned so the caller can report the substitution rather than
 * quietly rename the file.
 *
 * DROPPED, NOT SLUGGED. Rule 2 used to reduce the prose to a 40-character token,
 * which on a story opening "As an operator I need a simple UI page to…" produced
 * `000-As-an-operator-I-need-a-simple-UI-page-t-LoadMaterialsToFeeder.json` —
 * safe, deterministic, and embarrassing to hand a client. Measured against the
 * delivered master data, which carries BOTH shapes and settles it:
 *
 *   000-455386-POManagementUI.json          a story id exists
 *   000-CustomBOMContextKey.json            none does - no segment at all
 *   000-CustomConsolidateTransaction.json
 *
 * An empty token therefore means "this story has no id", and the caller omits
 * the segment rather than inventing a stand-in for it.
 */
export function storyToken(raw: string): { token: string; changed: boolean } {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const s = raw.trim();
  if (safe.test(s)) return { token: s, changed: false };

  const digits = /\b(\d{4,})\b/.exec(s);
  if (digits?.[1]) return { token: digits[1], changed: true };

  return { token: "", changed: true };
}

export function buildMasterData(input: MasterDataInput): MasterDataResult {
  const cfg = input.config;
  if (input.artifacts.length === 0) {
    throw new MasterDataError("a master-data file with no artifacts to import would deploy nothing");
  }
  if (!cfg.cultures.includes(cfg.primaryCulture)) {
    throw new MasterDataError(
      `primaryCulture "${cfg.primaryCulture}" is not in the configured cultures ` +
      `(${cfg.cultures.join(", ")}) — the message text would have nowhere to go`,
    );
  }

  // ---------------------------------------------------------------- messages
  // A label is DECLARED only when it does not already exist. Getting this wrong
  // in either direction is a real failure: redeclaring an existing message
  // collides, and omitting a new one leaves a blank column header.
  const seen = new Set<string>();
  const declared: string[] = [];
  const inherited: string[] = [];
  /*
   * A PLACEHOLDER IS NOT A MESSAGE, and this split is load-bearing.
   *
   * `$(UNKNOWN_StorageStep)` is the generator saying "the story asked for a
   * label and the vocabulary carries no name for it". Declaring that as a
   * localized message would import invented vocabulary into the client's
   * tenant under a name nobody chose — and it would do so silently, because
   * the deployment unit looks correct either way.
   *
   * This absence is what made an earlier edit soften Rule 2 toward plain text
   * to dodge the problem, which then collided with `checkLabels` — plain
   * labels FAIL on generated output — and cost a run all three of its
   * attempts. Quarantining the placeholder here fixes the actual harm, which
   * is what lets Rule 2 be stated once instead of twice, contradicting itself.
   */
  const placeholders: string[] = [];
  for (const n of input.messageNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (isPlaceholderMessage(n)) { placeholders.push(n); continue; }
    (input.knownMessages.has(n) ? inherited : declared).push(n);
  }
  declared.sort();
  inherited.sort();
  placeholders.sort();

  const derivedText: Array<{ name: string; text: string }> = [];
  const messages = declared.map((name) => {
    const given = input.text?.[name];
    const text = given ?? deriveText(name);
    if (given === undefined) derivedText.push({ name, text });

    const entry: Record<string, string> = {
      Name: name,
      Description: text,
      MessageType: cfg.messageType,
    };
    // Only the primary culture carries text; the rest are declared empty, which
    // is what 195 of 201 live entries do — translation is a separate process.
    for (const c of cfg.cultures) entry[c] = c === cfg.primaryCulture ? text : "";
    return entry;
  });

  // ---------------------------------------------------------------- imports
  // Load order is the whole point: a page that consumes a query must import
  // after it. Their filenames encode this as a numeric prefix — 100 queries,
  // 200/201 sub-pages, 300 the page — and the ImportObject list follows suit.
  const ordered = [...input.artifacts].sort((a, b) =>
    (cfg.loadOrder[a.kind] - cfg.loadOrder[b.kind]) || a.file.localeCompare(b.file));

  /*
   * THE PATH MUST NAME THE FILE THAT IS ACTUALLY SHIPPED.
   *
   * The prefix is not cosmetic and it is not only ordering: it is part of the
   * filename. `packageRun` writes `100_CustomRetrievePOMaterials.xml` into the
   * archive, and this list used to say `CustomRetrievePOMaterials.xml` — a path
   * matching nothing in the zip, so every ImportObject row resolved to no file
   * and the master data deployed the labels and the menu entry while importing
   * none of the artifacts. Athena hit exactly that: their tenant kept its own
   * older queries, and the Materials grid rendered blank in every column those
   * older queries do not select.
   *
   * Their own file writes `2.1.0/100_CustomRetrievePOMaterials.xml` — the same
   * prefix under a version folder, because their master data sits in a
   * versioned repo directory. Our archive is flat, so the prefix alone is the
   * correct relative path here.
   *
   * The existing order gate could not catch this: it compares the SEQUENCE of
   * entries, and a list that is uniformly wrong is still correctly ordered.
   */
  const imports = ordered.map((a) => ({
    XmlFileRelativePath: `${cfg.loadOrder[a.kind]}_${a.file}`,
    ChangeSet: "",
  }));

  // ---------------------------------------------------------------- feature
  const feature = {
    Name: `${cfg.featurePrefix}.${input.featureName}`,
    Description: "",
    FeatureGroup: `${cfg.featurePrefix} ${input.featureName}`,
    IsWritable: "No",
    ForceSignature: "No",
    Roles: "",
    PresentationBehavior: "Default",
  };

  const document: Record<string, unknown> = {
    "<SM>Features": keyed([feature]),
  };
  if (messages.length) document["<SM>LocalizedMessageKey"] = keyed(messages);
  document["<SM>ImportObject"] = keyed(imports);

  // storyId is model-supplied and goes into a FILENAME — sanitise it (see storyToken).
  const storyTok = storyToken(input.storyId);
  const featureTok = storyToken(input.featureName);

  /*
   * The feature segment is the only thing that NAMES the file, so unlike the
   * story id it may not be empty — `000-.json` would be worse than a long name.
   * It is derived by us rather than supplied by a model, but a filename is the
   * wrong place to rely on that, so it falls back to a slug and then to a
   * constant.
   */
  const featureSegment = featureTok.token
    || input.featureName.replace(/[^A-Za-z0-9]+/g, "").slice(0, 40)
    || "MasterData";

  /* Empty segments drop out, which is what gives `000-<Feature>.json` when the
     story has no id — the shape the delivered corpus uses in that case. */
  const fileName = ["000", storyTok.token, featureSegment].filter(Boolean).join("-") + ".json";

  return {
    document,
    declared,
    inherited,
    placeholders,
    derivedText,
    fileName,
    renamed: storyTok.changed || featureTok.changed
      ? `story id ${JSON.stringify(input.storyId.slice(0, 60))}${input.storyId.length > 60 ? "…" : ""} is not filename-safe; used ${JSON.stringify(storyTok.token)}`
      : undefined,
  };
}

/* ---------------------------------------------------------------- helpers */

/** Every `$(MessageName)` an artifact references. */
export function messageNamesIn(xml: string): string[] {
  const unescaped = xml.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return [...new Set([...unescaped.matchAll(/\$\((\w+)\)/g)].map((m) => m[1] as string))];
}

/**
 * Load the existing-message list.
 *
 * A flat text file rather than the 27 MB localized-message dump: parsing that on
 * every run to reach 4,700 strings is waste. Regenerate the asset when the source
 * changes; never hand-edit it.
 */
export function loadKnownMessages(path: string): Set<string> {
  if (!existsSync(path)) {
    throw new MasterDataError(
      `known-message list not found at ${path}. Without it every label looks new, ` +
      `so the generator would redeclare messages that already exist.`,
    );
  }
  const out = new Set<string>();
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) out.add(t);
  }
  return out;
}

/** Pretty-print the way their files are written: 2-space indent, trailing newline. */
export function formatMasterData(doc: Record<string, unknown>): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
