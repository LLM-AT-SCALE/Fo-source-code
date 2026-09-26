import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { formatValidationErrors } from "@/modules/admin/lib/validation";
import { recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";
import { CreateChipSchema, DEFAULT_CHIP_ICON, toClientChip } from "@/modules/admin/lib/dashboards/prompt-chips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/prompt-chips → {chips} — active first, then by sort order. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = await prisma.promptChip.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return NextResponse.json({ chips: rows.map(toClientChip) });
  } catch (e) {
    console.error("[api/admin/prompt-chips] GET failed", e);
    return NextResponse.json({ error: "Could not load prompt chips." }, { status: 500 });
  }
}

/** POST /api/admin/prompt-chips {label, blurb?, prompt, icon?} → the new chip. */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = CreateChipSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: formatValidationErrors(parsed.error) }, { status: 400 });
    const d = parsed.data;

    // New chips go after the current library end so admins see them in creation order.
    const last = await prisma.promptChip.aggregate({ _max: { sortOrder: true } });
    const row = await prisma.promptChip.create({
      data: {
        label: d.label,
        blurb: d.blurb ?? "",
        prompt: d.prompt,
        icon: d.icon ?? DEFAULT_CHIP_ICON,
        isDefault: false,
        isActive: true,
        sortOrder: (last._max.sortOrder ?? 0) + 10,
        createdById: auth.user.id,
      },
    });

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: "chip.created",
      targetType: "PromptChip",
      targetId: row.id,
      metadata: { label: row.label, icon: row.icon },
      ipAddress: getIpAddress(req),
    }).catch(() => {});

    return NextResponse.json(toClientChip(row), { status: 201 });
  } catch (e) {
    console.error("[api/admin/prompt-chips] POST failed", e);
    return NextResponse.json({ error: "Could not create the chip." }, { status: 500 });
  }
}
