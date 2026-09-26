/**
 * On-the-Fly MCP — AWS Secrets Manager helper.
 *
 * The uploaded credentials NEVER reach the chat/LLM. This module is the only
 * place the plaintext connection object touches: it is written to Secrets Manager
 * (under the mcp/onthefly/ prefix the runtime role is scoped to) and immediately
 * dropped from memory; callers keep only the returned ARN.
 *
 * Mirrors the singleton pattern in faborchestrator/lib/cmf/cmf-auth.ts. In prod
 * the admin EB instance role carries the scoped policy (deploy/cloudformation/mcp-onthefly.yaml).
 */
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { CredsDocSchema, type CredsDoc } from './types';

const REGION = process.env.AWS_REGION || 'us-west-2';
const SECRET_PREFIX = 'mcp/onthefly/';

let _sm: SecretsManagerClient | null = null;
function sm(): SecretsManagerClient {
  return (_sm ??= new SecretsManagerClient({ region: REGION }));
}

/** Sanitize a data-source name into a stable secret-name slug. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ds';
}

/**
 * Store the target connection object as a secret and return its ARN. The value
 * is tagged so the cost budget + orphan sweeper can find it.
 */
export async function createTargetSecret(params: {
  dataSourceId: string;
  name: string;
  creds: CredsDoc;
}): Promise<string> {
  const secretName = `${SECRET_PREFIX}${slug(params.name)}-${params.dataSourceId.slice(0, 8)}`;
  const res = await sm().send(
    new CreateSecretCommand({
      Name: secretName,
      SecretString: JSON.stringify(params.creds),
      Tags: [
        { Key: 'feature', Value: 'mcp-onthefly' },
        { Key: 'mcp_data_source_id', Value: params.dataSourceId },
      ],
    }),
  );
  if (!res.ARN) throw new Error('Secrets Manager did not return an ARN');
  return res.ARN;
}

/** Delete a target secret on retire (force, no recovery window — orphan cleanup). */
export async function deleteTargetSecret(secretArn: string): Promise<void> {
  await sm().send(
    new DeleteSecretCommand({ SecretId: secretArn, ForceDeleteWithoutRecovery: true }),
  );
}

/**
 * Read a stored target secret for a SERVER-SIDE comparison only (is this the same
 * login as the one just uploaded?). The value must never be returned to a route
 * response, the chat or a log. Returns null when the secret is gone or unreadable.
 */
export async function readTargetSecret(secretArn: string): Promise<CredsDoc | null> {
  try {
    const res = await sm().send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!res.SecretString) return null;
    const parsed = CredsDocSchema.safeParse(JSON.parse(res.SecretString));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Replace the value of an existing target secret (same login, new password). */
export async function rotateTargetSecret(secretArn: string, creds: CredsDoc): Promise<void> {
  await sm().send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify(creds) }));
}
