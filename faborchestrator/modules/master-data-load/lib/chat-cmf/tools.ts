import { tool } from "ai";
import { z } from "zod";
import templateSchema from "@/modules/master-data-load/lib/validation/template-schema.json";
import { resolveObjectType } from "@/modules/master-data-load/lib/chat-cmf/object-types";
import { loadRuleset, isFkReference } from "@/modules/master-data-load/lib/validation/metadata";
import { generateSkeletonBlank, generateFromSkeleton, readSkeletonMarker } from "@/modules/master-data-load/lib/validation/ksp-skeleton";
// Narrow (object-only) templates use the from-scratch generator, ENHANCED to copy
// the source header comments + fills + column widths. (The PRESERVE generator that
// kept the x14 dropdowns byte-for-byte broke CMF — "key '2' not present" — the same
// way Index trimming did in Change 7, so it is not used.)
import { generateLeanTemplate } from "@/modules/master-data-load/lib/validation/lean-template";
import { getComposition, parentOf } from "@/modules/master-data-load/lib/validation/composition";
import {
  createStagedUpload,
  getStagedUpload,
  getStagedMeta,
  updateStagedUpload,
  markFlowLoaded,
} from "@/modules/master-data-load/lib/repo-cmf/validation";
import {
  validateParsedSheets,
  validateAgainstTemplate,
  readUploadSheets,
} from "@/modules/master-data-load/lib/validation/template-check";
import { checkCrossSheetWithMetadata, mergeFindings } from "@/modules/master-data-load/lib/validation/cross-sheet";
import { parseWorkbook } from "@/modules/master-data-load/lib/validation/xlsx";
import { prefillFormFromInput } from "@/modules/master-data-load/lib/chat-cmf/prefill";
import { lookupExisting } from "@/modules/master-data-load/lib/chat-cmf/lookup-existing";
import { browseCmfRecords, getFieldValueOptions } from "@/modules/master-data-load/lib/chat-cmf/browse";
import { fillFromExisting } from "@/modules/master-data-load/lib/chat-cmf/fill-from-existing";
import { exportWithDependencies } from "@/modules/master-data-load/lib/chat-cmf/export-with-deps";
import { removeFromLoader } from "@/modules/master-data-load/lib/chat-cmf/loader-edit";
import { previewLoadImpact } from "@/modules/master-data-load/lib/chat-cmf/load-preview";
import {
  prepareMasterData,
  executeMasterData,
  getObjectById,
  getObjectTypes,
} from "@/modules/master-data-load/lib/cmf/cmf-client";
import type { UserFriendlyObjectType, ExecutionLogEntry } from "@/modules/master-data-load/lib/cmf/types";
import { runWithCmfDb, currentDbKey } from "@/modules/master-data-load/lib/cmf/db-context";
import { CmfNoDatabaseError, NO_DATABASE_MESSAGE, profileFor, type CmfDbKey } from "@/modules/master-data-load/lib/cmf/db-registry";
import { isSystemManaged } from "@/modules/master-data-load/lib/validation/system-columns";
import { isObjectRemoved, isColumnRemoved, getRemovedColumns } from "@/modules/master-data-load/lib/validation/removal-policy";
import { summarize, type ErrorDetail } from '@/shared/lib/errors/error-detail';
import { isCapturedError, recordCaptured } from '@/shared/lib/errors/capture';

/**
 * The AI template-builder's tool belt (Vercel AI SDK v6). Claude drives the
 * conversation and calls these to resolve a type, learn its fields, check the
 * live CMF DB, run the deterministic validations, and finally generate a
 * loader-conformant .xlsx. Every tool is read-only EXCEPT `generateExcel`, whose
 * only write is the app's own StagedUpload (never CMF). All are scoped to the
 * signed-in user via the `buildChatTools(userId)` factory.
 *
 * Dual CMF database: the factory takes `{ exportDbKey, loadDbKey }` and wraps
 * each tool's `execute` in the AsyncLocalStorage DB context (db-context.ts) so
 * every CMF call it makes hits the right database — READ/export tools run under
 * `exportDbKey`, the WRITE tools (validateForLoad, loadToCmf) under `loadDbKey`.
 * This lets a single turn export from one DB and load into another. Either key
 * may be null — no enabled, granted connection exists — in which case every
 * tool that reaches CMF answers with a calm "no database connection" message
 * instead of running (nothing falls back to an env default).
 *
 * Note: v6 uses `inputSchema` (not `parameters`).
 */

/** Tools that WRITE to CMF — run under the LOAD database, not the export one. */
const LOAD_TOOLS = new Set(["validateForLoad", "loadToCmf"]);

const RESERVED = new Set(["$order", "$ambiguous"]);
type TemplateEntry = { raw: string; columns: string[] };
const SCHEMA = templateSchema as unknown as Record<string, TemplateEntry>;
const SCHEMA_BY_LOWER = new Map(
  Object.entries(SCHEMA)
    .filter(([k]) => !RESERVED.has(k))
    .map(([k, v]) => [k.toLowerCase(), { objectType: k, ...v }]),
);

const rowSchema = z.record(z.string(), z.string());

/**
 * The inline entry form is only offered for simple objects: a single sheet with
 * fewer than this many columns. Bigger objects are filled offline in the
 * generated .xlsx instead.
 */
const FORM_MAX_COLUMNS = 11;

function slug(s: string): string {
  return s.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "package";
}

export function buildChatTools(
  userId: string,
  dbSel: {
    exportDbKey: CmfDbKey | null;
    loadDbKey: CmfDbKey | null;
    loadDbAmbiguous?: boolean;
    /** The user's granted connections, for naming them in messages to the agent. */
    dbLabels?: ReadonlyArray<{ key: CmfDbKey; label: string }>;
  } = { exportDbKey: null, loadDbKey: null },
) {
  const exportDbKey: CmfDbKey | null = dbSel.exportDbKey ?? null;
  const loadDbKey: CmfDbKey | null = dbSel.loadDbKey ?? null;
  // Several databases enabled but the user hasn't picked a load target — the
  // write tools must ask which DB before doing anything, so a load can't fire
  // against an ambiguous/default target.
  const loadDbAmbiguous = dbSel.loadDbAmbiguous ?? false;
  const dbNames = (dbSel.dbLabels ?? []).map((d) => d.label).join(", ");
  const needsDbSelection = () => ({
    ok: false as const,
    needsDbSelection: true as const,
    message:
      `More than one CMF database is enabled${dbNames ? ` (${dbNames})` : ""}. Ask the user which database to load into, then retry once they choose.`,
  });
  /** The answer of every CMF-touching tool when there is no database. */
  const noDatabase = () => ({ ok: false as const, noDatabase: true as const, error: NO_DATABASE_MESSAGE });
  const tools = {
    resolveObjectType: tool({
      description:
        "Map a user's free-text request (e.g. 'production orders', 'materials') to a real CMF object type. Returns a DECISION, not just a list: when one type clearly wins it returns `confident: true` with `objectType` — proceed with it, do NOT ask the user to confirm. Only when `ambiguous: true` should you ask the user to pick from `candidates`. This keeps the choice deterministic (the tool decides), not a guess.",
      inputSchema: z.object({
        query: z.string().describe("The user's free-text description of what they want to load"),
      }),
      execute: async ({ query }) => {
        const ranked = resolveObjectType(query).map((c) => ({
          ...c,
          removed: isObjectRemoved(c.objectType),
        }));
        // Exact template-key match (incl. simple singular/plural), or a dominant
        // top score, is confident — otherwise ask the user to pick.
        const norm = query.trim().toLowerCase();
        const exact =
          SCHEMA_BY_LOWER.get(norm)?.objectType ??
          SCHEMA_BY_LOWER.get(norm.replace(/s$/, ""))?.objectType ??
          SCHEMA_BY_LOWER.get(norm.replace(/ies$/, "y"))?.objectType;
        const [top, second] = ranked;
        const dominant = !!top && top.score >= 0.6 && (!second || top.score - second.score >= 0.2);
        const confident = !!exact || dominant;
        return {
          confident,
          ambiguous: !confident && ranked.length > 0,
          objectType: confident ? exact ?? top.objectType : undefined,
          candidates: ranked.slice(0, 6),
        };
      },
    }),

    getRequiredFields: tool({
      description:
        "List the fields for a CMF object type: which are mandatory, their scalar type, max length, regex, the CMF-declared `defaultValue`, and which are genuine foreign keys (referenceTargetType) that must already exist in CMF. Use this to tell the user exactly what to provide. IMPORTANT when filling mandatory fields: (1) a field with a non-null `defaultValue` (typically Int enums and Bit flags → \"0\"/\"1\") should be filled with THAT value — it is what CMF applies on load — not asked of the user or guessed; (2) for a mandatory field with NO defaultValue whose value you don't know, do NOT invent one — call `suggestFieldValues` to see the values that field actually holds in CMF and offer those; (3) only `referenceTargetType` fields are real references needing existing CMF records — a scalar field (e.g. a string 'Type') is a literal value, not a reference, so never validate it against other records.",
      inputSchema: z.object({
        objectType: z.string().describe("The exact CMF object type (template key), e.g. 'ProductionOrder'"),
      }),
      execute: async ({ objectType }) => {
        const tpl = SCHEMA_BY_LOWER.get(objectType.toLowerCase());
        const order = tpl?.columns ?? [];
        const ruleset = await loadRuleset(tpl?.objectType ?? objectType);
        if (!ruleset) {
          return {
            objectType: tpl?.objectType ?? objectType,
            metadataMissing: true,
            order,
            columns: order.map((name) => ({
              name,
              mandatory: false,
              scalarType: null,
              maxLength: null,
              regex: null,
              referenceTargetType: null,
            })),
            note: "No CMF metadata was found for this type — field requirements are unknown; only the template column list is available.",
          };
        }
        return {
          objectType: ruleset.objectType,
          order,
          columns: ruleset.properties.map((p) => ({
            name: p.name,
            mandatory: p.mandatory,
            scalarType: p.scalarType,
            maxLength: p.scalarSize,
            regex: p.validationRegex,
            // Only expose GENUINE FK references. CMF tags many scalar columns
            // (e.g. Step.Type = "Standard") with a bogus reference target; showing
            // those as FKs makes the model reject valid values as "not a reference".
            referenceTargetType: isFkReference(p) ? p.referenceTargetType : null,
            // CMF-declared default. Many mandatory scalars (Int enums, Bit flags)
            // default to "0"/"1"; use this value when filling them rather than
            // guessing — it is exactly what CMF applies on load.
            defaultValue: p.defaultValue,
          })),
        };
      },
    }),

    getObjectComposition: tool({
      description:
        "Return the multi-sheet composition for an object type. Many CMF objects (Step, Resource, Checklist, MaintenancePlan, BOM, Recipe, Plan, Flow, Schedule, …) need multiple sheets to load — a parent sheet plus N sub-sheets. Call this BEFORE generateTemplate or renderEntryForm when you're not sure whether an object is single-sheet or multi-sheet. If subSheets is empty, treat the object as single-sheet; if non-empty, you must collect rows for each sub-sheet too before generateExcel.",
      inputSchema: z.object({
        objectType: z.string().describe("Parent object type, e.g. 'Step', 'Resource'"),
      }),
      execute: async ({ objectType }) => {
        const comp = getComposition(objectType);
        if (!comp) {
          // Maybe the user named a sub-sheet — point them at the real parent.
          const parent = parentOf(objectType);
          if (parent) {
            return {
              objectType,
              isSubSheet: true,
              parentObjectType: parent,
              note: `"${objectType}" is a sub-sheet of "${parent}". Use that as the parent and ask the user to fill the sub-sheets too.`,
            };
          }
          return { error: `Unknown object type "${objectType}".` };
        }
        // Filter client-removed columns so the LLM never quotes them back
        // to the user (they don't appear in the generated file either).
        const filterCols = (obj: string, cols: string[]) => {
          const removed = getRemovedColumns(obj);
          return cols.filter((c) => !removed.has(c.toLowerCase()));
        };
        return {
          parent: comp.parent,
          parentRaw: comp.parentRaw,
          parentColumns: filterCols(comp.parent, comp.parentColumns),
          isMultiSheet: comp.subSheets.length > 0,
          totalSheets: 1 + comp.subSheets.length,
          subSheets: comp.subSheets.map((s) => ({
            objectType: s.objectType,
            sheetName: s.raw,
            columnCount: filterCols(s.objectType, s.columns).length,
          })),
        };
      },
    }),

    lookupExisting: tool({
      description:
        "Look up existing CMF rows by Name. Call this when the user wants to UPDATE existing rows ('Change Site for MAT-001 to SITE-B'), CLONE existing rows ('Make 10 materials like MAT-001'), or INSPECT current values ('Show me MAT-001'). Returns each found row keyed by Name with every column's current value, plus a notFound list. After looking up, pass the result's rows (merged with the user's requested changes) to prefillFormFromInput → renderEntryForm so the user sees current values pre-filled with their changes highlighted.",
      inputSchema: z.object({
        objectType: z
          .string()
          .describe("The exact CMF object type, e.g. 'Material'."),
        names: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("The Name values to look up (case-sensitive Name match)."),
      }),
      execute: async ({ objectType, names }) => {
        try {
          return await lookupExisting(objectType, names);
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    suggestFieldValues: tool({
      description:
        "Suggest REAL values for a field instead of guessing. When you must fill a mandatory field but don't know a valid value (a scalar with no defaultValue — e.g. Step.Type, or an enum), call this: it returns the values that field ACTUALLY holds across existing CMF records, most-common first (with counts), so you can present real options for the user to pick. Works for scalar fields (returns the literal values, e.g. Step.Type → 'Standard') and for genuine FK fields (resolves ids to the referenced object's Names). RULE: never invent a value for a mandatory field — if it has a non-null defaultValue use that; otherwise call this and suggest what CMF actually uses.",
      inputSchema: z.object({
        objectType: z.string().describe("The CMF object type (template key), e.g. 'Step'."),
        field: z.string().describe("The field/column to get existing values for, e.g. 'Type'."),
        limit: z.number().optional().describe("Max distinct values to return (default 20, max 100)."),
      }),
      execute: async ({ objectType, field, limit }) => {
        try {
          return await getFieldValueOptions(objectType, field, limit ?? 20);
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    browseCmfRecords: tool({
      description:
        "CMF database lookup for DISCOVERY — use when the user is looking for records but does NOT know the exact name(s): 'what flows exist?', 'list existing flow names', 'products and their flow', 'which products use flow F1', 'flows with wafer in the name'. Lists / searches the live CMF records of ANY object type (Flow, Product, Resource, Step, Area, …) and returns Name + Description + the object's link fields (e.g. Product → FlowPath), plus the TOTAL count so you can say 'showing 50 of 3,120'. Read-only. Use `search` for a keyword, `filterColumn`+`filterValue` for a reverse lookup ('which products use flow F1' → filterColumn 'FlowPath', filterValue 'F1'), and `columns` to request specific fields. This is the tool for browsing; use lookupExisting instead only when the user already gave exact Names to update/clone/inspect. Present results as a clean list in business language and offer to continue the build/load with a name the user picks.",
      inputSchema: z.object({
        objectType: z
          .string()
          .describe("Object type to browse, e.g. 'Flow', 'Product'. Fuzzy words like 'flows' are resolved automatically."),
        search: z
          .string()
          .optional()
          .describe("Keyword to filter by (substring match on Name/Description, case-insensitive)."),
        filterColumn: z
          .string()
          .optional()
          .describe("Field to exact-match for a reverse lookup, e.g. 'FlowPath' on Product. Must be a real field of the object."),
        filterValue: z.string().optional().describe("Value for filterColumn."),
        columns: z
          .array(z.string())
          .optional()
          .describe("Specific fields to return; defaults to Name + Description + the object's link columns."),
        limit: z.number().optional().describe("Max rows (default 50, max 200)."),
      }),
      execute: async ({ objectType, search, filterColumn, filterValue, columns, limit }) => {
        try {
          // Accept fuzzy words ('flows', 'product') by resolving to a canonical type.
          const canonical = SCHEMA_BY_LOWER.get(objectType.toLowerCase())
            ? objectType
            : resolveObjectType(objectType)[0]?.objectType ?? objectType;
          const result = await browseCmfRecords({
            objectType: canonical,
            search,
            filterColumn,
            filterValue,
            columns,
            limit,
          });
          if (result.removed) {
            return { error: `"${canonical}" isn't part of this template, so it can't be browsed.` };
          }
          if (result.metadataMissing) {
            return {
              error: `"${canonical}" can't be listed on its own — it's part of another object. Ask about its parent instead.`,
            };
          }
          if (result.error) return { error: result.error };
          return {
            objectType: result.objectType,
            columns: result.columns,
            rows: result.rows,
            total: result.total,
            returned: result.returned,
            truncated: result.truncated,
          };
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    fillFromExisting: tool({
      description:
        "Build a template PRE-FILLED with EXISTING CMF records, so the user edits instead of typing from scratch. Reads live data and maps it into the template (relationships resolved to names), then stages a ready file. Use when the user wants to: start from existing data ('pre-fill a Resource template with the resources in the Assembly area'), CLONE a set ('make a Product template from the products in group BULK'), or BULK-EDIT existing records ('set Type=Standard on every product in group BULK' → pass `set`). Select records by `names`, or by `filterColumn`+`filterValue` (a direct field OR a related object's name, e.g. filter Resource by Area='Assembly'), or by `search`. The retrieved data comes straight from CMF — it is never invented. MULTI-SHEET OBJECTS (DataCollection, Step, Resource, Checklist, …) are handled automatically: because such an object is NOT loadable as a lone parent sheet (e.g. a DataCollection needs its DataCollectionParameters), this tool includes the object's composition sub-sheets + required dependencies in load order — so the file actually loads. When that happens the result carries `multiSheet:true` and a `dependencyList` (show it to the user). After this returns a stagingId, call validateForLoad then present the Download. Tell the user how many rows were filled and (for cross-environment loads) that referenced parents must exist in the target CMF.",
      inputSchema: z.object({
        objectType: z.string().describe("Object type to fill, e.g. 'Resource', 'Product'. Fuzzy words are resolved."),
        names: z.array(z.string()).optional().describe("Specific existing records to pull, by Name."),
        filterColumn: z
          .string()
          .optional()
          .describe("Field to match records on — a direct field or a related object's name (e.g. 'Area')."),
        filterValue: z.string().optional().describe("Value for filterColumn (e.g. 'Assembly')."),
        search: z.string().optional().describe("Keyword on Name/Description instead of an exact filter."),
        set: z
          .record(z.string(), z.string())
          .optional()
          .describe("Bulk change applied to EVERY retrieved row before writing (column → new value). Use for bulk-edits."),
        packageName: z.string().describe("A name for the package/file."),
        scope: z.enum(["full", "narrow"]).optional().describe("narrow = just this object's sheet; full = whole layout."),
        limit: z.number().optional().describe("Max records to pull (default 100, max 1000)."),
      }),
      execute: async ({ objectType, names, filterColumn, filterValue, search, set, packageName, scope, limit }) => {
        try {
          const canonical = SCHEMA_BY_LOWER.get(objectType.toLowerCase())
            ? objectType
            : resolveObjectType(objectType)[0]?.objectType ?? objectType;

          // Multi-sheet objects are NOT loadable as a lone parent sheet — CMF
          // needs their composition sub-sheets (a DataCollection needs its
          // DataCollectionParameters, etc.). Route a plain export of such an
          // object through the composition/dependency-aware export so the file
          // actually loads. Bulk-edit (`set`) stays on the single parent sheet.
          const comp = getComposition(canonical);
          if (comp && comp.subSheets.length > 0 && !set) {
            const dep = await exportWithDependencies({
              userId,
              rootObjectType: canonical,
              selector: { names, filterColumn, filterValue, search, limit },
              includeOptional: false,
              packageName,
            });
            if (dep.error) return { error: dep.error };
            const rootRows = dep.dependencyList.find((d) => d.objectType === dep.root)?.rowCount ?? 0;
            return {
              stagingId: dep.stagingId,
              filename: dep.filename,
              objectType: dep.root,
              rowCount: rootRows,
              totalRows: dep.totalRows,
              multiSheet: true as const,
              dependencyList: dep.dependencyList,
              notes: dep.notes,
              parentCheckPerformed: false as const,
            };
          }

          const result = await fillFromExisting({
            userId,
            objectType: canonical,
            selector: { names, filterColumn, filterValue, search, limit },
            set,
            packageName,
            scope,
          });
          if (result.removed) return { error: `"${canonical}" isn't part of this template.` };
          if (result.metadataMissing) return { error: `"${canonical}" can't be filled from existing data (no data table).` };
          if (result.error) return { error: result.error };
          return {
            stagingId: result.stagingId,
            filename: result.filename,
            objectType: result.objectType,
            rowCount: result.rowCount,
            columnsFilled: result.columnsFilled,
            total: result.total,
            truncated: result.truncated,
            applied: result.applied,
            parentCheckPerformed: false as const,
          };
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    prefillFormFromInput: tool({
      description:
        "DB-validate user-provided rows BEFORE rendering the form. Call this whenever the user pastes data, types data in their prompt, or uploads an .xlsx — anything where you already have proposed rows on hand. Returns each row with per-cell status (ok / fk-resolved / fk-fuzzy / fk-missing / fk-unknown / required-missing / too-long / regex-fail), optional suggestions for fuzzy/missing FK cells, and a hasBlockers flag. After this returns, call renderEntryForm with initialRows set to the result so the user sees pre-filled cells colored by status. Do NOT skip prefill when user data is available — it catches FK typos before submission.",
      inputSchema: z.object({
        objectType: z
          .string()
          .describe("The exact CMF object type (template key), e.g. 'Material'."),
        rows: z
          .array(rowSchema)
          .describe(
            "User-supplied rows as { columnName -> string }. Column names are best-effort: the tool maps them to the canonical template columns case-insensitively and reports any that don't fit under unknownColumns.",
          ),
      }),
      execute: async ({ objectType, rows }) => {
        try {
          const result = await prefillFormFromInput(objectType, rows);
          return result;
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    renderEntryForm: tool({
      description:
        "Render an interactive data-entry FORM inline in the chat. Call this when the user agrees to fill in rows directly in the chat OR when they've already provided data (paste / upload / prompt) and you've run prefillFormFromInput. The UI replaces this tool's output with a real form: typed inputs per field, foreign-key dropdowns lazy-loaded from CMF, Add/Remove/Duplicate row, Apply-to-all per cell, and a Submit button. When `prefilledRows` is provided each cell renders with its status color (green/yellow/red) and tooltip. After the user submits, you'll see their rows as the next user message — then immediately call generateExcel (which self-verifies against the KSP template).",
      inputSchema: z.object({
        objectType: z.string().describe("The exact CMF object type (template key), e.g. 'ProductionOrder'"),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            "Optional explicit list of column names to include. Defaults to all mandatory + key columns.",
          ),
        initialRows: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many blank rows to start with (default 1). Ignored when prefilledRows is provided."),
        prefilledRows: z
          .array(
            z.record(
              z.string(),
              z.object({
                value: z.string(),
                status: z
                  .enum([
                    "ok",
                    "fk-resolved",
                    "fk-fuzzy",
                    "fk-missing",
                    "fk-unknown",
                    "required-missing",
                    "too-long",
                    "regex-fail",
                  ])
                  .optional(),
                message: z.string().optional(),
                suggestions: z.array(z.string()).optional(),
              }),
            ),
          )
          .optional()
          .describe(
            "Optional pre-populated rows from prefillFormFromInput. Each row is keyed by canonical column name; each cell carries status + optional suggestions. The UI renders status colors and tooltips so the user sees what needs fixing.",
          ),
      }),
      execute: async ({ objectType, fields, initialRows, prefilledRows }) => {
        if (isObjectRemoved(objectType)) {
          return {
            error: `Object type "${objectType}" has been removed from the client's template. No form will be opened.`,
            objectRemoved: true as const,
          };
        }

        // v1 eligibility gate: the inline form is only offered for SIMPLE
        // objects — a single sheet (no sub-sheets) with fewer than 11 columns.
        // Anything bigger is unwieldy in chat, so the user fills it offline.
        const comp = getComposition(objectType);
        if (comp && comp.subSheets.length > 0) {
          return {
            formEligible: false as const,
            reason: "multi-sheet",
            objectType,
            totalSheets: 1 + comp.subSheets.length,
            note: `"${objectType}" needs ${1 + comp.subSheets.length} sheets, so the inline form isn't available. Generate the template and fill it offline instead.`,
          };
        }
        const templateCols = SCHEMA_BY_LOWER.get(objectType.toLowerCase())?.columns ?? [];
        const visibleColCount = templateCols.filter((c) => !isColumnRemoved(objectType, c)).length;
        if (visibleColCount >= FORM_MAX_COLUMNS) {
          return {
            formEligible: false as const,
            reason: "too-many-columns",
            objectType,
            columnCount: visibleColCount,
            note: `"${objectType}" has ${visibleColCount} columns (the inline form supports fewer than ${FORM_MAX_COLUMNS}). Generate the template and fill it offline instead.`,
          };
        }

        const ruleset = await loadRuleset(objectType);
        const tpl = SCHEMA_BY_LOWER.get(objectType.toLowerCase());
        if (!ruleset && !tpl) {
          return {
            error: `Unknown object type "${objectType}" — not in schema or CMF metadata.`,
          };
        }

        // Pick the columns to render. If prefilledRows are provided, also
        // include every column that appears in them (so the user can see / edit
        // every cell the prefill engine populated, even if not mandatory).
        const wanted = fields
          ? new Set(fields.map((f) => f.toLowerCase()))
          : null;
        const prefillCols = new Set<string>();
        if (prefilledRows) {
          for (const row of prefilledRows) for (const k of Object.keys(row)) prefillCols.add(k.toLowerCase());
        }

        // CMF has property metadata for most objects. When it doesn't (system
        // tables like <SM>User, <SM>Role, <SM>Config), fall back to the
        // template schema's column list and treat each field as an untyped
        // string. The user can still fill and submit; we just can't do FK
        // dropdowns / regex checks / typed inputs for those.
        type ChosenField = {
          name: string;
          scalarType: string | null;
          mandatory: boolean;
          isKey: boolean;
          maxLength: number | null;
          regex: string | null;
          referenceTargetType: string | null;
        };
        const canonicalType = ruleset?.objectType ?? tpl?.objectType ?? objectType;
        let chosen: ChosenField[];
        let metadataMissing = false;
        if (ruleset) {
          chosen = ruleset.properties
            .filter((p) => {
              if (isColumnRemoved(ruleset.objectType, p.name)) return false;
              if (wanted) return wanted.has(p.name.toLowerCase());
              if (isSystemManaged(p.name)) return false;
              if (prefillCols.size > 0) return p.mandatory || p.isKey || prefillCols.has(p.name.toLowerCase());
              return p.mandatory || p.isKey;
            })
            .map((p) => ({
              name: p.name,
              scalarType: p.scalarType,
              mandatory: p.mandatory,
              isKey: p.isKey,
              maxLength: p.scalarSize,
              regex: p.validationRegex,
              // Genuine FK references only — hide CMF's bogus scalar "references".
              referenceTargetType: isFkReference(p) ? p.referenceTargetType : null,
              // CMF-declared default for mandatory scalars (Int enums / Bit flags).
              defaultValue: p.defaultValue,
            }));
        } else {
          metadataMissing = true;
          const cols = tpl!.columns;
          const keptCols = cols.filter((name) => {
            if (isColumnRemoved(canonicalType, name)) return false;
            if (wanted) return wanted.has(name.toLowerCase());
            if (isSystemManaged(name)) return false;
            return true;
          });
          // No metadata → treat the first-listed kept column as key/mandatory
          // (it's virtually always Name / UserAccount / ParentPath / etc.);
          // everything else is optional string input.
          chosen = keptCols.map((name, i) => ({
            name,
            scalarType: null,
            mandatory: i === 0,
            isKey: i === 0,
            maxLength: null,
            regex: null,
            referenceTargetType: null,
          }));
        }

        return {
          objectType: canonicalType,
          initialRows: initialRows ?? 1,
          prefilledRows: prefilledRows ?? null,
          fields: chosen,
          metadataMissing,
          note: metadataMissing
            ? "CMF metadata isn't published for this object type. The form uses the template's raw column list — no FK dropdowns, no typed inputs, mandatory flags unknown (only the first column is assumed to be the key). Users can still fill and submit."
            : undefined,
        };
      },
    }),

    generateTemplate: tool({
      description:
        "Generate a BLANK loader-conformant master-data .xlsx — just the header row(s), no data — for the user to fill in offline. AUTO-DETECTS multi-sheet objects: if the chosen objectType has sub-sheets (Step, Resource, Checklist, MaintenancePlan, etc.), the generated workbook includes the parent sheet PLUS every sub-sheet in canonical order, so the file is complete and loader-ready. NO checks needed: there are no rows to validate. Use this when the user asks for an empty template, a blank file, a starter template, or anything meaning 'give me the structure, not data'.",
      inputSchema: z.object({
        objectType: z.string().describe("The exact CMF object type (template key), e.g. 'ProductionOrder' or 'Step'"),
        packageName: z
          .string()
          .optional()
          .describe("Optional short name, e.g. 'Step_template'. Defaults to '<ObjectType>_template'."),
        scope: z
          .enum(["full", "narrow"])
          .optional()
          .describe(
            "'narrow' (default): only the requested object's sheet(s) stay visible; every other prefixed data sheet is hidden — a focused starter file. 'full': keep every one of the 175 data sheets visible — the whole master-template layout, useful when the user plans to add multiple object types later. Ask the user which they want before calling.",
          ),
      }),
      execute: async ({ objectType, packageName, scope }) => {
        try {
          const comp = getComposition(objectType);
          const parent = comp?.parent ?? objectType;
          const tpl = SCHEMA_BY_LOWER.get(parent.toLowerCase());
          if (!tpl) throw new Error(`Unknown object type "${objectType}".`);
          if (isObjectRemoved(parent)) {
            return {
              error: `Object type "${parent}" has been removed from the client's template. No file will be generated.`,
              objectRemoved: true as const,
            };
          }

          const ruleset = await loadRuleset(parent);
          const mandatoryColumns =
            ruleset?.properties.filter((p) => p.mandatory).map((p) => p.name) ?? [];

          // NARROW (object-specific) → lean generator: ONLY the 6 meta sheets +
          // this object's sheet(s), with the Index trimmed to the 7 default rows
          // + those sheets (the client's requirement — not all ~170 objects).
          // Built from scratch so Index/WorksheetNameMapping/sheet-set are
          // self-consistent; verified live in CMF for single-, sub- and heavy
          // multi-sheet objects (Config/Site/Document/Step/StateModel, result=0).
          //
          // FULL → keep the KSP_DL skeleton (all ~213 sheets, full Index): the
          // whole master-template layout the user asked to keep for adding more
          // objects later. It inherits CMF's defined names / ContentTypeId etc.
          const useNarrow = (scope ?? "narrow") === "narrow";
          const gen = useNarrow
            ? await (async () => {
                const lean = await generateLeanTemplate(parent);
                return { bytes: lean.bytes, visibleSheets: lean.objectSheets.map((s) => s.tab) };
              })()
            : await generateSkeletonBlank({ keepObjectTypes: [parent], scope });
          const name = packageName ?? `${parent}_template`;
          const filename = `${parent}_${slug(name)}.xlsx`;
          const staged = await createStagedUpload({
            userId,
            filename,
            bytes: gen.bytes,
            packageName: name,
          });

          const isMulti = !!comp && comp.subSheets.length > 0;
          if (isMulti && comp) {
            const sheetsInfo = [
              { objectType: comp.parent, sheetName: comp.parentRaw, columns: comp.parentColumns },
              ...comp.subSheets.map((s) => ({
                objectType: s.objectType,
                sheetName: s.raw,
                columns: s.columns,
              })),
            ];
            return {
              stagingId: staged.id,
              filename,
              isTemplate: true as const,
              isMultiSheet: true as const,
              sheetCount: sheetsInfo.length,
              sheets: sheetsInfo,
              mandatoryColumns,
              skeleton: true as const,
              visibleSheets: gen.visibleSheets,
            };
          }

          return {
            stagingId: staged.id,
            filename,
            sheetName: tpl.raw,
            columns: tpl.columns,
            mandatoryColumns,
            isTemplate: true as const,
            isMultiSheet: false as const,
            skeleton: true as const,
            visibleSheets: gen.visibleSheets,
          };
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    generateExcel: tool({
      description:
        "Generate a full master-data .xlsx populated with the user's rows and stage it. The output ALWAYS contains every sheet from the finalized master template (175 sheets) — only the requested object's sheet is filled with the user's rows; every other sheet remains headers-only. Supports single-sheet (Material, ProductionOrder…) with `rows`, and multi-sheet (Step, Resource, Checklist…) with `rowsByType` keyed by canonical type. WHEN THE USER HAS UPLOADED AN EXISTING WORKBOOK: pass its stagingId as `startFromStagingId`, and this tool will APPEND rows to that file preserving everything already in it — that's how a user builds up one master file over multiple sessions.",
      inputSchema: z.object({
        objectType: z.string().describe("Parent / single object type"),
        rows: z
          .array(rowSchema)
          .optional()
          .describe("Single-sheet input. Use for objects without sub-sheets."),
        rowsByType: z
          .record(z.string(), z.array(rowSchema))
          .optional()
          .describe(
            "Multi-sheet input keyed by canonical objectType. Must include the parent type. Sub-sheet types may be omitted or empty.",
          ),
        packageName: z.string().describe("A short name for the generated package, e.g. 'ProductionOrders_2026Q3'"),
        startFromStagingId: z
          .string()
          .optional()
          .describe(
            "When the user has UPLOADED a workbook via the chat and wants to add to it (not regenerate), pass the uploaded file's stagingId here. The output is the same file with new rows appended to the requested sheets — everything else preserved byte-for-byte. Omit this to generate a fresh workbook from the finalized master template.",
          ),
        scope: z
          .enum(["full", "narrow"])
          .optional()
          .describe(
            "'full' (default): keep every one of the 175 sheets visible — the whole master-template layout. 'narrow': hide every prefixed data sheet EXCEPT the ones you're writing to (plus meta sheets and their sub-sheets). Ask the user which they want before calling.",
          ),
      }),
      execute: async ({ objectType, rows, rowsByType, packageName, startFromStagingId, scope }) => {
        try {
          const comp = getComposition(objectType);
          const useMulti = !!comp && comp.subSheets.length > 0;
          const byType = rowsByType ?? (rows ? { [objectType]: rows } : {});
          const totalRows = Object.values(byType).reduce((n, r) => n + r.length, 0);
          if (totalRows === 0) {
            return { error: `No rows provided. Pass 'rows' or 'rowsByType'.` };
          }
          if (useMulti && (!byType[comp.parent] || byType[comp.parent].length === 0)) {
            return {
              error: `"${comp.parent}" is multi-sheet (parent + ${comp.subSheets.length} sub-sheets). Pass rowsByType with at least rows for "${comp.parent}".`,
            };
          }

          // If the user is adding to a previously-uploaded file, load its bytes
          // as the base. Otherwise start from KSP_DL_client_final.
          let baseFileBytes: Buffer | undefined;
          if (startFromStagingId) {
            const staged = await getStagedUpload(startFromStagingId, userId);
            if (!staged) {
              return { error: `Uploaded file ${startFromStagingId} not found or not accessible.` };
            }
            baseFileBytes = staged.bytes;
          }

          // NARROW data (and NOT appending to an uploaded file) → lean generator:
          // 6 meta sheets + this object's sheet(s), trimmed Index, rows filled in.
          // (Appending to an upload must preserve that file, so it stays on the
          // skeleton path; FULL keeps the whole master-template layout.)
          const useNarrowData = scope === "narrow" && !startFromStagingId;
          const gen = useNarrowData
            ? await (async () => {
                const lean = await generateLeanTemplate(objectType, byType);
                const written = lean.objectSheets
                  .filter((s) => (byType[s.objectType]?.length ?? 0) > 0)
                  .map((s) => ({
                    objectType: s.objectType,
                    sheetName: s.raw,
                    rowsAppended: byType[s.objectType]!.length,
                    startedFromRow: 2,
                  }));
                return {
                  bytes: lean.bytes,
                  sheetsWritten: written,
                  skipped: [] as { objectType: string; reason: string }[],
                };
              })()
            : await generateFromSkeleton({ rowsByType: byType, baseFileBytes, scope });

          const filename = `${objectType}_${slug(packageName)}.xlsx`;
          const staged = await createStagedUpload({
            userId,
            filename,
            bytes: gen.bytes,
            packageName,
          });
          return {
            stagingId: staged.id,
            filename,
            isMultiSheet: useMulti,
            sheetsWritten: gen.sheetsWritten,
            skipped: gen.skipped,
            totalRows,
            mergedFromUpload: !!startFromStagingId,
            // Parent references are NOT verified against CMF (by design — see
            // the PARENT-REFERENCE DISCLAIMER in the system prompt). The model
            // always disclaims that referenced parents must already exist in
            // CMF or be included in this same file.
            parentCheckPerformed: false as const,
          };
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    exportWithDependencies: tool({
      description:
        "SCOPE 2 — export a complex object (e.g. a Flow) PLUS its entire dependency chain into ONE loader, pre-filled with the object's real CMF records, sheets ordered by execution order (parents first). Use when the user asks to 'export all dependent objects in <flow>' / 'export this flow with everything it needs'. Resolves the dependency tree, then walks the live records following FK links so only the records tied to the chosen root(s) are pulled (unlinked types come back as empty sheets — never unrelated data). Pass multiple root names to merge several flows into one loader. Pass startFromStagingId to add the export to the loader already in this session. Returns a dependencyList (type, required/optional, rowCount, how it was filled) — SHOW it to the user and offer to drop optional context sheets before they download.",
      inputSchema: z.object({
        rootObjectType: z.string().describe("The root object type to export from, e.g. 'Flow'."),
        names: z
          .array(z.string())
          .optional()
          .describe("Specific root record name(s), e.g. ['ALL IN ONE - BULK']. Multiple names merge into one loader."),
        filterColumn: z.string().optional().describe("Instead of names: a field on the root to match (direct or a related object's Name)."),
        filterValue: z.string().optional().describe("Value for filterColumn."),
        search: z.string().optional().describe("Instead of names: a keyword on the root's Name/Description."),
        includeOptional: z
          .boolean()
          .optional()
          .describe("Include optional context/association sheets (ResourceChartContext, StepChartContext, DataCollectionLimitSet, …). Default false. The user can ask to include them, then trim."),
        packageName: z.string().describe("Short name for the generated loader, e.g. 'BULK_flow_export'."),
        startFromStagingId: z
          .string()
          .optional()
          .describe("To ADD this export to the loader already staged in this session (save-and-add-more), pass that loader's stagingId. Omit to start a fresh loader."),
      }),
      execute: async ({ rootObjectType, names, filterColumn, filterValue, search, includeOptional, packageName, startFromStagingId }) => {
        try {
          const res = await exportWithDependencies({
            userId,
            rootObjectType,
            selector: { names, filterColumn, filterValue, search },
            includeOptional,
            packageName,
            startFromStagingId,
          });
          return res;
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    removeFromLoader: tool({
      description:
        "SCOPE 3 (remove) — drop an object type's sheet data (or specific named rows) from the loader currently staged in this session. Use when the user says 'remove the data collections' / 'take X out of this loader'. Re-stages the loader and returns the new stagingId. To ADD an object to a loader, use generateExcel with startFromStagingId instead.",
      inputSchema: z.object({
        stagingId: z.string().describe("The staged loader to edit."),
        objectType: z.string().describe("Canonical object type whose rows to remove, e.g. 'DataCollection'."),
        rowNames: z
          .array(z.string())
          .optional()
          .describe("Optional: remove only rows whose Name is in this list. Omit to clear ALL rows of the type."),
        packageName: z.string().optional().describe("Optional new package name for the re-staged loader."),
      }),
      execute: async ({ stagingId, objectType, rowNames, packageName }) => {
        try {
          return await removeFromLoader({ userId, stagingId, objectType, rowNames, packageName });
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    validateTemplate: tool({
      description:
        "Run the KSP template-check on a staged .xlsx (sheet-name conformance, column order, parent-before-child structure). MUST be called immediately after every generateTemplate / generateExcel, BEFORE pointing the user at the Download button — even though the generator self-verifies, this exposes the check as an explicit, visible step so the user sees the file was validated. Returns ok + per-sheet error counts. If ok=false, do NOT present the download; report the errors precisely (sheet / row / column) and offer to regenerate.",
      inputSchema: z.object({
        stagingId: z.string().describe("The stagingId returned by generateTemplate or generateExcel."),
      }),
      execute: async ({ stagingId }) => {
        try {
          const staged = await getStagedUpload(stagingId, userId);
          if (!staged) {
            return { ok: false, error: `Staged file ${stagingId} not found for this user.` };
          }
          // Fast path for KSP-skeleton blanks: the file is CMF-verified by
          // construction (we already proved op=1 returns result=0 on the
          // skeleton). Skip the heavy ExcelJS re-parse which hangs on the
          // rich KSP content.
          const marker = await readSkeletonMarker(staged.bytes);
          if (marker) {
            return {
              ok: true,
              stagingId,
              filename: staged.filename,
              sheetsValidated: marker.visibleSheets.length,
              errorCount: 0,
              warningCount: 0,
              errors: [],
              skeleton: true as const,
              visibleSheets: marker.visibleSheets,
            };
          }
          const sheets = await parseWorkbook(staged.bytes);
          const structural = validateParsedSheets(sheets);
          // Cross-sheet integrity (PK uniqueness + FK/key consistency). Never
          // throws — degrades to PK-only when CMF metadata is unreachable.
          let result = structural;
          try {
            const crossErrors = await checkCrossSheetWithMetadata(sheets);
            result = mergeFindings(structural, crossErrors);
          } catch (crossErr) {
            console.error("[validateTemplate] cross-sheet check failed", crossErr);
          }
          const errors = Object.entries(result.errorsByType).flatMap(([objectType, list]) =>
            list.map((e) => ({
              objectType,
              sheet: objectType,
              row: e.row,
              column: e.column,
              severity: e.severity,
              message: e.message,
            })),
          );
          return {
            ok: result.ok,
            stagingId,
            filename: staged.filename,
            sheetsValidated: sheets.length,
            errorCount: result.errorCount,
            warningCount: result.warningCount,
            errors,
          };
        } catch (err) {
          return { ok: false, ...toolError(err, userId) };
        }
      },
    }),

    previewLoadImpact: tool({
      description:
        "Predict what loading a staged .xlsx would do in CMF, row-by-row. For each row classifies as CREATE / UPDATE / SKIP / CONFLICT. CONFLICT means the row references a parent that doesn't exist in CMF — atomic batch, so any CONFLICT blocks the whole load. Call this AFTER validateTemplate ok=true, BEFORE asking the user whether to Download or Load. Use the per-sheet byVerdict counts to write a short summary the user can confirm.",
      inputSchema: z.object({
        stagingId: z.string().describe("The stagingId returned by generateExcel."),
      }),
      execute: async ({ stagingId }) => {
        try {
          const staged = await getStagedUpload(stagingId, userId);
          if (!staged) return { error: `Staged file ${stagingId} not found.` };
          return await previewLoadImpact(staged.bytes);
        } catch (err) {
          return toolError(err, userId);
        }
      },
    }),

    validateForLoad: tool({
      description:
        "Validate a staged .xlsx for LOADING into CMF. Runs BOTH checks: (1) the local template/mandatory-field check, and (2) the CMF dry-run (validate-only, NO write) which reports whether CMF will accept every row. Also returns the record count per object type. Call this before any load. If templateOk AND cmfOk are both true, tell the user the record counts and ASK them to confirm before loading. If either fails, report the errors precisely and do NOT offer to load.",
      inputSchema: z.object({
        stagingId: z.string().describe("The stagingId of the file to validate (from generateExcel/generateTemplate/fillFromExisting or an upload)."),
        packageName: z.string().optional().describe("Optional name for the CMF package. Defaults to '<filename>_<timestamp>'."),
      }),
      execute: async ({ stagingId, packageName }) => {
        if (loadDbAmbiguous) return needsDbSelection();
        try {
          const staged = await getStagedUpload(stagingId, userId);
          if (!staged) return { ok: false, error: `Staged file ${stagingId} not found for this user.` };
          const bytes = staged.bytes;
          // The CMF database this validation runs against (whichever is toggled).
          const database = profileFor(currentDbKey()).label;

          // Per-object-type record counts (data rows only) — for the "load N records" confirmation.
          const sheets = await readUploadSheets(bytes);
          const recordCounts = sheets
            .filter((s) => s.rows.length > 0)
            .map((s) => ({ objectType: s.objectType, count: s.rows.length }));
          const totalRecords = recordCounts.reduce((n, r) => n + r.count, 0);

          // 1. Local template check (mandatory Name). If it fails, stop before touching CMF.
          const tpl = await validateAgainstTemplate(bytes);
          const templateErrors = Object.entries(tpl.errorsByType).flatMap(([objectType, list]) =>
            list.map((e) => ({ objectType, row: e.row, column: e.column, severity: e.severity, message: e.message })),
          );
          if (!tpl.ok) {
            return {
              ok: false, templateOk: false, cmfOk: false, database, stagingId, filename: staged.filename,
              recordCounts, totalRecords, errors: templateErrors,
            };
          }

          // 2. CMF dry-run (op=1 = validate only, no write). Register then validate.
          const name = packageName ?? `${staged.filename.replace(/\.xlsx$/i, "")}_${Date.now()}`;
          const fileObj = {
            name: staged.filename,
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: bytes.length,
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          };
          const prep = await prepareMasterData(name, fileObj);
          const exec = await executeMasterData(prep.instance.Id, 1, prep.objectTypes);
          const cmfErrors = (exec.log ?? [])
            .filter((e: ExecutionLogEntry) => e.State === 3)
            .flatMap((e: ExecutionLogEntry) => e.Messages.map((m) => ({ objectType: e.Name, severity: "error" as const, message: m })));
          const cmfOk = exec.result === 0 && cmfErrors.length === 0;

          // Persist the CMF package + discovered types so loadToCmf reuses them (no re-register).
          // Tag the DB it was registered against — a package id is instance-specific,
          // so a later load to a DIFFERENT DB must re-register, not reuse this id.
          await updateStagedUpload(stagingId, userId, {
            status: cmfOk ? "REGISTERED" : "VALIDATED",
            packageName: name,
            packageCmfId: prep.instance.Id,
            packageCmfDbKey: currentDbKey(),
            selectedTypes: prep.objectTypes.map((t) => t.ObjectType),
          });

          return {
            ok: cmfOk, templateOk: true, cmfOk, database, resultCode: exec.result,
            stagingId, filename: staged.filename, packageCmfId: prep.instance.Id,
            objectTypes: prep.objectTypes.map((t) => t.ObjectType),
            recordCounts, totalRecords,
            errors: cmfErrors.slice(0, 12),
          };
        } catch (err) {
          return { ok: false, ...toolError(err, userId) };
        }
      },
    }),

    loadToCmf: tool({
      description:
        "Load a staged .xlsx into CMF — this COMMITS to production. STRICT PROTOCOL: (1) validateForLoad must have passed (templateOk AND cmfOk), (2) you must have shown the user the record counts and the user must have EXPLICITLY agreed to load in their latest message. Only then call with confirmed:true. If confirmed is not true, this tool refuses and returns the record counts so you can ask first. Optional selectedTypes narrows which object types load (default: every type present in the file). Returns a receipt with created/updated/skipped counts.",
      inputSchema: z.object({
        stagingId: z.string().describe("The stagingId of the validated file."),
        confirmed: z.boolean().describe("Set true ONLY after the user has explicitly agreed to load, having seen the record counts. If false/omitted the tool will NOT load and returns the counts to ask with."),
        selectedTypes: z.array(z.string()).optional().describe("Object type names to load. Omit to load every object type present in the file."),
        packageName: z.string().optional().describe("Optional CMF package name (used only if the file wasn't already registered by validateForLoad)."),
      }),
      execute: async ({ stagingId, confirmed, selectedTypes, packageName }) => {
        if (loadDbAmbiguous) return needsDbSelection();
        try {
          const staged = await getStagedUpload(stagingId, userId);
          if (!staged) return { ok: false, error: `Staged file ${stagingId} not found.` };
          const bytes = staged.bytes;

          // Record counts (data rows) for the confirmation message / sanity.
          const sheets = await readUploadSheets(bytes);
          const recordCounts = sheets
            .filter((s) => s.rows.length > 0)
            .map((s) => ({ objectType: s.objectType, count: s.rows.length }));
          const totalRecords = recordCounts.reduce((n, r) => n + r.count, 0);

          // Deterministic confirmation gate — never commit without confirmed:true.
          // The confirmation MUST name the target database, since a load writes to
          // whichever DB is toggled (source Entegris vs target OOB) and the user
          // needs to confirm they're writing to the right one.
          const targetDb = profileFor(currentDbKey()).label;
          if (confirmed !== true) {
            return {
              ok: false, needsConfirmation: true, stagingId, filename: staged.filename,
              targetDb, recordCounts, totalRecords,
              message: `Confirmation required. Tell the user you are about to LOAD ${totalRecords} record${totalRecords === 1 ? "" : "s"} into the "${targetDb}" database — name that database explicitly — and ask them to confirm this is the correct database. Only after they confirm, call loadToCmf again with confirmed:true.`,
            };
          }
          if (totalRecords === 0) {
            return { ok: false, error: "This file has no data rows to load. Fill the template with data first, then load." };
          }

          // Resolve the CMF package: reuse validateForLoad's registration ONLY if it
          // was registered against the SAME database we're now loading into. A
          // package id belongs to one CMF instance — reusing a source-registered id
          // for a target load would silently load into the wrong DB. On mismatch (or
          // no prior registration) we re-register against the current (load) DB.
          const meta = await getStagedMeta(stagingId, userId);
          const canReuse = !!meta?.packageCmfId && meta.packageCmfDbKey === currentDbKey();
          let packageId = canReuse ? meta!.packageCmfId! : null;
          let availableTypes: UserFriendlyObjectType[];
          if (packageId) {
            const inst = await getObjectById(packageId);
            availableTypes = await getObjectTypes(inst);
          } else {
            const name = packageName ?? meta?.packageName ?? `${staged.filename.replace(/\.xlsx$/i, "")}_${Date.now()}`;
            const fileObj = {
              name: staged.filename,
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: bytes.length,
              arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
            };
            const prep = await prepareMasterData(name, fileObj);
            packageId = prep.instance.Id;
            availableTypes = prep.objectTypes;
            await updateStagedUpload(stagingId, userId, {
              status: "REGISTERED", packageName: name, packageCmfId: packageId, packageCmfDbKey: currentDbKey(),
            });
          }

          // Narrow to the user's selected types (default: all discovered).
          const chosen = selectedTypes && selectedTypes.length
            ? availableTypes.filter((t) => selectedTypes.some((s) => s.toLowerCase() === t.ObjectType.toLowerCase()))
            : availableTypes;
          if (chosen.length === 0) {
            return { ok: false, error: "None of the requested object types are present in this file." };
          }

          // COMMIT — op=0 writes to production CMF.
          const exec = await executeMasterData(packageId, 0, chosen);
          const log = (exec.log ?? []) as ExecutionLogEntry[];
          const created = log.reduce((n, e) => n + (e.CreatedObjectsCounter || 0), 0);
          const updated = log.reduce((n, e) => n + (e.UpdatedObjectsCounter || 0), 0);
          const skipped = log.reduce((n, e) => n + (e.SkippedObjectsCounter || 0), 0);
          const failedEntries = log.filter((e) => e.State === 3);
          const errors = failedEntries.flatMap((e) => e.Messages.map((m) => `${e.Name}: ${m}`)).slice(0, 10);
          const ok = exec.result === 0 && failedEntries.length === 0;
          if (ok) await markFlowLoaded(packageId);

          return {
            ok, packageId, packageName: meta?.packageName ?? packageName ?? null,
            targetDb, cmfResult: exec.result,
            loadedTypes: chosen.map((t) => t.ObjectType),
            created, updated, skipped, failedCount: failedEntries.length,
            errors,
          };
        } catch (err) {
          return { ok: false, ...toolError(err, userId) };
        }
      },
    }),
  };

  // Wrap every tool's execute in the AsyncLocalStorage DB context so all CMF
  // calls it makes target the right database: WRITE tools under `loadDbKey`,
  // everything else under `exportDbKey`. Done once here rather than per-tool.
  //
  // With NO database (key null) the tool runs without a context: tools that
  // never touch CMF (resolveObjectType, template generation, …) still work, and
  // any CMF call trips `CmfNoDatabaseError` at `currentDbKey()`, which becomes
  // the calm no-database answer here (or in toolError) — never a captured
  // incident, never an env-default database.
  for (const [name, t] of Object.entries(tools)) {
    const holder = t as unknown as { execute?: (...a: unknown[]) => Promise<unknown> };
    const orig = holder.execute;
    if (typeof orig !== "function") continue;
    const dbKey = LOAD_TOOLS.has(name) ? loadDbKey : exportDbKey;
    holder.execute = async (...a: unknown[]) => {
      try {
        return dbKey ? await runWithCmfDb(dbKey, () => orig(...a)) : await orig(...a);
      } catch (err) {
        if (err instanceof CmfNoDatabaseError) return noDatabase();
        throw err;
      }
    };
  }

  return tools;
}

/**
 * A failed tool call, with the real cause and its record attached.
 *
 * These tools used to return `{ error: toModelSafeError(err) }` — a calm line
 * with the host, driver text and cause deliberately stripped out. That was the
 * right instinct (a business user should not read a connection string) applied
 * at the wrong layer: it destroyed the information before anything could
 * record it, so a dead VPN tunnel and a rejected login produced the same
 * sentence and neither left a trace.
 *
 * Now the calm line still goes to the MODEL, while `errorDetail` carries the
 * real capture to the route, which streams it to the client. The user reads
 * what actually failed; the model is not tempted to paraphrase it.
 */
function toolError(err: unknown, userId?: string): { error: string; isError: true; errorDetail?: ErrorDetail; noDatabase?: true } {
  // An expected condition, not a fault: no admin-created database connection
  // (or none granted). Tell the agent plainly; nothing to record.
  if (err instanceof CmfNoDatabaseError) return { error: err.message, isError: true, noDatabase: true };
  // Already captured (and recorded) deeper down → reuse it. Otherwise record it
  // NOW: a card built from a fresh random id had no record behind it, so its
  // "View error details" link led nowhere.
  const detail = isCapturedError(err)
    ? err.detail
    : recordCaptured({ system: 'CMF', operation: 'chatTool', userId: userId ?? null }, err).detail;
  return {
    error: `${summarize(detail)} (errorId=${detail.errorId})`,
    isError: true,
    errorDetail: detail,
  };
}

export type ChatTools = ReturnType<typeof buildChatTools>;
