/**
 * CLIENT CONVENTIONS — Athena's standards, loaded from config.
 *
 * Reads app/config/client-conventions.json, the SAME file the Python side reads.
 * Deliberately no second copy: these values decide whether an artifact is judged
 * acceptable, and two drifting copies would mean the two validators disagree
 * about what "correct" means.
 *
 * Conventions are NOT platform facts. `Custom`, `\Dashboards` and `Scope=General`
 * are choices a client made; another client would choose differently. Facts about
 * CMF itself live in platform.ts and cannot vary.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Level } from "./types";
import { ASSET_ROOT } from "./asset-root";

/* Resolved through the pipeline's asset root rather than this file's location:
   Next bundles server code, so a module's runtime path is a build artifact.
   See the note at the top of `generate/config.ts`. */
export const CONVENTIONS_PATH = join(
  ASSET_ROOT, "config", "client-conventions.json",
);

export interface ConventionRule {
  value: string;
  /** how loudly a breach is reported — a stated instruction FAILs, an observed habit WARNs */
  severity: Level;
  why: string;
}

export interface Conventions {
  client?: string;
  tenant?: string;
  [key: string]: ConventionRule | string | undefined | unknown;
}

export class ConventionsError extends Error {}

export function loadConventions(path: string = CONVENTIONS_PATH): Conventions {
  if (!existsSync(path)) {
    throw new ConventionsError(
      `client conventions not found at ${path} — the validator cannot judge naming, ` +
      `scope or revision without them`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Conventions;
}

/** The rule for a convention, or undefined when it is not configured. */
export function rule(cfg: Conventions, name: string): ConventionRule | undefined {
  const r = cfg[name];
  if (r && typeof r === "object" && "value" in r) {
    const c = r as ConventionRule;
    return { value: c.value, severity: c.severity ?? "WARN", why: c.why ?? "" };
  }
  return undefined;
}

/** convenience for callers that only need the path joined from a base */
export const conventionsIn = (dir: string): string => join(dir, "client-conventions.json");

/**
 * The client's page-class habit, told to the EXTRACT step in its own words.
 *
 * §1.2, and the trap is the NAME rather than the enum. `uiType` offers
 * `["Page","Wizard","Cluster","Step"]`; generating `CustomChangePriorityStep`
 * emitted `Step`, and Athena ships `Page`. It is not a schema error — `Step` is
 * real CMF, used 33 times on the live base tenant — it is that a page *named*
 * `…Step` reads as one, and this client authors their wizard steps as `Page`
 * hosted by a `UiPageWidget`.
 *
 * The convention has been in `client-conventions.json` with its evidence and its
 * WARN severity since 27 August and **nothing read it**, which is a config entry
 * doing no work at all. This is the reader.
 *
 * DERIVED, NOT WRITTEN. The value, the severity and the reasoning all come from
 * the config; point the file at a client who authors steps as `Step` and this
 * sentence changes with it. Returns `""` when the convention is absent, so the
 * prompt simply does not carry it.
 */
export function pageTypeBrief(cfg: Conventions): string {
  const r = rule(cfg, "wizardStepPageType");
  if (!r?.value) return "";
  const measured = (cfg["wizardStepPageType"] as { _alsoMeasured?: unknown })?._alsoMeasured;
  const counts = (measured as { deliveredInstancesByUiType?: Record<string, number> } | undefined)
    ?.deliveredInstancesByUiType;
  const tally = counts
    ? ` Across every page this client has delivered: ` +
      Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") + `.`
    : "";
  return (
    `PAGE CLASS — a page NAMED "...Step" is not necessarily uiType "Step".\n` +
    `This client authors a wizard's step page as uiType "${r.value}", hosted inside ` +
    `the wizard by a UiPageWidget.${tally} "Step" is valid CMF and the platform ` +
    `itself uses it, so this is a habit of theirs and not a rule of the format — ` +
    `follow it unless the requirement document says otherwise, and say so in the ` +
    `gap report if you depart from it.`
  );
}

/**
 * Apply the client's artifact-name prefix, when they require one (T-25).
 *
 * WHY CODE AND NOT THE PROMPT
 *   The page name is a PLACEHOLDER our assembler substitutes — the model never
 *   writes it. So `name carries <prefix> prefix` is a FAIL the model **cannot
 *   fix**, and feeding it back burns every remaining attempt regenerating a page
 *   body that was never the problem. A mechanical convention belongs in code, for
 *   the same reason `$id` does.
 *
 * Only applied when the rule's severity is FAIL — i.e. the client stated it as an
 * instruction rather than us observing it as a habit. A WARN-level convention is
 * a preference, and silently renaming someone's artifact over a preference would
 * be wrong.
 *
 * Returns the name unchanged when no prefix is required, when it already carries
 * one, or when the caller passed nothing.
 */
export function applyNamePrefix(
  cfg: Conventions, name: string,
): { name: string; changed: boolean; prefix?: string } {
  const r = rule(cfg, "namePrefix");
  if (!r?.value || r.severity !== "FAIL") return { name, changed: false };
  if (!name || name.startsWith(r.value)) return { name, changed: false };
  return { name: `${r.value}${name}`, changed: true, prefix: r.value };
}

/**
 * The client's name, for text we generate — prompt sections, reports, the PRD.
 *
 * "Athena" was written into source in several places, which is the same mistake
 * as any other case-specific literal: a second client would need a code edit to
 * stop being called Athena. The name is already declared in
 * `client-conventions.json`, so read it from there.
 *
 * Falls back to a neutral phrase rather than a placeholder, so a config without a
 * client still produces a sentence that reads correctly.
 */
export function clientName(cfg: Conventions): string {
  const c = cfg.client;
  return typeof c === "string" && c.trim() ? c.trim() : "the client";
}
