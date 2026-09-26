/**
 * On-the-Fly MCP — Step 2: connect to the target + discover its schema.
 *
 * Runs from the admin backend (in the shared VPC in prod), read-only. Reads the
 * target creds from Secrets Manager by ARN, does a `SELECT 1` reachability probe,
 * then reads information_schema for the admin-selected schemas. The discovered
 * snapshot feeds codegen; column COMMENTS/sample rows are intentionally NOT read
 * (prompt-injection surface — see the DOCX risk table).
 */
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CredsDocSchema, type CredsDoc } from './types';

const REGION = process.env.AWS_REGION || 'us-west-2';
const CONNECT_TIMEOUT_MS = Number(process.env.MCP_OTF_CONNECT_TIMEOUT_MS ?? '10000');

let _sm: SecretsManagerClient | null = null;
function sm(): SecretsManagerClient {
  return (_sm ??= new SecretsManagerClient({ region: REGION }));
}

async function readCreds(secretArn: string): Promise<CredsDoc> {
  const res = await sm().send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) throw new Error('target secret has no value');
  return CredsDocSchema.parse(JSON.parse(res.SecretString));
}

function newClient(creds: CredsDoc): Client {
  return new Client({
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    ssl: creds.ssl === false ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: 15000,
    // Read-only from the very first statement.
    options: '-c default_transaction_read_only=on',
  });
}

export interface ConnectResult {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

/** Reachability probe: SELECT 1. */
export async function testConnection(secretArn: string): Promise<ConnectResult> {
  const started = Date.now();
  let client: Client | null = null;
  try {
    const creds = await readCreds(secretArn);
    client = newClient(creds);
    await client.connect();
    await client.query('SELECT 1');
    return { reachable: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client?.end().catch(() => {});
  }
}

interface DiscoveredColumn { column: string; type: string; nullable: boolean }
interface DiscoveredTable { schema: string; table: string; columns: DiscoveredColumn[] }
export interface DiscoveryResult { tables: DiscoveredTable[] }

/**
 * Read information_schema tables/columns for the given schemas. Parameterized;
 * caps the number of tables to keep the codegen prompt bounded.
 */
export async function discoverSchema(secretArn: string, schemas: string[]): Promise<DiscoveryResult> {
  const MAX_TABLES = 200;
  let client: Client | null = null;
  try {
    const creds = await readCreds(secretArn);
    client = newClient(creds);
    await client.connect();
    const { rows } = await client.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = ANY($1::text[])
        ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );
    const byTable = new Map<string, DiscoveredTable>();
    for (const r of rows as Array<Record<string, string>>) {
      const key = `${r.table_schema}.${r.table_name}`;
      let t = byTable.get(key);
      if (!t) {
        if (byTable.size >= MAX_TABLES) break;
        t = { schema: r.table_schema, table: r.table_name, columns: [] };
        byTable.set(key, t);
      }
      t.columns.push({ column: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' });
    }
    return { tables: [...byTable.values()] };
  } finally {
    await client?.end().catch(() => {});
  }
}
