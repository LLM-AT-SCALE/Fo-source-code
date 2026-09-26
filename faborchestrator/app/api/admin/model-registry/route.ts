/**
 * Model Registry — the catalog of selectable AI models and their pricing.
 * GET: list all models (ordered by sortOrder asc, then displayName)
 * POST: add a new model (unique modelId; single-default enforced)
 *
 * NOTE: the `model_registry` table may not exist yet (migration runs
 * separately from prisma/create_model_registry.sql). Every DB access is
 * wrapped so a missing table never crashes the route: reads return an empty
 * list, writes return a 503 telling the admin to run the SQL.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';

const THINKING_TYPES = ['none', 'adaptive', 'manual'] as const;

/** True when the error is Prisma's "table does not exist" (migration not run). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isMissingTable(error: any): boolean {
  return (
    error?.code === 'P2021' ||
    (typeof error?.message === 'string' && error.message.includes('does not exist'))
  );
}

const MISSING_TABLE_MESSAGE =
  'Model registry table not found. Run prisma/create_model_registry.sql against the database.';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialize(m: any) {
  return {
    id: m.id,
    modelId: m.modelId,
    displayName: m.displayName,
    description: m.description,
    inputCostPer1M: m.inputCostPer1M,
    outputCostPer1M: m.outputCostPer1M,
    cacheReadCostPer1M: m.cacheReadCostPer1M,
    cacheWriteCostPer1M: m.cacheWriteCostPer1M,
    thinkingType: m.thinkingType,
    thinkingBudget: m.thinkingBudget,
    isActive: m.isActive,
    isDefault: m.isDefault,
    sortOrder: m.sortOrder,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const models = await prisma.modelRegistry.findMany({
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    });
    return NextResponse.json({ models: models.map(serialize) });
  } catch (error) {
    if (isMissingTable(error)) {
      // Table not migrated yet — degrade gracefully to an empty catalog.
      return NextResponse.json({ models: [], tableMissing: true });
    }
    console.error('List model registry error:', error);
    return NextResponse.json({ error: 'Failed to list models' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const modelId = String(body.modelId ?? '').trim();
  const displayName = String(body.displayName ?? '').trim();

  if (!modelId) return NextResponse.json({ error: 'Model ID is required' }, { status: 400 });
  if (!displayName) return NextResponse.json({ error: 'Display name is required' }, { status: 400 });

  const thinkingType = String(body.thinkingType ?? 'adaptive');
  if (!THINKING_TYPES.includes(thinkingType as (typeof THINKING_TYPES)[number])) {
    return NextResponse.json({ error: 'Invalid thinking type' }, { status: 400 });
  }

  // Cost fields must be numbers >= 0.
  const costFields = [
    'inputCostPer1M',
    'outputCostPer1M',
    'cacheReadCostPer1M',
    'cacheWriteCostPer1M',
  ] as const;
  const costs: Record<string, number> = {};
  for (const field of costFields) {
    const raw = body[field];
    const num = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      return NextResponse.json({ error: `${field} must be a number >= 0` }, { status: 400 });
    }
    costs[field] = num;
  }

  let thinkingBudget: number | null = null;
  if (body.thinkingBudget !== undefined && body.thinkingBudget !== null && body.thinkingBudget !== '') {
    const tb = Number(body.thinkingBudget);
    if (!Number.isInteger(tb) || tb < 0) {
      return NextResponse.json({ error: 'thinkingBudget must be a non-negative integer' }, { status: 400 });
    }
    thinkingBudget = tb;
  }

  const sortOrder = body.sortOrder === undefined || body.sortOrder === null || body.sortOrder === ''
    ? 0
    : Number(body.sortOrder);
  if (!Number.isFinite(sortOrder)) {
    return NextResponse.json({ error: 'sortOrder must be a number' }, { status: 400 });
  }

  const isActive = body.isActive === undefined ? true : !!body.isActive;
  const isDefault = !!body.isDefault;
  const description = body.description ? String(body.description).trim() : null;

  try {
    // Uniqueness — no duplicate modelId.
    const dupe = await prisma.modelRegistry.findUnique({ where: { modelId } });
    if (dupe) {
      return NextResponse.json({ error: 'A model with this Model ID already exists' }, { status: 409 });
    }

    const model = await prisma.$transaction(async (tx) => {
      // Single-default invariant: unset all others first.
      if (isDefault) {
        await tx.modelRegistry.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      const created = await tx.modelRegistry.create({
        data: {
          modelId,
          displayName,
          description,
          inputCostPer1M: costs.inputCostPer1M,
          outputCostPer1M: costs.outputCostPer1M,
          cacheReadCostPer1M: costs.cacheReadCostPer1M,
          cacheWriteCostPer1M: costs.cacheWriteCostPer1M,
          thinkingType,
          thinkingBudget,
          isActive,
          isDefault,
          sortOrder: Math.trunc(sortOrder),
        },
      });
      await recordAuditLogDirect(tx, {
        userId: auth.user.id,
        action: 'model.created',
        targetType: 'ModelRegistry',
        targetId: created.id,
        metadata: { modelId, displayName, isDefault },
        ipAddress: getIpAddress(req),
      });
      return created;
    });

    return NextResponse.json({ id: model.id, displayName: model.displayName }, { status: 201 });
  } catch (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ error: MISSING_TABLE_MESSAGE }, { status: 503 });
    }
    console.error('Create model error:', error);
    return NextResponse.json({ error: 'Failed to create model' }, { status: 500 });
  }
}
