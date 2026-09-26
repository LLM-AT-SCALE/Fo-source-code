/**
 * On-the-Fly MCP — Step 1: SECURE credentials intake (dedicated, NOT the chat path).
 *
 * The admin uploads a credentials document here (multipart file) or posts a JSON
 * body. Credentials are parsed in memory, validated, written to AWS Secrets
 * Manager, and the DB keeps only the ARN + non-secret metadata. The plaintext
 * never enters a conversation, the LLM, messages, or prompt_audit_logs.
 *
 * POST multipart/form-data: file=<creds doc>, name, engine?, schemas (csv or JSON)
 * POST application/json:     { name, engine?, schemas: string[], creds: {...} }
 *
 * Credential reuse: when another data source already holds the same login
 * (host, port, database, user) the route answers 409 with `matches` and stores
 * nothing, so the dialog can offer them. The caller then resends with
 * `reuseFrom=<sourceId>` (share that source's secret; a different password in
 * the upload rotates the stored one) or `force=1` (store a new secret anyway).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';
import { CredsDocSchema, IntakeMetaSchema } from '@/modules/admin/lib/mcp/mcp-onthefly/types';
import { parseCredsDocument, extractCredsText } from '@/modules/admin/lib/mcp/mcp-onthefly/parse-creds';
import { createTargetSecret, readTargetSecret, rotateTargetSecret } from '@/modules/admin/lib/mcp/mcp-onthefly/secrets';
import { findReusableSources } from '@/modules/admin/lib/mcp/mcp-onthefly/reuse';

function parseSchemas(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) { try { return JSON.parse(t); } catch { /* fall through */ } }
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  // 1) Extract meta + creds from either multipart or JSON. Creds stay in memory.
  let meta: { name: string; engine: string; schemas: string[] };
  let credsRaw: Record<string, unknown>;
  let reuseFrom = '';
  let force = false;
  try {
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof Blob)) return NextResponse.json({ error: 'file is required' }, { status: 400 });
      const filename = (file as File).name || 'creds.txt';
      credsRaw = parseCredsDocument(await extractCredsText(file, filename));
      meta = {
        name: String(form.get('name') || ''),
        engine: String(form.get('engine') || 'postgres'),
        schemas: parseSchemas(form.get('schemas')),
      };
      reuseFrom = String(form.get('reuseFrom') || '');
      force = String(form.get('force') || '') === '1';
    } else {
      const body = await req.json();
      meta = { name: body.name, engine: body.engine || 'postgres', schemas: parseSchemas(body.schemas) };
      credsRaw = typeof body.creds === 'string' ? parseCredsDocument(body.creds) : (body.creds || {});
      reuseFrom = typeof body.reuseFrom === 'string' ? body.reuseFrom : '';
      force = body.force === true || body.force === '1';
    }
  } catch {
    return NextResponse.json({ error: 'Could not read the credentials input' }, { status: 400 });
  }

  // 2) Validate. Zod errors must not echo the secret value back.
  const metaParsed = IntakeMetaSchema.safeParse(meta);
  if (!metaParsed.success) {
    return NextResponse.json({ error: 'Invalid metadata', details: metaParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 400 });
  }
  const credsParsed = CredsDocSchema.safeParse(credsRaw);
  if (!credsParsed.success) {
    const missing = credsParsed.error.issues.map((i) => i.path.join('.'));
    // Report which field NAMES were recognized (never values) to aid diagnosis —
    // e.g. an unreadable/encoding-mangled file yields an empty foundFields.
    return NextResponse.json(
      { error: 'Credentials document is missing required fields', missingFields: missing, foundFields: Object.keys(credsRaw) },
      { status: 400 },
    );
  }
  const { name, engine, schemas } = metaParsed.data;
  const creds = credsParsed.data;

  // 2b) Same login already stored? Offer it instead of minting another secret.
  let reuseArn: string | null = null;
  let rotated = false;
  if (reuseFrom) {
    const src = await prisma.mcpDataSource.findUnique({ where: { id: reuseFrom } });
    if (!src || !src.secretArn || src.status === 'RETIRED') {
      return NextResponse.json({ error: 'The data source to reuse no longer has stored credentials' }, { status: 409 });
    }
    const stored = await readTargetSecret(src.secretArn);
    const sameLogin = !!stored
      && stored.host.trim().toLowerCase() === creds.host.trim().toLowerCase()
      && stored.database.trim().toLowerCase() === creds.database.trim().toLowerCase()
      && (stored.port ?? null) === (creds.port ?? null)
      && stored.user.trim().toLowerCase() === creds.user.trim().toLowerCase();
    if (!sameLogin) {
      return NextResponse.json({ error: 'The uploaded login does not match the data source you chose to reuse' }, { status: 409 });
    }
    if (stored && stored.password !== creds.password) {
      // Same login, new password: the admin is rotating it. One secret, one truth.
      try {
        await rotateTargetSecret(src.secretArn, creds);
        rotated = true;
      } catch (err) {
        const detail = `Could not update the stored credentials in AWS Secrets Manager — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
        console.error(`[mcp_otf] rotateTargetSecret failed for data source ${src.id}: ${detail}`);
        return NextResponse.json({ error: 'Failed to update the stored credentials', detail }, { status: 502 });
      }
    }
    reuseArn = src.secretArn;
  } else if (!force) {
    const matches = await findReusableSources(engine, creds);
    if (matches.length) {
      return NextResponse.json(
        {
          error: 'These credentials are already stored',
          matches: matches.map((m) => ({
            id: m.id, name: m.name, status: m.status, host: m.host, database: m.database,
            createdAt: m.createdAt, samePassword: m.samePassword,
          })),
        },
        { status: 409 },
      );
    }
  }

  // 3) Create the row first (need the id for the secret name/tag), then the secret.
  const row = await prisma.mcpDataSource.create({
    data: {
      name,
      engine,
      status: 'DRAFT',
      host: creds.host,
      port: creds.port,
      database: creds.database,
      schemasJson: schemas,
      createdById: auth.user.id,
    },
  });

  try {
    const secretArn = reuseArn ?? (await createTargetSecret({ dataSourceId: row.id, name, creds }));
    await prisma.mcpDataSource.update({ where: { id: row.id }, data: { secretArn } });
  } catch (err) {
    // Name the step so the admin (and the source card) can tell an AWS credential
    // problem from a bad document: the dialog shows this text verbatim.
    const detail = `Could not store the credentials in AWS Secrets Manager — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
    console.error(`[mcp_otf] createTargetSecret failed for data source ${row.id}: ${detail}`);
    await prisma.mcpDataSource.update({
      where: { id: row.id },
      data: { status: 'FAILED', lastError: detail },
    });
    // Surface the AWS error to the admin (no secret value is included in it).
    return NextResponse.json({ error: 'Failed to store credentials securely', detail }, { status: 502 });
  }

  await recordAuditLogDirect(prisma, {
    userId: auth.user.id,
    action: 'mcp_otf.source_created',
    targetType: 'McpDataSource',
    targetId: row.id,
    metadata: { name, engine, host: creds.host, database: creds.database, schemas, reusedSecretFrom: reuseFrom || undefined, rotated: rotated || undefined },
    ipAddress: getIpAddress(req),
  });

  // 4) Return ONLY non-secret metadata.
  return NextResponse.json(
    {
      id: row.id, name, status: 'DRAFT',
      metadata: { engine, host: creds.host, port: creds.port, database: creds.database, schemas },
      reusedSecretFrom: reuseFrom || undefined,
      rotated: rotated || undefined,
    },
    { status: 201 },
  );
}
