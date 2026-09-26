import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { formatValidationErrors } from "@/modules/admin/lib/validation";
import { recordAuditLog, recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";
import { chipIdList, toClientChip, UpdateChipSchema } from "@/modules/admin/lib/dashboards/prompt-chips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/admin/prompt-chips/[id] {label?, blurb?, prompt?, icon?, isActive?, isDefault?, sortOrder?} → the chip. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = UpdateChipSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: formatValidationErrors(parsed.error) }, { status: 400 });
    const d = parsed.data;

    const existing = await prisma.promptChip.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Chip not found." }, { status: 404 });

    const row = await prisma.promptChip.update({
      where: { id },
      data: {
        ...(d.label !== undefined ? { label: d.label } : {}),
        ...(d.blurb !== undefined ? { blurb: d.blurb } : {}),
        ...(d.prompt !== undefined ? { prompt: d.prompt } : {}),
        ...(d.icon !== undefined ? { icon: d.icon } : {}),
        ...(d.isActive !== undefined ? { is_active: d.isActive } : {}),
        ...(d.isDefault !== undefined ? { is_default: d.isDefault } : {}),
        ...(d.sortOrder !== undefined ? { sort_order: d.sortOrder } : {}),
        updatedAt: new Date(),
      },
    });

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: "chip.updated",
      targetType: "PromptChip",
      targetId: id,
      metadata: { label: row.label, updatedFields: Object.keys(d).filter((k) => d[k as keyof typeof d] !== undefined) },
      ipAddress: getIpAddress(req),
    }).catch(() => {});

    return NextResponse.json(toClientChip(row));
  } catch (e) {
    console.error("[api/admin/prompt-chips/[id]] PATCH failed", e);
    return NextResponse.json({ error: "Could not update the chip." }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/prompt-chips/[id] — soft delete (is_active = false) and
 * remove the id from every role's prompt_chip_ids, in one transaction.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const existing = await prisma.promptChip.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Chip not found." }, { status: 404 });

    const rolesTouched = await prisma.$transaction(async (tx) => {
      await tx.promptChip.update({ where: { id }, data: { isActive: false, isDefault: false, updatedAt: new Date() } });
      const roles = await tx.role.findMany({ select: { id: true, promptChipIds: true } });
      const touched: string[] = [];
      for (const r of roles) {
        const ids = chipIdList(r.promptChipIds);
        if (!ids.includes(id)) continue;
        await tx.role.update({ where: { id: r.id }, data: { promptChipIds: ids.filter((x) => x !== id) } });
        touched.push(r.id);
      }
      await recordAuditLog(tx, {
        userId: auth.user.id,
        action: "chip.deleted",
        targetType: "PromptChip",
        targetId: id,
        metadata: { label: existing.label, removedFromRoles: touched },
        ipAddress: getIpAddress(req),
      });
      return touched;
    });

    return NextResponse.json({ ok: true, removedFromRoles: rolesTouched.length });
  } catch (e) {
    console.error("[api/admin/prompt-chips/[id]] DELETE failed", e);
    return NextResponse.json({ error: "Could not delete the chip." }, { status: 500 });
  }
}
