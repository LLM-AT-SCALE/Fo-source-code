import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { recordAuditLog } from '@/modules/admin/lib/services/audit-service';

// Platform color themes shared by both apps. Must stay in sync with the
// :root[data-theme="..."] blocks in globals.css and FabOrch's allowed set.
export const ALLOWED_THEMES = [
  'fab-blue',
  'claude',
  'vercel',
  'solar-dusk',
  'twitter',
  'violet-bloom',
] as const;

const SINGLETON_ID = 'global';
const DEFAULT_THEME = 'fab-blue';

// GET is public (no auth): both apps + their pre-auth login pages read the
// active platform theme. It exposes only a theme name — nothing sensitive.
export async function GET() {
  try {
    const row = await prisma.platformSettings.findUnique({ where: { id: SINGLETON_ID } });
    return NextResponse.json({ colorTheme: row?.colorTheme || DEFAULT_THEME });
  } catch {
    return NextResponse.json({ colorTheme: DEFAULT_THEME });
  }
}

// PATCH is admin-only — sets the global platform theme + audit logs it.
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const colorTheme = String(body?.colorTheme || '');
    if (!(ALLOWED_THEMES as readonly string[]).includes(colorTheme)) {
      return NextResponse.json({ error: 'Invalid theme' }, { status: 400 });
    }

    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.platformSettings.upsert({
        where: { id: SINGLETON_ID },
        update: { colorTheme, updatedById: auth.user.id },
        create: { id: SINGLETON_ID, colorTheme, updatedById: auth.user.id },
      });
      await recordAuditLog(tx, {
        userId: auth.user.id,
        action: 'platform.theme_changed',
        targetType: 'PlatformSettings',
        targetId: SINGLETON_ID,
        metadata: { colorTheme },
        ipAddress: getIpAddress(req),
      });
      return r;
    });

    return NextResponse.json({ colorTheme: row.colorTheme });
  } catch (e) {
    console.error('[admin/settings/theme] PATCH error', e);
    return NextResponse.json({ error: 'Failed to update theme' }, { status: 500 });
  }
}
