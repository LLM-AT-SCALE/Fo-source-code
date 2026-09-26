/**
 * LEGACY — kept for one release behind CMF_TOKEN_PROVISIONER=lambda. The app now
 * refreshes CMF tokens itself (modules/master-data-load/lib/cmf/token-refresh.ts,
 * portal-login.ts — the same login flow, in the fabinsight worker / admin pod).
 * The bundled `get-cmf-token.mjs` this imports is not in this repo; the built
 * artifact (cmf-token/runtime.zip) carries it.
 *
 * CMF token Lambda — mint the MES API JWT and store it in the Postgres
 * `cmf_bearer_tokens` table (the app's source of truth), keyed by TOKEN_DB_NAME.
 *
 * This is the SINGLE code template used for EVERY CMF connection. Only the env
 * inputs change per connection; the 45-min EventBridge schedule is identical.
 * The minting itself (headless Chromium portal login) is unchanged — see the
 * existing `get-cmf-token.mjs`, which this bundles as-is.
 *
 * Env:
 *   CMF_BASE_URL, CMF_USER, CMF_PASS, HOST_RESOLVER  — minting inputs (per connection)
 *   DATABASE_URL                                     — shared RDS (same for every connection)
 *   TOKEN_DB_NAME                                    — cmf_bearer_tokens key (per connection)
 *   CMF_TOKEN_SECRET_ID (optional, comma-separated)  — Secrets Manager DUAL-WRITE during
 *                                                      migration; drop once the DB path is proven.
 *
 * Secret/DB payload: { token, expiresAt } where expiresAt is ms epoch. In the DB
 * it is stored as a timestamptz (to_timestamp(expiresAt/1000)); the app reads it
 * back and compares against now() + a safety margin.
 *
 * Response: { ok: true, dbName, secrets, expiresAt } | { ok: false, error }.
 */
import pg from "pg";
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";

import { getCmfToken } from "./get-cmf-token.mjs";

const REGION = process.env.AWS_REGION || "us-west-2";

/**
 * PRIMARY store: UPSERT the token into Postgres, keyed by TOKEN_DB_NAME. A fresh
 * short-lived Client per invocation (the Lambda runs every ~45 min — no pooling
 * needed). ssl:false matches the app's POC RDS config; enable SSL here and on the
 * app together when the DB moves off POC mode.
 */
async function writeToPostgres(dbName, token, expiresAt) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set — cannot write the token to Postgres.");
  const client = new pg.Client({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    query_timeout: 15000,
  });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO cmf_bearer_tokens (cmf_database_name, token, expires_at, updated_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), now())
       ON CONFLICT (cmf_database_name) DO UPDATE
         SET token = EXCLUDED.token,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [dbName, token, expiresAt],
    );
  } finally {
    await client.end();
  }
}

// OPTIONAL legacy store (migration only): keep Secrets Manager in sync so readers
// that haven't cut over still work and rollback is trivial. Unchanged from the
// original Lambda.
const sm = new SecretsManagerClient({ region: REGION });
async function writeSecret(secretId, SecretString) {
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
  } catch (e) {
    if (e instanceof ResourceNotFoundException) {
      await sm.send(new CreateSecretCommand({ Name: secretId, SecretString }));
    } else {
      throw e;
    }
  }
}

export async function handler() {
  try {
    const { token, expiresAt } = await getCmfToken({
      baseUrl: process.env.CMF_BASE_URL,
      user: process.env.CMF_USER,
      pass: process.env.CMF_PASS,
      hostResolver: process.env.HOST_RESOLVER,
    });

    // PRIMARY: Postgres (the app's source of truth).
    const dbName = process.env.TOKEN_DB_NAME;
    if (!dbName) throw new Error("TOKEN_DB_NAME is not set — nowhere to store the token in Postgres.");
    await writeToPostgres(dbName, token, expiresAt);

    // OPTIONAL: dual-write to Secrets Manager while migrating (comma-separated ids).
    const secretIds = (process.env.CMF_TOKEN_SECRET_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (secretIds.length) {
      const SecretString = JSON.stringify({ token, expiresAt });
      for (const id of secretIds) await writeSecret(id, SecretString);
    }

    return { ok: true, dbName, secrets: secretIds, expiresAt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
