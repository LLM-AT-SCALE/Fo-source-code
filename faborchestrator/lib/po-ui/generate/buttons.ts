/**
 * ACTION BUTTON COMPLETION — fill the boilerplate, never the judgement.
 *
 * WHY THIS EXISTS
 *   Every action button CMF serialises carries a set of keys we were not
 *   emitting. Measured across 1,694 real buttons — 1,015 on the base-tenant pages
 *   and 679 on Entegris' own — five of them never vary at all, and
 *   `actionButtonId` equals `actionId` about 93% of the time.
 *
 *   A generated button without them imports cleanly and is missing state the
 *   client reads. It is the same silent-shortfall family as an unplaced widget:
 *   nothing complains, and the artifact is not what CMF would have written.
 *
 * THE DIVISION HOLDS
 *   These are invariants and a dominant convention — arithmetic, not judgement —
 *   so our code writes them, exactly as it writes `$id` and the envelope.
 *   Anything that genuinely varies stays with the model: `executionType`,
 *   `autoRefresh`, `requiredFunctionality`, the caption and the icon.
 *
 * NEVER AN OVERRIDE
 *   A key the model set is left alone, always. This fills gaps; it does not
 *   correct decisions. If the model had a reason to make a button primary, that
 *   reason survives.
 */
import { readFileSync } from "node:fs";

import { ACTION_BUTTON_CONVENTIONS, ACTION_BUTTON_DEFAULTS,
         ACTION_BUTTON_ID_FOLLOWS_ACTION_ID } from "../platform";
import { rule, type Conventions } from "../conventions";
import type { PageSettings } from "../types";

/* ------------------------------------------------- the input contract (T-44)
 *
 * An action button declares the inputs its action expects. Those are not
 * derivable from the action's name — `Material.Hold` takes `material,materials`,
 * `Material.TrackIn` takes `material,materials,resource`, `Material.Attach.Group`
 * takes none — so they are transcribed from the client's own pages into
 * ACTION-CONTRACTS.json and read here.
 *
 * WHY CODE FILLS THIS RATHER THAN THE MODEL
 *   The descriptor names one value ("Materials"), and the platform contract is a
 *   pair. Nothing in the document says so and nothing could; it is a fact about
 *   their tenant, held in an asset, and applying a table is arithmetic. Same
 *   division as the `Custom` prefix and the `$id` counter.
 *
 * WHY IT MATTERS
 *   Athena imported our page and reported Hold and Release "not displayed" after
 *   selecting a material. Both buttons declared `materials` and not `material`.
 *   Across their delivered pages 75 buttons declare `material,materials` and not
 *   one declares the plural alone — a missing input is not cosmetic, the button
 *   does not render.
 */

/** One input a delivered button of this action id carries. */
export interface ContractInput {
  name: string;
  input: {
    type: number | null;
    collectionType: number | null;
    referenceType: number | null;
    referenceTypeName: string | null;
  };
}

export interface ActionContract {
  actionButtonId: string;
  /** absent when the delivered pages disagreed — then we fill nothing */
  inputs?: ContractInput[];
  seen: number;
  agree: number;
}

/** `actionButtonId` -> its agreed input contract. */
export type ContractLibrary = ReadonlyMap<string, ActionContract>;

export function loadActionContracts(path: string): ContractLibrary {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { contracts?: ActionContract[] };
  const out = new Map<string, ActionContract>();
  for (const c of raw.contracts ?? []) {
    if (c.actionButtonId && c.inputs?.length) out.set(c.actionButtonId, c);
  }
  return out;
}

/**
 * The wrapper CMF puts around an input, measured over 2,195 real ones:
 * `visible=true removable=false editable=false` on 2,131, and `id` equal to
 * `actionInput_<name>` on the same 2,131.
 */
function materialiseInput(c: ContractInput): Record<string, unknown> {
  return {
    id: `actionInput_${c.name}`,
    name: c.name,
    input: { ...c.input },
    visible: true,
    removable: false,
    editable: false,
  };
}

export interface ButtonCompletion {
  /** button name -> the keys we added to it */
  filled: Array<{ button: string; keys: string[] }>;
  /**
   * Inputs added from the transcribed contract, per button.
   *
   * Reported loudly because it changes what the button DOES, not merely what it
   * serialises — unlike everything else this module fills.
   */
  inputsAdded: Array<{ button: string; actionButtonId: string; names: string[]; agree: number; seen: number }>;
  /**
   * Buttons whose `actionButtonId` we DEFAULTED from `actionId`.
   *
   * Reported separately because it is the one value here that is a guess rather
   * than an invariant — right 93.1% of the time, wrong the rest, and when it is
   * wrong the real value is unguessable. A reader should confirm these.
   */
  derivedId: Array<{ button: string; value: string }>;
  /** keys already set by the model, which we deliberately left alone */
  untouched: number;
}

/**
 * Fill missing boilerplate on every action button.
 *
 * Returns a deep copy; the caller's object is untouched, matching how template
 * porting behaves so the two post-processors compose predictably.
 */
export function completeActionButtons(
  settings: PageSettings, conv?: Conventions, contracts?: ContractLibrary,
): { settings: PageSettings; completion: ButtonCompletion } {
  const j = JSON.parse(JSON.stringify(settings)) as PageSettings;
  const completion: ButtonCompletion =
    { filled: [], derivedId: [], inputsAdded: [], untouched: 0 };

  // Athena put every button in the "General" group — 4 of 4 on the reference
  // page. The base tenant uses localised group labels instead, so this is a
  // client choice, not a platform fact, and it lives in config with the rest.
  const group = conv ? rule(conv, "actionGroupId") : undefined;

  for (const b of j.actionButtons ?? []) {
    const st = (b.settings ??= {}) as Record<string, unknown>;
    const name = String(st["name"] ?? b.id ?? "?");
    const added: string[] = [];

    // Invariants first, then the dominant-but-not-universal ones. Both are
    // filled because CMF serialises them on every button — leaving one out
    // produces an artifact CMF would not have written.
    for (const table of [ACTION_BUTTON_DEFAULTS, ACTION_BUTTON_CONVENTIONS]) {
      for (const [k, v] of Object.entries(table)) {
        if (k in st) { completion.untouched += 1; continue; }
        st[k] = v;
        added.push(k);
      }
    }

    if (group) {
      if ("actionGroupId" in st) completion.untouched += 1;
      else { st["actionGroupId"] = group.value; added.push("actionGroupId"); }
    }

    if (ACTION_BUTTON_ID_FOLLOWS_ACTION_ID) {
      const actionId = st["actionId"];
      if ("actionButtonId" in st) completion.untouched += 1;
      else if (typeof actionId === "string" && actionId) {
        st["actionButtonId"] = actionId;
        completion.derivedId.push({ button: name, value: actionId });
        added.push("actionButtonId");
      }
    }

    /* The input contract, AFTER `actionButtonId` has been settled above — that
       is the key the contract is held under, and deriving it first means a
       button that only carried `actionId` still gets its inputs. */
    const contract = contracts?.get(String(st["actionButtonId"] ?? ""));
    if (contract?.inputs?.length) {
      const declared = (st["inputs"] ??= []) as Array<Record<string, unknown>>;
      const have = new Set(declared.map((i) => String(i["name"] ?? "")));
      const missing = contract.inputs.filter((c) => !have.has(c.name));
      if (missing.length) {
        /* Appended, never reordered: an input the model declared keeps its
           position, because a link targets a port by name and a reader compares
           by eye. This ADDS what the action expects and corrects nothing. */
        for (const c of missing) declared.push(materialiseInput(c));
        completion.inputsAdded.push({
          button: name,
          actionButtonId: contract.actionButtonId,
          names: missing.map((c) => c.name),
          agree: contract.agree,
          seen: contract.seen,
        });
      }
    }

    if (added.length) completion.filled.push({ button: name, keys: added });
  }

  return { settings: j, completion };
}

/** One line per button for the run log, or nothing when there was nothing to do. */
export function formatButtonCompletion(c: ButtonCompletion): string[] {
  if (c.filled.length === 0 && c.inputsAdded.length === 0) return [];
  const lines: string[] = [];

  /* First, and in its own sentence: this is the one thing here that changes
     behaviour rather than serialisation. */
  for (const a of c.inputsAdded) {
    lines.push(`  action button ${a.button}: added input(s) ${a.names.join(", ")} — ` +
      `the contract ${a.actionButtonId} carries on ${a.agree} of ${a.seen} of your ` +
      `delivered buttons. A button missing an input its action expects does not render.`);
  }

  if (c.filled.length === 0) return lines;
  lines.push(`  action buttons: boilerplate filled on ${c.filled.length} button(s)`);
  for (const f of c.filled) lines.push(`      ${f.button}: +${f.keys.join(", ")}`);
  for (const d of c.derivedId) {
    lines.push(`      ${d.button}: actionButtonId derived from actionId ("${d.value}") — ` +
               `the convention on ~93% of live buttons`);
  }
  if (c.untouched) {
    lines.push(`    - ${c.untouched} key(s) the model had already set were left alone`);
  }
  return lines;
}
