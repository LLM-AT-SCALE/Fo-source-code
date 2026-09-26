/**
 * CMF (Critical Manufacturing) Master Data Load API — TypeScript types.
 *
 * Verified against live install at atscmapp4.usa.athenatec.com (CMF 10.2.7),
 * tested 2026-05-20. See ../../CMF_API_Complete_Reference.md.
 */

// ---------------------------------------------------------------------------
// FQN $type strings (the assembly-qualified type names CMF requires in every
// request/response body). Keep these as named constants so route handlers and
// client functions emit the exact strings — the API rejects paraphrases.
// ---------------------------------------------------------------------------

export const CMF_TYPES = {
  MasterDataPackage:
    "Cmf.Foundation.BusinessObjects.MasterDataPackage, Cmf.Foundation.BusinessObjects",
  CmfFile:
    "Cmf.Foundation.BusinessObjects.CmfFile, Cmf.Foundation.BusinessObjects",
  UserFriendlyObjectType:
    "Cmf.Foundation.BusinessObjects.MasterDataLoader.UserFriendlyObjectType, Cmf.Foundation.BusinessObjects",

  FileExistsInput:
    "Cmf.Foundation.BusinessOrchestration.GenericServiceManagement.InputObjects.FileExistsInput, Cmf.Foundation.BusinessOrchestration",
  FileExistsOutput:
    "Cmf.Foundation.BusinessOrchestration.GenericServiceManagement.OutputObjects.FileExistsOutput, Cmf.Foundation.BusinessOrchestration",

  CreateObjectInput:
    "Cmf.Foundation.BusinessOrchestration.GenericServiceManagement.InputObjects.CreateObjectInput, Cmf.Foundation.BusinessOrchestration",
  CreateObjectOutput:
    "Cmf.Foundation.BusinessOrchestration.GenericServiceManagement.OutputObjects.CreateObjectOutput, Cmf.Foundation.BusinessOrchestration",

  GetObjectByIdOutput:
    "Cmf.Foundation.BusinessOrchestration.GenericServiceManagement.OutputObjects.GetObjectByIdOutput, Cmf.Foundation.BusinessOrchestration",

  GetMasterDataPackageObjectTypesInput:
    "Cmf.Foundation.BusinessOrchestration.MasterDataManagement.InputObjects.GetMasterDataPackageObjectTypesInput, Cmf.Foundation.BusinessOrchestration",
  GetMasterDataPackageObjectTypesOutput:
    "Cmf.Foundation.BusinessOrchestration.MasterDataManagement.OutputObjects.GetMasterDataPackageObjectTypesOutput, Cmf.Foundation.BusinessOrchestration",

  PerformMasterDataPackageInput:
    "Cmf.Foundation.BusinessOrchestration.MasterDataManagement.InputObjects.PerformMasterDataPackageInput, Cmf.Foundation.BusinessOrchestration",
  PerformMasterDataPackageOutput:
    "Cmf.Foundation.BusinessOrchestration.MasterDataManagement.OutputObjects.PerformMasterDataPackageOutput, Cmf.Foundation.BusinessOrchestration",
} as const;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * PerformMDP ExecutionOperation. NOTE: in this CMF deployment (EntegrisKSPUpgrade,
 * MES 10.2.7) the committing behavior is INVERTED from CMF's nominal docs —
 * verified against the live DB and the portal's own request:
 *   0 = Validate & Load — COMMITS to the DB (this is what the portal's "Load" sends)
 *   1 = Validate only   — reports counts but does NOT persist (dry-run)
 * Use 0 to actually load, 1 to validate without writing.
 */
export type ExecutionOperation = 0 | 1;

/** LastExecutionResult: 0 = success, 1 = failure. */
export type ExecutionResult = 0 | 1;

/** Per-entry execution-log State: 2 = Success, 3 = Failed. */
type ExecutionLogEntryState = 2 | 3;

/** ObjectModelType: 1=Lookup, 2=Entity (Dynamic Model), 3=Generic Table, 4=Smart Table. */
export type ObjectModelType = 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// Core business objects
// ---------------------------------------------------------------------------

export type CmfFile = {
  Id?: string;
  Filename: string;
  Size: string; // bytes, must be string (numeric Size is rejected)
  Checksum: string; // SHA-256 uppercase hex
  ContentType?: string;
  ContentLocation?: string; // "permanent/<checksum>"
  CreatedBy?: string;
  CreatedOn?: string;
  ModifiedBy?: string;
  ModifiedOn?: string;
  UniversalState?: number;
};

export type MasterDataPackage = {
  Id: string;
  Name: string;
  Type: "Generic" | string;
  Revision?: string | null;
  IsTemplate?: boolean;
  SystemState?: number;
  UniversalState?: number;
  CreatedBy?: string;
  CreatedOn?: string;
  ModifiedBy?: string;
  ModifiedOn?: string;
  Package?: CmfFile;

  // Populated after first PerformMDP. Null/undefined until then.
  LastExecutionOperation?: ExecutionOperation;
  LastExecutionResult?: ExecutionResult;
  LastExecutionStartDate?: string;
  LastExecutionEndDate?: string | null;
  LastExecutionConfiguration?: string; // JSON-encoded string
  LastExecutionLog?: string; // JSON-encoded string

  // Optimistic-concurrency stamps. Must be echoed back on every write call.
  LastOperationHistorySeq?: string;
  LastServiceHistoryId?: string;

  // Allow API-returned extra fields without losing them when echoed back.
  [extra: string]: unknown;
};

export type UserFriendlyObjectType = {
  ObjectType: string;
  ObjectModelType: ObjectModelType;
  ObjectDescription: string;
};

export type ExecutionLogEntry = {
  Name: string;
  State: ExecutionLogEntryState;
  Messages: string[];
  CreatedObjectsCounter: number;
  UpdatedObjectsCounter: number;
  SkippedObjectsCounter: number;
  StartDate: string;
  EndDate: string;
  RunDate: string;
};

// ---------------------------------------------------------------------------
// Wire envelopes — request bodies
// ---------------------------------------------------------------------------

export type FileExistsRequest = {
  $id: "1";
  $type: typeof CMF_TYPES.FileExistsInput;
  Checksum: string;
};

export type CreateObjectRequest = {
  $id: "1";
  $type: typeof CMF_TYPES.CreateObjectInput;
  Object: {
    $id: "2";
    $type: typeof CMF_TYPES.MasterDataPackage;
    Name: string;
    Type: "Generic";
    Revision: null;
    Package: { $id?: "3"; $type: typeof CMF_TYPES.CmfFile } & CmfFile;
  };
};

export type GetMasterDataPackageObjectTypesRequest = {
  $id: "1";
  $type: typeof CMF_TYPES.GetMasterDataPackageObjectTypesInput;
  MasterDataPackage: MasterDataPackage;
};

export type PerformMasterDataPackageRequest = {
  $id: "1";
  $type: typeof CMF_TYPES.PerformMasterDataPackageInput;
  MasterDataPackage: MasterDataPackage;
  ExecutionOperation: ExecutionOperation;
  /** JSON-stringified UserFriendlyObjectType[]. NOT an object. */
  ExecutionConfiguration: string;
  IsToPerformImmediate: boolean;
};

// ---------------------------------------------------------------------------
// Wire envelopes — response bodies
// ---------------------------------------------------------------------------

export type FileExistsResponse = {
  $id: string;
  $type: typeof CMF_TYPES.FileExistsOutput;
  FileExists: boolean;
  TotalRows: number;
};

export type CreateObjectResponse = {
  $id: string;
  $type: typeof CMF_TYPES.CreateObjectOutput;
  Object: MasterDataPackage;
};

export type GetObjectByIdResponse = {
  $id: string;
  $type: typeof CMF_TYPES.GetObjectByIdOutput;
  Instance: MasterDataPackage;
  TotalRows: number;
};

export type GetMasterDataPackageObjectTypesResponse = {
  $id: string;
  $type: typeof CMF_TYPES.GetMasterDataPackageObjectTypesOutput;
  ObjectTypes: UserFriendlyObjectType[];
  TotalRows: number;
};

export type PerformMasterDataPackageResponse = {
  $id: string;
  $type: typeof CMF_TYPES.PerformMasterDataPackageOutput;
  MasterDataPackage: MasterDataPackage;
  Message: string;
  TotalRows: number;
};

// ---------------------------------------------------------------------------
// Polling result (client-side composition)
// ---------------------------------------------------------------------------

export type PollResult = {
  result: ExecutionResult;
  log: ExecutionLogEntry[];
  instance: MasterDataPackage;
};
