/**
 * CMF MES API token provider (READ side).
 *
 * The CMF Bearer JWT is minted by the in-app refresher
 * (./token-refresh.ts — the scheduler's `cmf-token` stage every ~45 min, plus an
 * immediate fetch when an admin saves a connection) and stored in the
 * `cmf_bearer_tokens` table keyed by the connection's `token_db_name`. This
 * module only READS it: from the table first, then — legacy fallback for a row
 * that still names a Secrets Manager secret written by the old token Lambda —
 * from AWS Secrets Manager. The value is cached in memory and re-read ONLY when
 * `expiresAt` is near, never on every request.
 *
 * Why read at runtime instead of an env var? The token ROTATES (~45 min) and
 * each JWT is valid only ~50 min. An env var is fixed at process start, so it
 * would go stale within the hour. WHERE we read (secret id / region / refresh
 * margin) is env-configurable; the token VALUE is always fetched live + cached.
 *
 * Secret payload shape: { token: "<jwt>", expiresAt: <ms epoch> }.
 *
 * IAM: the app/Lambda role needs `secretsmanager:GetSecretValue` on
 * arn:aws:secretsmanager:us-west-2:628203515088:secret:cmf/portal-token-entegris-224-*.
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { currentDbKey } from "@/modules/master-data-load/lib/cmf/db-context";
import { profileFor } from "@/modules/master-data-load/lib/cmf/db-registry";
import { prisma } from "@/shared/lib/db";

const REGION = process.env.CMF_TOKEN_REGION ?? process.env.AWS_REGION ?? "us-west-2";
const MARGIN_MS = Number(process.env.TOKEN_SAFETY_MARGIN_SEC ?? "60") * 1000;

type TokenCache = { token: string; expiresAt: number };

// Token cache + in-flight refresh are keyed by SECRET ID (not dbKey): the app
// targets two CMF databases with two distinct token secrets, and keying by the
// actual secret keeps a source refresh from ever satisfying a target waiter (or
// vice versa) — and dedupes if two DBs ever share a secret.
const caches = new Map<string, TokenCache | null>();
const inflights = new Map<string, Promise<string> | null>();

let _sm: SecretsManagerClient | null = null;
function sm(): SecretsManagerClient {
  return (_sm ??= new SecretsManagerClient({ region: REGION }));
}

class TokenUnavailableError extends Error {}

async function readTokenFromSecretsManager(secretId: string): Promise<TokenCache> {
  let secretString: string | undefined;
  try {
    const res = await sm().send(new GetSecretValueCommand({ SecretId: secretId }));
    secretString = res.SecretString;
  } catch (err) {
    throw new TokenUnavailableError(
      `Could not read the CMF token secret "${secretId}" (${REGION}). It is refreshed on a schedule (~45 min); check IAM (secretsmanager:GetSecretValue) and retry. Cause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!secretString) {
    throw new TokenUnavailableError(`CMF token secret "${secretId}" has no SecretString.`);
  }
  let parsed: { token?: string; expiresAt?: number };
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new TokenUnavailableError("CMF token secret is not valid JSON.");
  }
  if (!parsed.token || !parsed.expiresAt) {
    throw new TokenUnavailableError("CMF token secret is missing token/expiresAt.");
  }
  return { token: parsed.token, expiresAt: Number(parsed.expiresAt) };
}

function valid(entry: TokenCache | null | undefined): entry is TokenCache {
  return !!entry && Date.now() < entry.expiresAt - MARGIN_MS;
}

/**
 * Read the current token from the DB-backed `cmf_bearer_tokens` table, which the
 * in-app refresher UPSERTs every ~45 min (keyed by the connection's token_db_name). Returns null
 * (never throws) so the caller can fall back to Secrets Manager during migration
 * or if the row isn't populated yet. Requires a non-null `expires_at` so we can
 * tell whether the JWT is still valid.
 */
async function readTokenFromDb(tokenDbName: string): Promise<TokenCache | null> {
  try {
    const row = await prisma.cmfBearerToken.findUnique({ where: { cmfDatabaseName: tokenDbName } });
    if (!row?.token || !row.expiresAt) return null;
    return { token: row.token, expiresAt: new Date(row.expiresAt).getTime() };
  } catch (e) {
    console.error(`[cmf-auth] DB token read failed for "${tokenDbName}" — will try Secrets Manager`, e);
    return null;
  }
}

/**
 * Return a valid MES API Bearer token for the currently-selected CMF database.
 * Refreshes only when the cached token is within MARGIN_MS of expiry. Throws
 * TokenUnavailableError if no valid token can currently be read.
 */
export async function getMesToken(): Promise<string> {
  const profile = profileFor(currentDbKey());
  // Cache keyed by the token's DB name (the new source of truth); fall back to
  // the secret id for connections that only have a Secrets Manager source.
  const cacheKey = profile.tokenDbName || profile.tokenSecretId;
  const cached = caches.get(cacheKey);
  if (valid(cached)) return cached.token;
  const pending = inflights.get(cacheKey);
  if (pending) return pending;

  const p = (async () => {
    try {
      // DB first (written by the in-app refresher), Secrets Manager as the legacy fallback.
      let entry: TokenCache | null = profile.tokenDbName ? await readTokenFromDb(profile.tokenDbName) : null;
      if (!valid(entry) && profile.tokenSecretId) {
        entry = await readTokenFromSecretsManager(profile.tokenSecretId);
      }
      if (!valid(entry)) {
        throw new TokenUnavailableError(
          "No valid CMF token is available (the DB token table and Secrets Manager are both empty or expired). " +
            "The token is refreshed on a schedule (~45 min); retry shortly.",
        );
      }
      caches.set(cacheKey, entry);
      return entry.token;
    } finally {
      inflights.set(cacheKey, null);
    }
  })();
  inflights.set(cacheKey, p);
  return p;
}
