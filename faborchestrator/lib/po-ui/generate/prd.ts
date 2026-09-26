/**
 * PRD GENERATOR — Phase 1(b), the brainstorming step.
 *
 * Athena's scope document asks for exactly three things, and the section layout
 * below is built to their sentence rather than to a generic PRD template:
 *
 *   > "take a requirement document of a UI screen and create a PRD document
 *   >  explaining WHAT THE UI SCREEN SHOULD DO, give a ROUGH OUTLINE OF WHAT THE
 *   >  SCREEN SHOULD LOOK LIKE, and give the LIST OF BACKEND CUSTOMIZATION are
 *   >  needed to build this screen. This is the initial 'brain storming' where the
 *   >  user can give more detail and feedback if needed. This should be in text
 *   >  form as well as be put in a downloadable document."
 *
 * THE SAME DIVISION OF LABOUR AS EVERYTHING ELSE HERE
 *   The model writes the prose that needs judgement — what the screen is for, the
 *   functional flow, assumptions. OUR CODE writes every fact: the page inventory,
 *   the column tables, the screen outline, and the backend list. Those are all
 *   derivable from the descriptor, and deriving them means the PRD cannot claim
 *   the screen has a column the descriptor does not.
 *
 * WHY THE PRD IS BUILT FROM THE DESCRIPTOR, NOT FROM A GENERATED ARTIFACT
 *   This step comes BEFORE generation — it is the brainstorm the user reacts to.
 *   The descriptor is the only structured statement of the request that exists at
 *   that point, and it is the same contract the artifact is later graded against,
 *   so the PRD and the artifact cannot describe different screens.
 */
import { effectiveSpec, queryDefinitionFor,
         type PageSpecType, type SpecDescriptor } from "../descriptor";
import { inputPortsOf } from "./query";
import { clientName, loadConventions } from "../conventions";

/* ------------------------------------------------------------------ narrative */

/**
 * The parts only a human reader's judgement can supply, which we ask the model
 * for. Deliberately prose-only: no columns, no paths, no CMF encodings. Those are
 * facts, and facts come from the descriptor.
 */
export interface PrdNarrative {
  /** 2–4 sentences: what the screen is for and who uses it */
  summary: string;
  goals: string[];
  /** the end-to-end flow, one step per entry */
  functionalFlow: string[];
  /**
   * One line on what each page is for.
   *
   * An array of pairs rather than a `{page: purpose}` map because structured
   * output requires `additionalProperties: false`, which rules out a free-form
   * keyed object. The array carries the same information and validates.
   */
  pagePurpose: Array<{ page: string; purpose: string }>;
  assumptions: string[];
  openQuestions: string[];
  /** things a reader might expect that the document did NOT ask for */
  outOfScope: string[];
}

export const EMPTY_NARRATIVE: PrdNarrative = {
  summary: "", goals: [], functionalFlow: [], pagePurpose: [],
  assumptions: [], openQuestions: [], outOfScope: [],
};

/** JSON Schema for the narrative call. Kept beside the type it describes. */
export const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "goals", "functionalFlow", "pagePurpose",
             "assumptions", "openQuestions", "outOfScope"],
  properties: {
    summary: { type: "string" },
    goals: { type: "array", items: { type: "string" } },
    functionalFlow: { type: "array", items: { type: "string" } },
    pagePurpose: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["page", "purpose"],
        properties: { page: { type: "string" }, purpose: { type: "string" } },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
  },
} as const;

/* ------------------------------------------------------- the screen outline */

const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" };

/** pad/trim a line to exactly `w` visible characters */
function fit(s: string, w: number): string {
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s.padEnd(w);
}

/**
 * "A rough outline of what the screen should look like" — their words, so it is
 * deliberately a sketch and not our wireframe renderer.
 *
 * Drawn from the descriptor alone: no geometry has been decided at PRD time, and
 * inventing a pixel layout here would commit us to a design the requirement
 * document did not ask for. Order is action bar, forms, then grids, which is the
 * order every page we hold is built in.
 */
export function renderOutline(page: PageSpecType, width = 74): string {
  const inner = width - 4;
  const lines: string[] = [];
  const rule = (l: string, r: string): string => l + BOX.h.repeat(width - 2) + r;
  const row = (s: string): string => `${BOX.v} ${fit(s, inner)} ${BOX.v}`;

  lines.push(rule(BOX.tl, BOX.tr));
  lines.push(row(`${page.name}   [${page.uiType}]`));
  lines.push(rule(BOX.ml, BOX.mr));

  if (page.actionButtons.length) {
    lines.push(row(page.actionButtons.map((b) => `[ ${b.name} ]`).join("  ")));
    lines.push(row("(action bar — CMF also supplies New / Refresh / Lock / More)"));
    lines.push(rule(BOX.ml, BOX.mr));
  }

  page.forms.forEach((f) => {
    lines.push(row(f.purpose ? `Form — ${f.purpose}` : "Form"));
    lines.push(row("  " + f.fields.map((x) => `${x.label}: [____]`).join("   ")));
    lines.push(rule(BOX.ml, BOX.mr));
  });

  page.grids.forEach((g, i) => {
    const sel = g.selection === "multiple" ? "multi-select"
      : g.selection === "single" ? "single-select" : "no selection";
    lines.push(row(`Grid ${i + 1} — ${g.entity}  (${sel}, ${g.columns.length} columns)`));
    lines.push(row("  " + g.columns.map((c) => c.name + (c.link ? "*" : "")).join(" | ")));
    lines.push(rule(BOX.ml, BOX.mr));
  });

  lines[lines.length - 1] = rule(BOX.bl, BOX.br);
  if (page.grids.some((g) => g.columns.some((c) => c.link))) {
    lines.push("  * link column");
  }
  return lines.join("\n");
}

/* --------------------------------------------------- backend customization */

export interface BackendItem {
  kind: "Query" | "Custom API" | "Localized messages" | "Permissions" | "Prerequisite";
  name: string;
  /** what has to be built, in a sentence */
  detail: string;
  /** can we generate it today? */
  status: "generated" | "needs input" | "manual";
  note?: string;
}

/**
 * "The list of backend customization needed to build this screen."
 *
 * Every row is derived, never guessed — and each says whether WE can produce it,
 * which is the part a reader actually needs. A query we hold structure for is
 * generated; a query named but never described is a gap, and saying so here is
 * the same refusal-to-invent the generator applies.
 */
export function backendItems(
  d: SpecDescriptor, page: PageSpecType, client = "the client",
): BackendItem[] {
  const out: BackendItem[] = [];
  const spec = effectiveSpec(d, page);

  for (const name of spec.queries) {
    const def = queryDefinitionFor(d, name);
    if (!def) {
      out.push({
        kind: "Query", name, status: "needs input",
        detail: "named by the requirement document, but its returned fields and filters are not stated",
        note: "We will not generate it without those, because a guessed query body imports cleanly and returns the wrong rows.",
      });
      continue;
    }
    const ports = inputPortsOf(def);
    out.push({
      kind: "Query", name, status: "generated",
      detail: `returns ${plural(def.fields.length, "field")} from ${def.entity}` +
        (def.filters.length ? `, ${plural(def.filters.length, "filter")}` : "") +
        (def.joins?.length ? `, ${plural(def.joins.length, "join")}` : ""),
      note: ports.length
        ? `exposes ${plural(ports.length, "data-source input port")} — ${ports.join(", ")} — and the page's links must bind to those exact names`
        : "no parameters",
    });
  }

  for (const name of d.api ?? []) {
    out.push({
      kind: "Custom API", name, status: "manual",
      detail: "custom C# service — controller, interface, orchestration and Input/Output DTOs",
      note: `Not generated today. ${client} has supplied a reference implementation; ` +
            "the project layout and constants module are still to be confirmed.",
    });
  }

  // Every user-visible label in CMF is a $(MessageName) reference (Rule 2), so a
  // new screen always implies message authoring. Counting them is a real number a
  // reader can plan against.
  const labels =
    page.grids.reduce((n, g) => n + g.columns.length, 0) +
    page.forms.reduce((n, f) => n + f.fields.length, 0) +
    page.actionButtons.length;
  if (labels) {
    out.push({
      kind: "Localized messages", name: plural(labels, "label"), status: "needs input",
      detail: "every user-visible label is a $(MessageName) reference, not plain text",
      note: "Authored under Administration → Localized Messages → Create, Type = Message. " +
            "Any name not already in the vocabulary is emitted as $(UNKNOWN_<Field>) and reported.",
    });
  }

  const gated = page.actionButtons.filter((b) => !b.opensPage);
  if (gated.length) {
    out.push({
      kind: "Permissions", name: plural(gated.length, "action button"), status: "needs input",
      detail: "buttons that invoke an action may need a requiredFunctionality (CMF's permission unit)",
      note: `On ${client}'s reference page some action buttons carry a requiredFunctionality ` +
            "and others carry none — so this is per-button and must be confirmed.",
    });
  }

  out.push({
    kind: "Prerequisite", name: "Change Set", status: "manual",
    detail: "a UI page cannot be created in CMF without an active Change Set",
    note: "Type General is recommended. If 'Make Change Set Items Effective on Approval' is set, " +
          "nothing applies until approved, and once effective it cannot be edited.",
  });

  return out;
}

/** display order — what a reader plans against first comes first */
const KIND_ORDER: Record<BackendItem["kind"], number> = {
  "Query": 0, "Custom API": 1, "Localized messages": 2,
  "Permissions": 3, "Prerequisite": 4,
};

/**
 * The backend list for the WHOLE story, not one page.
 *
 * §3 answers "what backend work does this screen need", and a story routinely asks
 * for several pages, so the counts must be totals. Calling `backendItems` per page
 * and concatenating produced two "Localized messages" rows — "2 label(s)" and
 * "20 label(s)" — which reads as a defect rather than as a per-page breakdown.
 * Counted items are summed; named items are deduplicated.
 */
export function backendPlan(d: SpecDescriptor, client = "the client"): BackendItem[] {
  const named = new Map<string, BackendItem>();
  let labels = 0;
  let gatedButtons = 0;
  let labelNote = "";
  let permNote = "";

  for (const p of d.pages) {
    for (const it of backendItems(d, p, client)) {
      if (it.kind === "Localized messages") {
        labels += parseInt(it.name, 10) || 0;
        labelNote = it.note ?? "";
        continue;
      }
      if (it.kind === "Permissions") {
        gatedButtons += parseInt(it.name, 10) || 0;
        permNote = it.note ?? "";
        continue;
      }
      const key = `${it.kind}:${it.name}`;
      if (!named.has(key)) named.set(key, it);
    }
  }

  const out = [...named.values()];
  if (labels) {
    out.push({
      kind: "Localized messages", name: plural(labels, "label"), status: "needs input",
      detail: "every user-visible label is a $(MessageName) reference, not plain text",
      note: labelNote,
    });
  }
  if (gatedButtons) {
    out.push({
      kind: "Permissions", name: plural(gatedButtons, "action button"), status: "needs input",
      detail: "buttons that invoke an action may need a requiredFunctionality (CMF's permission unit)",
      note: permNote,
    });
  }

  return out.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ assembly */

export interface PrdInput {
  descriptor: SpecDescriptor;
  narrative: PrdNarrative;
  /** where the requirement came from, for the provenance line */
  source: string;
  /** injected so the document is reproducible in tests */
  generatedAt?: string;
}

const bullets = (xs: readonly string[], fallback: string): string =>
  xs.length ? xs.map((x) => `- ${x}`).join("\n") : `_${fallback}_`;

export function buildPrd(input: PrdInput): string {
  const { descriptor: d, narrative: n } = input;
  const when = input.generatedAt ?? new Date().toISOString().slice(0, 10);
  const title = d.title ?? d.pages[0]?.name ?? "UI screen";

  const s: string[] = [];
  s.push(`# PRD — ${title}`);
  s.push("");
  s.push(`**User story ${d.userStory}** · drafted ${when} from \`${input.source}\``);
  s.push("");
  s.push("> **This is a draft for discussion, not a specification.** It restates the requirement");
  s.push("> document so it can be argued with before anything is built. Every fact below is either");
  s.push("> stated in that document or measured from CMF; nothing is invented. Where the document");
  s.push("> is silent, §5 says so rather than filling the gap.");
  s.push("");

  // ---------------------------------------------------------------- 1
  s.push("## 1. What this screen should do");
  s.push("");
  s.push(n.summary || "_The requirement document does not state an overall purpose._");
  s.push("");
  if (n.goals.length) {
    s.push("**Goals**");
    s.push("");
    s.push(bullets(n.goals, ""));
    s.push("");
  }
  if (n.functionalFlow.length) {
    s.push("**Functional flow**");
    s.push("");
    n.functionalFlow.forEach((step, i) => s.push(`${i + 1}. ${step}`));
    s.push("");
  }

  // ---------------------------------------------------------------- 2
  s.push("## 2. The screens");
  s.push("");
  s.push(`The requirement document asks for **${plural(d.pages.length, "page")}**.`);
  s.push("");

  d.pages.forEach((p, i) => {
    s.push(`### 2.${i + 1} ${p.name} — ${p.uiType}`);
    s.push("");
    const purpose = n.pagePurpose.find((x) => x.page === p.name)?.purpose;
    if (purpose) { s.push(purpose); s.push(""); }
    if (p.uiType === "Wizard") {
      s.push("_A Wizard renders as a modal dialog, not a full page._");
      s.push("");
    }

    s.push("**Rough outline**");
    s.push("");
    s.push("```");
    s.push(renderOutline(p));
    s.push("```");
    s.push("");

    p.grids.forEach((g, gi) => {
      s.push(`**Grid ${gi + 1} — ${g.entity}** (${g.selection} selection, ${plural(g.columns.length, "column")})`);
      s.push("");
      s.push("| # | Column | Link | Target entity | Type stated |");
      s.push("|---|---|---|---|---|");
      g.columns.forEach((c, ci) => {
        s.push(`| ${ci + 1} | ${c.name} | ${c.link ? "yes" : ""} | ${c.entity ?? ""} | ${c.scalarType ?? ""} |`);
      });
      s.push("");
    });

    p.forms.forEach((f, fi) => {
      s.push(`**Form ${fi + 1}${f.purpose ? ` — ${f.purpose}` : ""}** (${plural(f.fields.length, "field")})`);
      s.push("");
      s.push("| Field | Type | Entity |");
      s.push("|---|---|---|");
      f.fields.forEach((x) => s.push(`| ${x.label} | ${x.scalarType} | ${x.entity ?? ""} |`));
      s.push("");
    });

    if (p.actionButtons.length) {
      s.push("**Action buttons**");
      s.push("");
      s.push("| Button | Opens | Calls |");
      s.push("|---|---|---|");
      p.actionButtons.forEach((b) =>
        s.push(`| ${b.name} | ${b.opensPage ?? ""} | ${b.dataSource ?? ""} |`));
      s.push("");
      s.push("_CMF supplies New, Refresh, Lock and More on every page; those are not listed here " +
             "and must not be built._");
      s.push("");
    } else {
      s.push("_No action buttons requested._");
      s.push("");
    }
  });

  // ---------------------------------------------------------------- 3
  s.push("## 3. Backend customization required");
  s.push("");
  s.push("| What | Item | Status | Detail |");
  s.push("|---|---|---|---|");
  const plan = backendPlan(d, clientName(loadConventions()));
  for (const it of plan) {
    s.push(`| ${it.kind} | \`${it.name}\` | ${statusLabel(it.status)} | ${it.detail} |`);
  }
  s.push("");
  const notes = new Set<string>();
  for (const it of plan) {
    if (it.note) notes.add(`**${it.name}** — ${it.note}`);
  }
  if (notes.size) {
    s.push("**Notes**");
    s.push("");
    s.push([...notes].map((x) => `- ${x}`).join("\n"));
    s.push("");
  }

  /* ------------------------------------------------------------- 3b
   *
   * THE WORDS, AND WHAT THEY WERE TAKEN TO MEAN.
   *
   * Requirement documents are written in the client's words and CMF stores its
   * properties under its own. That resolution is the single most frequent thing
   * this tool has had to ask about — 18 of 19 gap reports — and it used to
   * happen invisibly at generation time, where nobody could correct it.
   *
   * Put in front of Assumptions on purpose: a wrong mapping is not an
   * assumption, it is a defect that will validate as correct and be delivered.
   * The reader can only catch it if they are shown it, in their own words,
   * beside the evidence.
   *
   * DERIVED, like every other fact in this document — the narrative model never
   * sees this section, it is read straight off the descriptor.
   */
  const terms = d.termPaths ?? [];
  if (terms.length) {
    s.push("## 3b. What each word was taken to mean");
    s.push("");
    s.push("The requirement document's wording on the left, the CMF property it was resolved to " +
           "on the right, and the evidence for each. **Check this before anything is built** — a " +
           "wrong path here produces a page that imports cleanly and shows the wrong rows.");
    s.push("");
    s.push("| The document says | CMF path | Evidence |");
    s.push("|---|---|---|");
    for (const t of terms) {
      /* An unresolved term is called out rather than left blank: a blank cell
         reads as "nothing to see", and this is the row most worth reacting to. */
      const path = t.path ? `\`${t.path}\`` : "**not resolved**";
      s.push(`| ${t.term} | ${path} | ${t.why} |`);
    }
    s.push("");
    const unresolved = terms.filter((t) => !t.path);
    if (unresolved.length) {
      s.push(`**${unresolved.length} of ${terms.length} could not be resolved from evidence** ` +
             `and are carried into the open questions below. Nothing was guessed to fill them.`);
      s.push("");
    }
  }

  // ---------------------------------------------------------------- 4
  s.push("## 4. Assumptions");
  s.push("");
  s.push(bullets(n.assumptions, "None recorded."));
  s.push("");

  // ---------------------------------------------------------------- 5
  s.push("## 5. Open questions");
  s.push("");
  s.push("These are things the requirement document does not settle. **This is the part to react " +
         "to** — answering them here is cheaper than discovering them after the screen is built.");
  s.push("");
  const questions = [...(d.notes ?? []), ...n.openQuestions];
  s.push(bullets(questions, "None — unusual for a requirement document, and worth double-checking."));
  s.push("");

  // ---------------------------------------------------------------- 6
  s.push("## 6. Not requested");
  s.push("");
  s.push("Recorded so their absence is a decision rather than an oversight. **None of these will be " +
         "built unless the requirement document is updated to ask for them.**");
  s.push("");
  s.push(bullets(n.outOfScope, "Nothing noted."));
  s.push("");

  return s.join("\n");
}

function statusLabel(s: BackendItem["status"]): string {
  return s === "generated" ? "**we generate this**"
    : s === "needs input" ? "needs input"
    : "manual";
}

/* ---------------------------------------------------------------- download */

/**
 * "…as well as be put in a downloadable document."
 *
 * Self-contained HTML: it opens in a browser, prints to PDF, and Word opens it
 * directly, so one file covers every way a reader is likely to want it. No
 * external stylesheet or font — the same constraint the preview renderer works
 * under, and it keeps the file readable offline.
 *
 * Styling follows the project's document conventions (Calibri, navy headings) so
 * a PRD looks like the rest of what Athena receives from us.
 */
export function prdHtml(markdown: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
 body{font-family:Calibri,Segoe UI,sans-serif;font-size:10.5pt;line-height:1.45;color:#1a1a1a;
      max-width:900px;margin:0 auto;padding:32px}
 h1{font-size:20pt;color:#1F3864;margin:0 0 4px}
 h2{font-size:15pt;color:#1F3864;margin:26px 0 8px;border-bottom:1px solid #d4d4d8;padding-bottom:3px}
 h3{font-size:12pt;color:#1F3864;margin:18px 0 6px}
 table{border-collapse:collapse;width:100%;margin:10px 0;font-size:9pt}
 th{background:#1F3864;color:#fff;text-align:left;padding:5px 8px;font-size:9.5pt}
 td{border:1px solid #d4d4d8;padding:4px 8px;vertical-align:top}
 pre{background:#f6f6f7;border:1px solid #d4d4d8;padding:10px;overflow-x:auto;
     font-family:Consolas,monospace;font-size:9pt;line-height:1.3}
 blockquote{border-left:3px solid #1F3864;background:#f2f5fa;margin:12px 0;padding:9px 14px}
 code{font-family:Consolas,monospace;font-size:9.5pt;background:#f6f6f7;padding:1px 4px}
 pre code{background:none;padding:0}
 @media print{body{padding:0} h2{page-break-after:avoid}}
</style></head><body>
${mdToHtml(markdown)}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Just enough Markdown for the documents WE generate — headings, tables, lists,
 * fenced blocks, blockquotes, bold and inline code.
 *
 * Deliberately not a general Markdown implementation and not a dependency: this
 * only ever renders `buildPrd()`'s own output, whose shape is fixed above. If the
 * PRD grows a construct, it gets added here rather than pulling in a parser.
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  let inList = false;
  const closeList = (): void => { if (inList) { out.push("</ul>"); inList = false; } };

  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/_([^_]+)_/g, "<em>$1</em>");

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      closeList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) { body.push(lines[i] ?? ""); i += 1; }
      i += 1;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // table: a header row followed by a |---| separator
    if (line.startsWith("|") && (lines[i + 1] ?? "").startsWith("|") && /^\|[\s|:-]+\|$/.test(lines[i + 1] ?? "")) {
      closeList();
      const cells = (r: string): string[] =>
        r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) { rows.push(cells(lines[i] ?? "")); i += 1; }
      out.push("<table><thead><tr>" + head.map((h) => `<th>${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>");
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h?.[1] && h[2] !== undefined) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i += 1;
      continue;
    }

    if (line.startsWith("> ") || line === ">") {
      closeList();
      const body: string[] = [];
      while (i < lines.length && ((lines[i] ?? "").startsWith("> ") || lines[i] === ">")) {
        body.push((lines[i] ?? "").replace(/^>\s?/, "")); i += 1;
      }
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      i += 1;
      continue;
    }

    const ol = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ol?.[2]) {
      closeList();
      out.push(`<p><strong>${ol[1]}.</strong> ${inline(ol[2])}</p>`);
      i += 1;
      continue;
    }

    if (line.trim() === "") { closeList(); i += 1; continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  closeList();
  return out.join("\n");
}
