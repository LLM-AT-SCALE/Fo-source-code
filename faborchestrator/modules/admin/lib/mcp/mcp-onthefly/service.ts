/**
 * On-the-Fly MCP — pipeline SERVICE layer (single source of truth).
 *
 * Encapsulates the orchestration for each lifecycle step (connect → generate →
 * deploy → assign → list). Both the REST routes (app/api/admin/mcp/sources/*) and
 * the admin chat tools (lib/admin-tools.ts) call these, so the read-only gates,
 * status transitions, and audit trail live in ONE place.
 *
 * Functions return a discriminated result `{ ok, httpStatus?, error?, ... }`
 * instead of throwing for expected conditions, so routes can map to HTTP and
 * tools can surface a friendly message.
 */
import prisma from '@/shared/lib/db';
import { encrypt, decrypt } from '@/shared/lib/encryption';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import { testConnection, discoverSchema, type DiscoveryResult } from './connectivity';
import { discoverViaLambda, DISCOVERY_FUNCTION_NAME, type DiscoverViaLambdaResult } from './discover-lambda';
import { recordCaptured } from '@/shared/lib/errors/capture';
import { FabOrchErrorType } from '@/shared/lib/errors/faborch-errors';
import { invokeRuntimeRpc, functionNameFromServerUrl } from './invoke';
import { generateManifest } from './codegen';
import { staticCheckManifest } from './manifest-guard';
import { deployRuntime } from './deploy';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; httpStatus: number; error: string; details?: unknown };
type Result<T> = Ok<T> | Err;

const CHAT_IP = 'chat-admin';
function err(httpStatus: number, error: string, details?: unknown): Err {
  return { ok: false, httpStatus, error, details };
}

// ── list ────────────────────────────────────────────────────────────────────
export async function listDataSources() {
  const sources = await prisma.mcpDataSource.findMany({ orderBy: { createdAt: 'desc' } });
  return sources.map((s) => ({
    id: s.id, name: s.name, engine: s.engine, status: s.status,
    host: s.host, database: s.database, schemas: s.schemasJson,
    endpointUrl: s.endpointUrl, registryId: s.registryId, lastError: s.lastError,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  }));
}

// ── Step 2: connect + discover ────────────────────────────────────────────────
export async function connectDataSource(
  id: string, adminUserId: string, ipAddress: string = CHAT_IP,
): Promise<Result<{ latencyMs?: number; tableCount: number; tables: string[] }>> {
  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return err(404, 'Data source not found');
  if (!ds.secretArn) return err(409, 'Credentials not yet stored for this data source');

  const schemas = Array.isArray(ds.schemasJson) ? (ds.schemasJson as string[]) : [];
  const engine = ds.engine === 'sqlserver' ? 'sqlserver' : 'postgres';

  // Discovery ALWAYS happens from inside the VPC via the shared discovery Lambda —
  // that's the only place with a route to the target (on-prem SQL Server over the
  // VPN, in-VPC/peered Postgres, or public via NAT). The admin app never connects
  // to target DBs directly; the creds stay in AWS (read by the Lambda from Secrets
  // Manager). For a plain public Postgres we fall back to a direct probe if the
  // discovery Lambda isn't provisioned yet.
  let discovery: DiscoveryResult | null = null;
  // Retry the in-VPC discovery: the first call can be a slow cold start (ENI + VPN
  // + named-instance SQL Browser lookup).
  let viaLambda: DiscoverViaLambdaResult = { ok: false, error: 'not attempted' };
  for (let attempt = 0; attempt < 2; attempt++) {
    viaLambda = await discoverViaLambda(ds.secretArn, engine, schemas).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : 'invoke failed' }));
    if (viaLambda.ok) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  if (viaLambda.ok && viaLambda.tables) {
    discovery = { tables: viaLambda.tables };
  } else if (engine === 'postgres') {
    // Fallback: direct probe (only works if the admin app can reach the target).
    const conn = await testConnection(ds.secretArn);
    if (conn.reachable) {
      try { discovery = await discoverSchema(ds.secretArn, schemas); } catch { /* fall through to error */ }
    }
  }

  if (!discovery) {
    const reason = viaLambda.error || 'target unreachable and no discovery path succeeded';
    const kind = viaLambda.kind ?? 'target';
    console.error(`[mcp_otf] discovery failed for data source ${id} (${kind}): ${reason}`);
    await prisma.mcpDataSource.update({ where: { id }, data: { status: 'FAILED', lastError: `discovery failed: ${reason}` } });
    // A platform failure is the platform team's to fix, not the admin's: record
    // it so Admin → Errors holds the real cause under an id the chat can quote.
    let errorId: string | undefined;
    if (kind === 'platform') {
      errorId = recordCaptured(
        {
          system: 'On-the-fly MCP discovery service',
          operation: 'connectDataSource',
          target: DISCOVERY_FUNCTION_NAME,
          userId: adminUserId,
          type: FabOrchErrorType.LAMBDA_MCP_CRASH,
          extra: { dataSourceId: id, engine },
        },
        new Error(reason),
      ).detail.errorId;
    }
    return err(502, `Discovery failed: ${reason}`, { kind, errorId });
  }

  await prisma.mcpDataSource.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { status: 'CONNECTED', discoveredSchema: discovery as any, lastError: null },
  });
  await recordAuditLogDirect(prisma, {
    userId: adminUserId, action: 'mcp_otf.connected', targetType: 'McpDataSource', targetId: id,
    metadata: { tableCount: discovery.tables.length, via: viaLambda.ok ? 'lambda' : 'direct' }, ipAddress,
  });

  return {
    ok: true, tableCount: discovery.tables.length,
    tables: discovery.tables.map((t) => `${t.schema}.${t.table}`),
  };
}

// ── Step 2 (manual): set the schema for a target the admin app can't reach ────
// For on-prem SQL Server (and any target unreachable from the admin app), the
// operator supplies the tables/columns; this stands in for auto-discovery so the
// pipeline can proceed to generate + deploy (the CMF-VPC runtime reaches the DB
// at query time).
export interface ManualTable { schema: string; table: string; columns: { column: string; type: string; nullable?: boolean }[] }

export async function setDataSourceSchema(
  id: string, tables: ManualTable[], adminUserId: string, ipAddress: string = CHAT_IP,
): Promise<Result<{ tableCount: number }>> {
  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return err(404, 'Data source not found');
  if (!tables?.length) return err(400, 'Provide at least one table with columns');

  const discovery = {
    tables: tables.map((t) => ({
      schema: t.schema, table: t.table,
      columns: (t.columns || []).map((c) => ({ column: c.column, type: c.type, nullable: c.nullable ?? false })),
    })),
  };
  await prisma.mcpDataSource.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { status: 'CONNECTED', discoveredSchema: discovery as any, lastError: null },
  });
  await recordAuditLogDirect(prisma, {
    userId: adminUserId, action: 'mcp_otf.schema_set', targetType: 'McpDataSource', targetId: id,
    metadata: { tableCount: discovery.tables.length, manual: true }, ipAddress,
  });
  return { ok: true, tableCount: discovery.tables.length };
}

// ── Step 3: generate manifest ─────────────────────────────────────────────────
export async function generateDataSourceManifest(
  id: string, adminUserId: string, ipAddress: string = CHAT_IP,
) {
  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return err(404, 'Data source not found');
  if (!ds.discoveredSchema) return err(409, 'Connect + discover first (status must be CONNECTED)');

  const schemas = Array.isArray(ds.schemasJson) ? (ds.schemasJson as string[]) : [];
  let gen;
  try {
    gen = await generateManifest({
      meta: { name: ds.name, engine: ds.engine === 'sqlserver' ? 'sqlserver' : 'postgres', schemas },
      discovery: ds.discoveredSchema as unknown as DiscoveryResult,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'generation failed';
    console.error(`[mcp_otf] manifest generation failed for data source ${id}: ${reason}`);
    await prisma.mcpDataSource.update({ where: { id }, data: { status: 'FAILED', lastError: reason } });
    return err(502, `Manifest generation failed: ${reason}`);
  }

  await prisma.mcpDataSource.update({
    where: { id },
    data: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manifest: (gen.manifest as any) ?? undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      staticCheck: gen.staticCheck as any,
      status: gen.staticCheck.ok ? 'GENERATED' : 'FAILED',
      lastError: gen.staticCheck.ok ? null : `manifest rejected: ${gen.staticCheck.errors.join('; ')}`,
    },
  });
  await recordAuditLogDirect(prisma, {
    userId: adminUserId, action: 'mcp_otf.generated', targetType: 'McpDataSource', targetId: id,
    metadata: { ok: gen.staticCheck.ok, toolCount: gen.staticCheck.toolCount, errors: gen.staticCheck.errors }, ipAddress,
  });

  if (!gen.staticCheck.ok) return err(422, `Manifest rejected: ${gen.staticCheck.errors.join('; ')}`, gen.staticCheck);
  // Total tables that discovery exposed for this source (bounded set for huge
  // schemas). Used to tell "we tooled EVERY table" apart from "focused subset".
  const discoveredTableCount = ((ds.discoveredSchema as unknown as DiscoveryResult).tables || []).length;
  return { ok: true as const, staticCheck: gen.staticCheck, manifest: gen.manifest, discoveredTableCount };
}

// ── Step 4+5: deploy + validate + register ────────────────────────────────────
async function validateEndpoint(endpointUrl: string, bearer: string): Promise<boolean> {
  const fn = functionNameFromServerUrl(endpointUrl);
  if (!fn) return false;
  // First call is a cold start (VPC ENI + VPN + DB connect); retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rpc = await invokeRuntimeRpc(fn, bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((rpc as any)?.result?.tools) return true;
    } catch {
      /* retry once */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function deployDataSource(
  id: string, adminUserId: string, ipAddress: string = CHAT_IP,
): Promise<Result<{ status: string; registryId: string; endpointUrl: string; toolCount: number }>> {
  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return err(404, 'Data source not found');
  if (!ds.secretArn) return err(409, 'No stored credentials');
  // Allow first deploy (GENERATED) and re-deploy (ACTIVE/FAILED) with a stored manifest.
  if (!ds.manifest || !['GENERATED', 'ACTIVE', 'FAILED'].includes(ds.status)) {
    return err(409, 'Generate a valid manifest first (status must be GENERATED; ACTIVE/FAILED can re-deploy)');
  }

  // Re-run the static gate on the stored manifest — never deploy unchecked.
  const { result, manifest } = staticCheckManifest(ds.manifest);
  if (!result.ok || !manifest) return err(422, 'Stored manifest failed the static safety check', result.errors);

  await prisma.mcpDataSource.update({ where: { id }, data: { status: 'DEPLOYING', lastError: null } });

  // On re-deploy, reuse the existing bearer so already-assigned FO connections
  // (which stored that bearer at assignment time) keep working.
  let existingBearer: string | undefined;
  if (ds.endpointAuthEncrypted) {
    try { existingBearer = decrypt(ds.endpointAuthEncrypted); } catch { /* mint a new one */ }
  }

  let deployed;
  try {
    deployed = await deployRuntime({
      dataSourceId: id, secretArn: ds.secretArn, manifest,
      engine: ds.engine === 'sqlserver' ? 'sqlserver' : 'postgres',
      existingBearer,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'deploy failed';
    console.error(`[mcp_otf] deploy failed for data source ${id}: ${reason}`);
    await prisma.mcpDataSource.update({ where: { id }, data: { status: 'FAILED', lastError: reason } });
    return err(502, `Deployment failed: ${reason}`);
  }

  try {
    const ok = await validateEndpoint(deployed.endpointUrl, deployed.bearer);
    if (!ok) throw new Error('validation tools/list did not return tools');
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'validation failed';
    console.error(`[mcp_otf] post-deploy validation failed for data source ${id}: ${reason}`);
    await prisma.mcpDataSource.update({
      where: { id },
      data: { status: 'FAILED', lambdaArn: deployed.lambdaArn, endpointUrl: deployed.endpointUrl, lastError: reason },
    });
    return err(502, `Deployed but failed validation: ${reason}`);
  }

  const registryData = {
    displayName: ds.name,
    description: `On-the-fly MCP (${ds.engine}) for ${ds.database ?? 'data source'}`,
    serverUrl: deployed.endpointUrl,
    authType: 'api_key',
    authCredentialsEncrypted: encrypt(JSON.stringify({ apiKey: deployed.bearer })),
    isActive: true,
  };
  // Create the registry entry, or UPDATE it on re-deploy (and keep already-assigned
  // FO connections in sync) so re-deploying doesn't orphan the assignment.
  const existingRegistry = ds.registryId ? await prisma.mcpRegistry.findUnique({ where: { id: ds.registryId } }) : null;
  let registryId: string;
  if (existingRegistry) {
    await prisma.mcpRegistry.update({ where: { id: existingRegistry.id }, data: registryData });
    registryId = existingRegistry.id;
    await prisma.mcpConnection.updateMany({
      where: { registryId },
      data: { serverUrl: deployed.endpointUrl, authCredentialsEncrypted: registryData.authCredentialsEncrypted },
    });
  } else {
    const created = await prisma.mcpRegistry.create({ data: registryData });
    registryId = created.id;
  }

  await prisma.mcpDataSource.update({
    where: { id },
    data: {
      status: 'ACTIVE', lambdaArn: deployed.lambdaArn, endpointUrl: deployed.endpointUrl,
      endpointAuthEncrypted: encrypt(deployed.bearer), runtimeVersion: deployed.runtimeVersion,
      registryId, lastError: null,
    },
  });
  await recordAuditLogDirect(prisma, {
    userId: adminUserId, action: 'mcp_otf.deployed', targetType: 'McpDataSource', targetId: id,
    metadata: { lambdaArn: deployed.lambdaArn, registryId, toolCount: result.toolCount }, ipAddress,
  });

  return { ok: true, status: 'ACTIVE', registryId, endpointUrl: deployed.endpointUrl, toolCount: result.toolCount };
}

// ── Step 6a: assign the registered server to a role or user ───────────────────
export async function assignDataSource(
  id: string, target: { roleId?: string; userId?: string }, adminUserId: string, ipAddress: string = CHAT_IP,
): Promise<Result<{ connectionId: string; target: string }>> {
  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return err(404, 'Data source not found');
  if (ds.status !== 'ACTIVE' || !ds.registryId) return err(409, 'Deploy the data source first (status must be ACTIVE)');
  if (!target.roleId && !target.userId) return err(400, 'Provide a role or user to assign to');

  const connector = await prisma.mcpRegistry.findUnique({ where: { id: ds.registryId } });
  if (!connector) return err(404, 'Registry entry missing for this data source');

  let targetName = '';
  if (target.roleId) {
    const role = await prisma.role.findUnique({ where: { id: target.roleId } });
    if (!role) return err(404, 'Role not found');
    targetName = role.name;
  } else {
    const user = await prisma.user.findUnique({ where: { id: target.userId } });
    if (!user) return err(404, 'User not found');
    targetName = user.name || user.email;
  }

  const dupe = await prisma.mcpConnection.findFirst({
    where: { registryId: ds.registryId, ...(target.roleId ? { roleId: target.roleId } : { userId: target.userId }) },
  });
  if (dupe) return err(409, 'Already assigned to that target');

  const conn = await prisma.mcpConnection.create({
    data: {
      userId: target.userId || null, roleId: target.roleId || null, registryId: ds.registryId,
      name: connector.displayName, serverUrl: connector.serverUrl, authType: connector.authType,
      authCredentialsEncrypted: connector.authCredentialsEncrypted,
    },
  });
  await recordAuditLogDirect(prisma, {
    userId: adminUserId, action: target.roleId ? 'mcp.assigned_to_role' : 'mcp.assigned_to_user',
    targetType: 'McpConnection', targetId: conn.id, metadata: { dataSourceId: id, target: targetName }, ipAddress,
  });

  return { ok: true, connectionId: conn.id, target: targetName };
}

// ── Step 6b: REMOVE a role/user's access (the opposite of assign) ─────────────
export async function unassignDataSource(
  id: string, target: { roleId?: string; userId?: string }, adminUserId: string, ipAddress: string = CHAT_IP,
): Promise<Result<{ removed: number; target: string }>> {
  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return err(404, 'Data source not found');
  if (!ds.registryId) return err(409, 'This data source has not been deployed/assigned yet');
  if (!target.roleId && !target.userId) return err(400, 'Provide a role or user to remove access from');

  let targetName = '';
  if (target.roleId) {
    const role = await prisma.role.findUnique({ where: { id: target.roleId } });
    if (!role) return err(404, 'Role not found');
    targetName = role.name;
  } else {
    const user = await prisma.user.findUnique({ where: { id: target.userId } });
    if (!user) return err(404, 'User not found');
    targetName = user.name || user.email;
  }

  const del = await prisma.mcpConnection.deleteMany({
    where: { registryId: ds.registryId, ...(target.roleId ? { roleId: target.roleId } : { userId: target.userId }) },
  });
  if (del.count === 0) return err(404, `That data source is not currently assigned to ${targetName}`);

  await recordAuditLogDirect(prisma, {
    userId: adminUserId, action: target.roleId ? 'mcp.unassigned_from_role' : 'mcp.unassigned_from_user',
    targetType: 'McpConnection', targetId: id, metadata: { dataSourceId: id, target: targetName, removed: del.count }, ipAddress,
  });

  return { ok: true, removed: del.count, target: targetName };
}
