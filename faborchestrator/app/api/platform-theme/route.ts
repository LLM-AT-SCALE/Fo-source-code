import { NextResponse } from 'next/server';
import prisma from '@/shared/lib/db';

// Public read of the admin-controlled global platform color theme.
// No auth: the login (pre-auth) page also needs to apply the theme, and the
// response exposes only a theme name. The theme is SET from the Admin Console.
export async function GET() {
  try {
    const row = await prisma.platformSettings.findUnique({ where: { id: 'global' } });
    return NextResponse.json(
      { colorTheme: row?.colorTheme || 'fab-blue' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ colorTheme: 'fab-blue' }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
