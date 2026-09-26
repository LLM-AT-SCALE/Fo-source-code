/**
 * Model Registry single model.
 * PATCH: edit any field (single-default enforced).
 * DELETE: remove a model (deleting the default is allowed).
 *
 * The `model_registry` table may not exist yet (see prisma/create_model_registry.sql).
 * Writes against a missing table return a 503 rather than crashing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';

const THINKING_TYPES = ['none', 'adaptive', 'manual'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isMissingTable(error: any): boolean {
  return (
    error?.code === 'P2021' ||
    (typeof error?.message === 'string' && error.message.includes('does not exist'))
  );
}

const MISSING_TABLE_MESSAGE =
  'Model registry table not found. Run prisma/create_model_registry.sql against the database.';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const existing = await prisma.modelRegistry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Model not found' }, { status: 404 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};

    if (body.modelId !== undefined) {
      const modelId = String(body.modelId).trim();
      if (!modelId) return NextResponse.json({ error: 'Model ID cannot be empty' }, { status: 400 });
      if (modelId !== existing.modelId) {
        const dupe = await prisma.modelRegistry.findUnique({ where: { modelId } });
        if (dupe) return NextResponse.json({ error: 'A model with this Model ID already exists' }, { status: 409 });
      }
      data.modelId = modelId;
    }

    if (body.displayName !== undefined) {
      const displayName = String(body.displayName).trim();
      if (!displayName) return NextResponse.json({ error: 'Display name cannot be empty' }, { status: 400 });
      data.displayName = displayName;
    }

    if (body.description !== undefined) {
      data.description = body.description ? String(body.description).trim() : null;
    }

    const costFields = [
      'inputCostPer1M',
      'outputCostPer1M',
      'cacheReadCostPer1M',
      'cacheWriteCostPer1M',
    ] as const;
    for (const field of costFields) {
      if (body[field] === undefined) continue;
      const raw = body[field];
      const num = raw === null || raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        return NextResponse.json({ error: `${field} must be a number >= 0` }, { status: 400 });
      }
      data[field] = num;
    }

    if (body.thinkingType !== undefined) {
      const thinkingType = String(body.thinkingType);
      if (!THINKING_TYPES.includes(thinkingType as (typeof THINKING_TYPES)[number])) {
        return NextResponse.json({ error: 'Invalid thinking type' }, { status: 400 });
      }
      data.thinkingType = thinkingType;
    }

    if (body.thinkingBudget !== undefined) {
      if (body.thinkingBudget === null || body.thinkingBudget === '') {
        data.thinkingBudget = null;
      } else {
        const tb = Number(body.thinkingBudget);
        if (!Number.isInteger(tb) || tb < 0) {
          return NextResponse.json({ error: 'thinkingBudget must be a non-negative integer' }, { status: 400 });
        }
        data.thinkingBudget = tb;
      }
    }

    if (body.sortOrder !== undefined) {
      const so = body.sortOrder === null || body.sortOrder === '' ? 0 : Number(body.sortOrder);
      if (!Number.isFinite(so)) return NextResponse.json({ error: 'sortOrder must be a number' }, { status: 400 });
      data.sortOrder = Math.trunc(so);
    }

    if (body.isActive !== undefined) data.isActive = !!body.isActive;

    const settingDefault = body.isDefault !== undefined && !!body.isDefault;
    if (body.isDefault !== undefined) data.isDefault = !!body.isDefault;

    await prisma.$transaction(async (tx) => {
      // Single-default invariant: unset all others before setting this one.
      if (settingDefault) {
        await tx.modelRegistry.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      await tx.modelRegistry.update({ where: { id }, data });
      await recordAuditLogDirect(tx, {
        userId: auth.user.id,
        action: 'model.updated',
        targetType: 'ModelRegistry',
        targetId: id,
        metadata: { modelId: data.modelId ?? existing.modelId, fields: Object.keys(data) },
        ipAddress: getIpAddress(req),
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ error: MISSING_TABLE_MESSAGE }, { status: 503 });
    }
    console.error('Update model error:', error);
    return NextResponse.json({ error: 'Failed to update model' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const existing = await prisma.modelRegistry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Model not found' }, { status: 404 });

    await prisma.$transaction(async (tx) => {
      await tx.modelRegistry.delete({ where: { id } });
      await recordAuditLogDirect(tx, {
        userId: auth.user.id,
        action: 'model.deleted',
        targetType: 'ModelRegistry',
        targetId: id,
        metadata: { modelId: existing.modelId, displayName: existing.displayName, wasDefault: existing.isDefault },
        ipAddress: getIpAddress(req),
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ error: MISSING_TABLE_MESSAGE }, { status: 503 });
    }
    console.error('Delete model error:', error);
    return NextResponse.json({ error: 'Failed to delete model' }, { status: 500 });
  }
}
