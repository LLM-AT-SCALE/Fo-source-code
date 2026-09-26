/**
 * CMF Master Data Load REST client — 6 typed API functions + polling +
 * high-level orchestrator. Server-side only (uses node:crypto and depends on
 * cmf-auth's Playwright child-process token fetch).
 *
 * Wire formats are non-negotiable: see CMF_API_Complete_Reference.md.
 */

import { createHash } from "node:crypto";
import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

import { getMesToken } from "./cmf-auth";
import { currentDbKey } from "@/modules/master-data-load/lib/cmf/db-context";
import { builtinProfiles, profileFor } from "@/modules/master-data-load/lib/cmf/db-registry";
import { cachedHostResolverPairs } from "@/modules/master-data-load/lib/cmf/connection-store";

/**
 * The CMF hosts (e.g. `atscmapp4.usa.athenatec.com`, `athena-cmf-srv...`) are
 * on-prem servers NOT in public DNS — reached over the VPN by private IP. Each
 * DB profile carries its host→IP pair(s); we merge ALL of them into one map so
 * `fetch` resolves either host without a real DNS lookup. The map is keyed by
 * hostname, so both databases' hosts coexist in a single process-global undici
 * dispatcher — the dispatcher does NOT need to be per-DB; only the base URL and
 * token do (resolved per call from the active DB).
 *
 * The Agent skips TLS cert verification when CMF_TLS_INSECURE != "0" (default):
 * certs are self-signed / corp-CA-issued and we connect by IP. Both DBs share
 * this policy today. For production, install the corp CA root and set
 * CMF_TLS_INSECURE=0.
 */
const CMF_TLS_INSECURE = process.env.CMF_TLS_INSECURE !== "0";

// Static host→IP base from the opt-in local-development profiles (empty in
// every deployed environment). Admin-managed connections (loaded into
// connection-store) are consulted first at lookup time so an edited/added
// host→IP takes effect within the cache TTL without a redeploy.
const HOST_MAP = new Map<string, string>();
for (const profile of Object.values(builtinProfiles())) {
  for (const [host, ip] of profile.hostResolver) {
    if (host && ip) HOST_MAP.set(host.toLowerCase(), ip);
  }
}

/** Resolve a hostname to a mapped IP: admin-managed (DB) pairs win, then the
 *  opt-in local-development base. Returns undefined to defer to real DNS. */
function mappedIp(hostname: string): string | undefined {
  const h = hostname.toLowerCase();
  for (const [host, ip] of cachedHostResolverPairs()) {
    if (host && ip && host.toLowerCase() === h) return ip;
  }
  return HOST_MAP.get(h);
}

const hostResolverLookup: typeof dns.lookup = ((
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
) => {
  const cb = (typeof options === "function" ? options : callback) as typeof callback;
  const opts = (typeof options === "function" ? {} : options) as { all?: boolean };
  const mapped = mappedIp(hostname);
  if (mapped) {
    return opts?.all
      ? cb(null, [{ address: mapped, family: 4 }])
      : cb(null, mapped, 4);
  }
  return dns.lookup(hostname, opts as dns.LookupOptions, cb);
}) as typeof dns.lookup;

setGlobalDispatcher(
  new Agent({
    connect: {
      rejectUnauthorized: !CMF_TLS_INSECURE,
      lookup: hostResolverLookup,
    },
  }),
);

import { withCapture } from "@/shared/lib/errors/capture";
import {
  CMF_TYPES,
  type CmfFile,
  type CreateObjectRequest,
  type CreateObjectResponse,
  type ExecutionLogEntry,
  type ExecutionOperation,
  type FileExistsRequest,
  type FileExistsResponse,
  type GetMasterDataPackageObjectTypesRequest,
  type GetMasterDataPackageObjectTypesResponse,
  type GetObjectByIdResponse,
  type MasterDataPackage,
  type PerformMasterDataPackageRequest,
  type PerformMasterDataPackageResponse,
  type PollResult,
  type UserFriendlyObjectType,
} from "./types";

function baseUrl(): string {
  const v = profileFor(currentDbKey()).baseUrl;
  if (!v) throw new Error(`CMF base URL is not set for "${currentDbKey()}"`);
  return v.replace(/\/+$/, "");
}

/**
 * Single auth-aware fetch wrapper. All CMF calls go through this so token
 * handling lives in one place. Throws with the response body on non-2xx.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  /*
   * Every CMF REST call passes through here, so this is where a failure is
   * captured. Two different things can go wrong and both used to be lost:
   *
   *   - the request never lands (DNS, refused connection, dead VPN tunnel,
   *     TLS) — fetch throws, and the useful part is the `cause` chain;
   *   - CMF answers but refuses — a CmfApiError carrying the status and CMF's
   *     own error envelope, which usually explains exactly what was wrong.
   *
   * `withCapture` records both in full and names the system, so a user is told
   * that CMF rejected the request and why, rather than that something went
   * wrong somewhere.
   */
  return withCapture(
    {
      system: "CMF",
      operation: `${(init.method ?? "GET").toUpperCase()} ${path}`,
      target: `${baseUrl()}${path}`,
    },
    async () => {
      const token = await getMesToken();
      const res = await fetch(`${baseUrl()}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new CmfApiError(path, res.status, body);
      }
      return res;
    },
  );
}

export class CmfApiError extends Error {
  public readonly cmfCode?: string;
  public readonly cmfSubCode?: string;
  public readonly cmfMessage?: string;

  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    // Try to parse CMF's structured error envelope:
    //   { Code: { Name, SubCode: { Name } }, Reason: { Text }, Message }
    let cmfMessage: string | undefined;
    let cmfCode: string | undefined;
    let cmfSubCode: string | undefined;
    try {
      const parsed = JSON.parse(body) as {
        Code?: { Name?: string; SubCode?: { Name?: string } };
        Reason?: { Text?: string };
        Message?: string;
      };
      cmfMessage = parsed.Message ?? parsed.Reason?.Text;
      cmfCode = parsed.Code?.Name;
      cmfSubCode = parsed.Code?.SubCode?.Name;
    } catch {
      // Body wasn't JSON — fall through with undefined fields.
    }

    // Prefer the human-readable CMF message; fall back to a truncated body.
    const summary =
      cmfMessage ?? `HTTP ${status} ${body.slice(0, 300).trim()}`;
    super(`CMF ${path}: ${summary}`);
    this.name = "CmfApiError";
    this.cmfMessage = cmfMessage;
    this.cmfCode = cmfCode;
    this.cmfSubCode = cmfSubCode;
  }
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/** SHA-256 of bytes as uppercase hex — the format CMF stores and matches on. */
function sha256Upper(bytes: ArrayBuffer | Uint8Array | Buffer): string {
  const buf =
    bytes instanceof Buffer
      ? bytes
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : Buffer.from(new Uint8Array(bytes));
  return createHash("sha256").update(buf).digest("hex").toUpperCase();
}

// ---------------------------------------------------------------------------
// 1. FileExists
// ---------------------------------------------------------------------------

async function fileExists(checksum: string): Promise<boolean> {
  const body: FileExistsRequest = {
    $id: "1",
    $type: CMF_TYPES.FileExistsInput,
    Checksum: checksum,
  };
  const res = await authedFetch("/api/GenericService/FileExists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as FileExistsResponse;
  return data.FileExists === true;
}

// ---------------------------------------------------------------------------
// 2. UploadFile  (multipart; field name MUST be lowercase 'file'; response is
//    PLAIN TEXT — the checksum echoed back, not JSON.)
// ---------------------------------------------------------------------------

async function uploadFile(
  filename: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType?: string,
): Promise<string> {
  const fd = new FormData();
  // Copy into a fresh ArrayBuffer so the Blob's BlobPart type matches even
  // when callers hand us a Uint8Array backed by SharedArrayBuffer / a slice.
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  const blob = new Blob([copy], contentType ? { type: contentType } : undefined);
  fd.append("file", blob, filename);

  const res = await authedFetch("/api/GenericService/UploadFile", {
    method: "POST",
    body: fd,
    // Do NOT set Content-Type — fetch/FormData sets the multipart boundary.
  });
  return (await res.text()).trim();
}

// ---------------------------------------------------------------------------
// 3. CreateObject (MasterDataPackage)
// ---------------------------------------------------------------------------

async function createMasterDataPackage(
  name: string,
  file: CmfFile,
): Promise<MasterDataPackage> {
  const body: CreateObjectRequest = {
    $id: "1",
    $type: CMF_TYPES.CreateObjectInput,
    Object: {
      $id: "2",
      $type: CMF_TYPES.MasterDataPackage,
      Name: name,
      Type: "Generic",
      Revision: null,
      Package: {
        $id: "3",
        $type: CMF_TYPES.CmfFile,
        ...file,
        // Size MUST be a string. Belt-and-braces against numeric callers.
        Size: String(file.Size),
      },
    },
  };
  const res = await authedFetch("/api/GenericService/CreateObject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as CreateObjectResponse;
  return data.Object;
}

// ---------------------------------------------------------------------------
// 4. GetObjectById  (used for verify, fresh-load before write, and polling)
// ---------------------------------------------------------------------------

export async function getObjectById(id: string): Promise<MasterDataPackage> {
  const qs = new URLSearchParams({
    Id: id,
    Type: "MasterDataPackage",
    LevelsToLoad: "1",
  });
  const res = await authedFetch(`/api/GenericService/GetObjectById?${qs}`);
  const data = (await res.json()) as GetObjectByIdResponse;
  return data.Instance;
}

// ---------------------------------------------------------------------------
// 5. GetMasterDataPackageObjectTypes  (must POST the FULL fresh MDP for
//    concurrency-stamp parity)
// ---------------------------------------------------------------------------

export async function getObjectTypes(
  pkg: MasterDataPackage,
): Promise<UserFriendlyObjectType[]> {
  const body: GetMasterDataPackageObjectTypesRequest = {
    $id: "1",
    $type: CMF_TYPES.GetMasterDataPackageObjectTypesInput,
    MasterDataPackage: pkg,
  };
  const res = await authedFetch("/api/MasterData/GetMasterDataPackageObjectTypes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as GetMasterDataPackageObjectTypesResponse;
  return data.ObjectTypes ?? [];
}

// ---------------------------------------------------------------------------
// 6. PerformMasterDataPackage  (queues validate or load; returns immediately)
//    ExecutionConfiguration is a JSON-encoded STRING, not an object.
// ---------------------------------------------------------------------------

async function performMDP(
  pkg: MasterDataPackage,
  op: ExecutionOperation,
  types: UserFriendlyObjectType[],
): Promise<PerformMasterDataPackageResponse> {
  const body: PerformMasterDataPackageRequest = {
    $id: "1",
    $type: CMF_TYPES.PerformMasterDataPackageInput,
    MasterDataPackage: pkg,
    ExecutionOperation: op,
    ExecutionConfiguration: JSON.stringify(types),
    IsToPerformImmediate: true,
  };
  const res = await authedFetch("/api/MasterData/PerformMasterDataPackage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as PerformMasterDataPackageResponse;
}

// ---------------------------------------------------------------------------
// Polling — "is it done?" signal is LastExecutionEndDate != null.
// ---------------------------------------------------------------------------

export type PollOptions = { intervalMs?: number; maxAttempts?: number };

async function pollForCompletion(
  id: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? 1000;
  const maxAttempts = opts.maxAttempts ?? 60;

  for (let i = 0; i < maxAttempts; i++) {
    const instance = await getObjectById(id);
    if (instance.LastExecutionEndDate) {
      const log = JSON.parse(
        instance.LastExecutionLog ?? "[]",
      ) as ExecutionLogEntry[];
      return {
        result: instance.LastExecutionResult ?? 1,
        log,
        instance,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timeout waiting for MasterDataPackage ${id} to finish (${maxAttempts} attempts at ${intervalMs}ms)`,
  );
}

// ---------------------------------------------------------------------------
// Two-phase orchestrators — prepare (upload + discover) then execute (the
// user-chosen object types). The CMF portal works the same way: discovery
// happens before the user is asked which types to load.
// ---------------------------------------------------------------------------

export type PrepareMasterDataResult = {
  instance: MasterDataPackage;
  objectTypes: UserFriendlyObjectType[];
  uploaded: boolean;
};

/**
 * Steps 1–5: FileExists → UploadFile (if new) → CreateObject → fresh
 * GetObjectById → GetMasterDataPackageObjectTypes. Does NOT call performMDP;
 * the caller picks which types to load and then invokes `executeMasterData`.
 */
export async function prepareMasterData(
  name: string,
  file: { name: string; type?: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<PrepareMasterDataResult> {
  const bytes = await file.arrayBuffer();
  const checksum = sha256Upper(bytes);

  const alreadyOnServer = await fileExists(checksum);
  if (!alreadyOnServer) {
    await uploadFile(file.name, bytes, file.type);
  }

  const created = await createMasterDataPackage(name, {
    Filename: file.name,
    Size: String(file.size),
    Checksum: checksum,
    ContentType: file.type || "application/octet-stream",
  });

  // Fresh load for optimistic-concurrency stamps before any read/write call.
  const fresh = await getObjectById(created.Id);
  const objectTypes = await getObjectTypes(fresh);

  return { instance: fresh, objectTypes, uploaded: !alreadyOnServer };
}

export type ExecuteMasterDataResult = PollResult & {
  package: MasterDataPackage;
};

export type QueueMasterDataExecutionResult = {
  queued: true;
  packageId: string;
  message: string;
};

/**
 * Fire-and-forget queue: re-fetches the MDP for fresh concurrency stamps,
 * calls performMDP with the user-selected object types, and returns
 * immediately. The CMF server processes the execution asynchronously;
 * callers should poll `GET /api/cmf/packages/:id` (or call `getObjectById`)
 * to observe `LastExecutionLog` growing and `LastExecutionEndDate` flipping
 * non-null when complete. Prefer this over [[executeMasterData]] for
 * interactive flows where the client wants live progress.
 */
export async function queueMasterDataExecution(
  packageId: string,
  op: ExecutionOperation,
  selectedTypes: UserFriendlyObjectType[],
): Promise<QueueMasterDataExecutionResult> {
  if (!Array.isArray(selectedTypes) || selectedTypes.length === 0) {
    throw new Error(
      "queueMasterDataExecution: selectedTypes must be a non-empty array of UserFriendlyObjectType",
    );
  }

  const fresh = await getObjectById(packageId);
  await performMDP(fresh, op, selectedTypes);

  return {
    queued: true,
    packageId,
    message: `Queued ${op === 0 ? "Load (commit)" : "Validate (no write)"} for package ${packageId} (${selectedTypes.length} object type${selectedTypes.length === 1 ? "" : "s"})`,
  };
}

/**
 * Re-fetches the MDP for fresh concurrency stamps, calls performMDP with the
 * user-selected object types, then polls until completion. In THIS CMF
 * deployment the operations are inverted from the nominal docs (see
 * ExecutionOperation in lib/types.ts): op=0 = Load (COMMITS to the DB),
 * op=1 = Validate only (no write). lib/types.ts + the API routes are the
 * source of truth.
 *
 * @remarks New code should prefer [[queueMasterDataExecution]] paired with
 * client-side polling of `GET /api/cmf/packages/:id`, so the user sees live
 * log progress instead of one final blob. `executeMasterData` is retained
 * for synchronous server-side callers that genuinely want to await
 * completion.
 */
export async function executeMasterData(
  packageId: string,
  op: ExecutionOperation,
  selectedTypes: UserFriendlyObjectType[],
  pollOpts?: PollOptions,
): Promise<ExecuteMasterDataResult> {
  if (!Array.isArray(selectedTypes) || selectedTypes.length === 0) {
    throw new Error(
      "executeMasterData: selectedTypes must be a non-empty array of UserFriendlyObjectType",
    );
  }

  const fresh = await getObjectById(packageId);
  await performMDP(fresh, op, selectedTypes);

  const poll = await pollForCompletion(packageId, pollOpts);
  return { ...poll, package: poll.instance };
}
