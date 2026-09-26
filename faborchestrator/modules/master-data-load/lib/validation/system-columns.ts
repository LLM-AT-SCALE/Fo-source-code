/**
 * CMF system-managed columns the loader auto-populates.
 *
 * CMF's property metadata flags these as `IsMandatory=true` because they are
 * NOT NULL in the physical tables, but humans never fill them in — the
 * loader (or CMF itself) writes them on insert. They must be excluded from
 * the entry form's mandatory-field UX and from prefill engine's
 * "required-missing" gate.
 *
 * Kept in one place so:
 *   - scripts/export-object-catalog.ts (catalog generator)
 *   - src/lib/chat/tools.ts (renderEntryForm)
 *   - src/lib/chat/prefill.ts (required-missing check)
 * all agree on what counts as system-managed.
 */

const SYSTEM_AUTOFILL = new Set(
  [
    "CreatedBy",
    "CreatedOn",
    "ModifiedBy",
    "ModifiedOn",
    "Id",
    "Version",
    "LastOperationHistorySeq",
    "LastServiceHistoryId",
    "SystemState",
    "UniversalState",
    "IsTemplate",
    "IsDefaultRevision",
    "RevisionState",
    "DataGroupId",
    "DataGroupName",
    "DocumentationURL",
    "EntityPicture",
    "Image",
    "MainStateModelId",
    "MainStateModelStateId",
    "MainStateModelStateReason",
    "ApprovalDate",
    "Approver",
    "CurrentSequence",
    "LongText",
  ].map((s) => s.toLowerCase()),
);

/**
 * True for CMF-managed columns that the loader populates on insert. Also
 * catches `*Count` and `*Counter` aggregate columns CMF maintains.
 */
export function isSystemManaged(name: string): boolean {
  if (SYSTEM_AUTOFILL.has(name.toLowerCase())) return true;
  return /Count$/i.test(name) || /Counter$/i.test(name);
}
