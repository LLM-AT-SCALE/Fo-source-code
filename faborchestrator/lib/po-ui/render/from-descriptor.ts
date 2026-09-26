/**
 * DESCRIPTOR → PREVIEW, without generating anything.
 *
 * WHY THIS EXISTS
 *   The preview has always rendered a GENERATED artifact, which means waiting for
 *   a full generation run — minutes, and a paid call — before anyone can see the
 *   screen. Athena's team asked to see the layout at **PRD time**, while the
 *   requirement is still being argued about, and for it to move as the PRD is
 *   tweaked. That is only possible if the preview comes from the descriptor.
 *
 *   The descriptor already holds what a structural preview needs: which grids,
 *   in what order, with which columns and selection mode; which form fields;
 *   which buttons. `renderOutline()` in prd.ts draws exactly that as ASCII. This
 *   draws it as the real thing.
 *
 * DETERMINISTIC AND FREE — no model call. That is the whole point: it can run on
 * every keystroke of PRD feedback without costing anything.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 *   A descriptor speaks the STORY's language, not CMF's. It has no data paths and
 *   no `PfT` type codes — those are decided during generation, from the dictionary
 *   and the entity schema, and inventing them here would be exactly the guessing
 *   the whole pipeline refuses to do.
 *
 *   So this renders **structure, not the final artifact**: real column headers in
 *   the story's words, plausible cell shapes from `scalarType`, and the CMF
 *   chrome around them. Every caller must label it as a structural preview — see
 *   `DESCRIPTOR_PREVIEW_NOTE`.
 */
import { SELECTION_MODE, TYPE_CODE } from "../platform";
import type { PageSpecType, SpecDescriptor } from "../descriptor";
import type { PageJson } from "./preview";

/** Shown with every descriptor-sourced preview so it is never mistaken for the artifact. */
export const DESCRIPTOR_PREVIEW_NOTE =
  "Structural preview, drawn from the requirement — not a generated artifact. " +
  "Column headers are the story's words; data paths and CMF type codes are " +
  "decided during generation.";

/**
 * A story's `scalarType` mapped to the UI column code, so cells render in a
 * plausible shape (dates as dates, booleans as ticks).
 *
 * The mapping is the OBVIOUS one and is only ever used for drawing. Generation
 * does not consult it: there the code comes from `ENTITY-TYPES.md` and the
 * samples, where a Decimal quantity may legitimately render as Integer (F-148).
 */
const SCALAR_TO_CODE: Record<string, number> = {
  String: TYPE_CODE.String,
  Integer: TYPE_CODE.Integer,
  Boolean: TYPE_CODE.Boolean,
  DateTime: TYPE_CODE.DateTime,
  Decimal: TYPE_CODE.Decimal,
  Reference: TYPE_CODE.Reference,
};

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "") || "x";

/**
 * What SHAPE should this cell be drawn as?
 *
 * Measured on the real corpus: the extractor records `scalarType` only when the
 * story states one, and Athena's stories state it for form fields but almost
 * never for grid columns — **0 of 15** on US-455386. Defaulting all of them to
 * String made every cell render the same three placeholder strings, which tells
 * a reviewer nothing about the screen.
 *
 * So where the story is silent, the column's own NAME decides how the cell is
 * DRAWN. This is presentation only and never leaves this module: generation
 * takes its type codes from `ENTITY-TYPES.md` and the samples, where a Decimal
 * quantity may legitimately render as Integer (F-148). Nothing here is written
 * into an artifact, and no data path is invented — `path` stays empty.
 */
function displayType(name: string, scalarType?: string, link?: boolean): number {
  if (scalarType && SCALAR_TO_CODE[scalarType] !== undefined) {
    return SCALAR_TO_CODE[scalarType] as number;
  }
  const n = name.toLowerCase();
  if (/date|time$/.test(n)) return TYPE_CODE.DateTime;
  if (/^is[A-Z]|^is[a-z]|^has|flag$/.test(name) || /^is/.test(n)) return TYPE_CODE.Boolean;
  if (/count$|quantity|qty|priority/.test(n)) return TYPE_CODE.Integer;
  // a column the story marked "(link)" points at another record
  if (link) return TYPE_CODE.Reference;
  return TYPE_CODE.String;
}

/**
 * Build a PageJson the preview renderer understands.
 *
 * Widgets are laid out in the order a real page reads: FILTERS first, then any
 * other form, then the grids they narrow, then body controls.
 *
 * Filters lead because that is what "at the top of the page" means in a
 * requirement, and US-1122 says exactly that. They used to be rendered nowhere
 * at all, and when they were added they landed after `forms` — so the feeder
 * selector sat above the filters and the preview contradicted the document it
 * was drawn from — the order `renderOutline()` already uses, and the order every page we
 * hold is built in.
 */
export function pageJsonFromDescriptor(page: PageSpecType, columns = 6): PageJson {
  const widgets: PageJson["widgets"] = [];
  const placements: Array<Record<string, unknown>> = [];
  let row = 0;

  const place = (id: string): void => {
    placements.push({ id, column: 0, columnSpan: columns, row, rowSpan: 1, panel: 2 });
    row += 1;
  };

  /*
   * The grids are BUILT here and PLACED below, after the filter panel, so that
   * nothing lands between a set of filter fields and the rows they narrow.
   *
   * That ordering was the original defect: whatever came next - on US-1122 the
   * Feeder Resource form - was placed between the two, and the PRD screen read
   * as a different page from the artifact preview of the same spec.
   */
  const gridWidgets = (page.grids ?? []).map((grid, i) => ({
    id: `pv_g${i}`,
    name: "Grid",
    settings: {
      // the entity is the best name we have at this stage; the generated page
      // will carry whatever the GUI-test selectors require (A-53)
      name: grid.entity,
      title: grid.role ? `${grid.entity} - ${grid.role}` : grid.entity,
      selectionMode: SELECTION_MODE[grid.selection ?? "none"],
      columns: (grid.columns ?? []).map((c) => ({
        name: c.name,
        // NO path: the descriptor does not hold one, and inventing it here
        // would be the guessing this pipeline exists to refuse
        path: "",
        type: { type: displayType(c.name, c.scalarType, c.link) },
      })),
    },
    entity: grid.entity,
  }));

  /*
   * FORMS FIRST, AND NEVER BENEATH A GRID.
   *
   * MEASURED ACROSS THE DELIVERED CORPUS, 2026-09-02. Fourteen delivered pages
   * carry both a form and a grid, and NOT ONE of them puts the form below the
   * grid in the same column:
   *
   *   300_CustomProductionOrderManagementUI  forms row 1     grids row 2
   *   UI_Page_Load Materials to Feeder       forms row 1     Filter+grid row 3
   *   TransferTote (x3)                      forms rows 1-2  grid at COLUMN 11
   *   BinInventory, MaterialReattachment,
   *   ChangePriorityStep, PayloadConsolidation   forms row 1  grids row 2+
   *
   * Reading the layout array in order says otherwise, and that reading is what
   * misled an earlier pass of this file: `layouts[].widgets[]` carries explicit
   * `position: {row, column, panel}`, so array order is NOT visual order. On the
   * POManagement page the fourth entry is a form at row 1 COLUMN 9 - beside the
   * first form, forming the filter bar, not underneath the grids. On TransferTote
   * the grid is at column 11 spanning eleven rows, beside the forms rather than
   * below them.
   *
   * This ordering is what the engineer reported on 2026-09-02: for US-455386 the
   * PRD screen drew the filter bar UNDER the grid and the generated page put it
   * on top. Both stages were behaving correctly. The descriptor was ambiguous -
   * the extractor had filed the filter bar under `forms[]` with the purpose
   * "Filter production orders" and left `filters[]` null - and this renderer
   * draws `filters` above the grids and `forms` below them, so which bucket the
   * extractor happened to pick decided the layout.
   *
   * Drawing forms first removes that dependency: THE FIELDS SIT ABOVE THE LIST
   * WHICHEVER BUCKET THE PANEL LANDS IN, so the two stages agree by construction
   * rather than by the extractor guessing well.
   */
  for (const [i, form] of (page.forms ?? []).entries()) {
    const id = `pv_f${i}`;
    widgets.push({
      id, name: "Form",
      settings: {
        /* NOT "Filter" as a default. A form whose purpose the story never
           stated is an unnamed form, and labelling it a filter was this
           renderer asserting a role the descriptor does not record - the same
           mistake, one layer down. */
        name: form.purpose ?? "Form",
        fields: (form.fields ?? []).map((f) => ({
          property: { label: f.label, name: slug(f.label) },
          // the renderer reads the same type codes as a real page
          type: { type: SCALAR_TO_CODE[f.scalarType ?? "String"] ?? TYPE_CODE.String },
        })),
      },
    });
    place(id);
  }

  /*
   * FILTERS. The descriptor has carried these since 2026-08-28 (F-177) and this
   * renderer never read them.
   *
   * Measured on US-1122, whose document opens with "add the following filter
   * fields at the top of the page": the PRD-stage preview showed the grid and
   * the feeder field and NO FILTERS AT ALL. The engineer approves the spec at
   * that screen, so the headline requirement was invisible at exactly the
   * moment it was supposed to be checked — and it then appeared after
   * generation, which is what made the two stages look like different screens.
   *
   * DRAWN AS FIELDS, WITHOUT CHOOSING A MECHANISM - and that is the whole point.
   *
   * An earlier version rendered every filter panel as a CMF `Filter` widget
   * HOSTING the grid it narrows, because the page that exposed the bug is built
   * that way. It made the two stages agree on that page and disagree on the
   * next one: US-455386 says "Add a Form Widget", the generator correctly emits
   * a `Form`, and the PRD screen drew a bordered `Filter` box wrapping the grid
   * that the generated screen does not have. Measured 2026-09-02, and visible
   * to a reader - which is the only kind of difference that matters here.
   *
   * `FilterPanel` says so itself: "The target platform has two ways to build
   * this and the corpus uses both - 41 Forms over 12 pages, 8 Filter widgets
   * over 5 - so the descriptor deliberately does NOT choose one." A renderer
   * reading that descriptor may not choose either. The mechanism is picked at
   * GENERATION, from evidence the PRD stage does not have.
   *
   * So the panel is drawn the way both mechanisms LOOK: the fields, above the
   * list they narrow. A `Form` renders exactly that. A `Filter` widget renders
   * its bar above its hosted grid, which is the same picture. The reader sees
   * the same screen at both stages whichever the generator picks, and the
   * preview stops asserting a structure it cannot know.
   */
  for (const [i, panel] of (page.filters ?? []).entries()) {
    const id = `pv_flt${i}`;
    widgets.push({
      id, name: "Form",
      settings: {
        name: `${panel.entity} filter`,
        /* The story's own words. A descriptor deliberately holds no CMF path,
           and the message name is decided at generation - so the label is the
           term the document used, which is what the reader is checking. */
        fields: (panel.fields ?? []).map((f) => ({
          property: { label: f, name: slug(f) },
          type: { type: TYPE_CODE.String },
        })),
      },
    });
    place(id);
  }

  /*
   * THE GRIDS COME LAST, directly beneath the filter panel.
   *
   * A filter panel narrows a list, so the list belongs immediately under it with
   * nothing in between - on US-1122 the Feeder Resource form used to land there,
   * which the delivered page never does. The other forms are already placed
   * above, which is where the corpus puts them, so the filter bar and its rows
   * stay adjacent.
   */
  for (const g of gridWidgets) {
    widgets.push({ id: g.id, name: g.name, settings: g.settings });
    place(g.id);
  }

  /*
   * WHERE THE BUTTON IS, because the specification says and the preview should
   * show it.
   *
   * Every button was mapped into `actionButtons` — the ribbon along the top —
   * regardless of what the descriptor said. So US-1122's Attach, which the
   * story places beside the grid and which the descriptor records as
   * `control.placement: "screen"`, appeared in the action bar at PRD time and
   * in the page body after generation: the same button in two different places
   * across the two stages.
   *
   * `screen` is the only value that means the body; omitted means the story did
   * not say, and the action bar is then the majority reading — 679 delivered
   * action-bar entries against 18 body buttons.
   */
  const bodyButtons = (page.actionButtons ?? [])
    .filter((b) => b.control?.placement === "screen");
  for (const [i, b] of bodyButtons.entries()) {
    const id = `pv_btn${i}`;
    widgets.push({
      id, name: "Button",
      settings: { name: b.name, inputs: (b.control?.inputs ?? []).map((n) => ({ name: n })) },
    });
    place(id);
  }

  return {
    layouts: [{ id: "main", columns, widgets: placements }],
    widgets,
    actionButtons: (page.actionButtons ?? [])
      .filter((b) => b.control?.placement !== "screen")
      .map((b, i) => ({
        id: `pv_b${i}`,
        settings: { name: b.name, buttonTitle: b.name, actionId: "", actionButtonId: "" },
      })),
    dataSources: [],
    links: [],
  };
}

/** Pick the page to preview: the named one, else the story's last (the main screen). */
export function pageToPreview(
  d: SpecDescriptor, pageName?: string,
): PageSpecType | undefined {
  if (pageName) {
    const hit = d.pages.find((p) => p.name === pageName);
    if (hit) return hit;
  }
  /*
   * The MAIN SCREEN, not the last page.
   *
   * This returned `pages[pages.length - 1]`, on the reasoning that a story's
   * last page is its main one. That holds for a single-page story and fails for
   * every other kind: US-455386 produces the management page, a wizard, and the
   * wizard's step, in that order — so asking to see the screen showed the STEP,
   * a two-field form, rather than the two-grid page the requirement is about.
   *
   * A wizard is a shell reached from somewhere else, and a step is reached from
   * a wizard. Neither is the screen a reader means. So prefer the first ordinary
   * Page, and fall back to the first page of any kind rather than returning
   * nothing — a preview of the wrong page is still better than none, and the
   * caller labels what it drew.
   */
  const main = d.pages.find((p) => (p.uiType ?? "Page") === "Page");
  return main ?? d.pages[0];
}
