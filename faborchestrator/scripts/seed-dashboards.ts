/**
 * Seed (or re-seed) standard dashboards from an exported JSON file.
 *
 * The curated dashboards are bootstrapped through the normal flow once (ask in
 * chat against the MES MCP server → pin → approve → compile → go-live), then
 * exported with `--export` so every environment can be seeded from the same
 * programs without repeating the compile.
 *
 *   npx tsx scripts/seed-dashboards.ts --export seeds/dashboards.json   # from a DB with live dashboards
 *   npx tsx scripts/seed-dashboards.ts seeds/dashboards.json            # upsert into this DB
 *
 * Seed file shape: Array<{ slug, title, program, templateHtml, kpis?, connectionScope?, visibleToAll? }>.
 * Seeded rows get kind='seeded', status='live', visible_to_all=true, no expiry, and an
 * hourly schedule due now (matching the original seven). Existing rows are updated in
 * place (new version appended, current pointer moved) so slugs stay stable for
 * report_schedules / alert_thresholds / shift_summaries.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { prisma } from '@/shared/lib/db';
import { safeParseProgram } from '@/modules/fabinsight/lib/replay';

type Seed = {
  slug: string;
  title: string;
  program: unknown;
  templateHtml: string;
  kpis?: unknown;
  connectionScope?: unknown;
  visibleToAll?: boolean;
};

async function exportSeeds(file: string): Promise<void> {
  const rows = await prisma.dashboard.findMany({
    where: { status: 'live', currentVersionId: { not: null } },
    select: { slug: true, title: true, kpis: true, connectionScope: true, visibleToAll: true, currentVersionId: true },
  });
  const out: Seed[] = [];
  for (const r of rows) {
    const v = await prisma.dashboardVersion.findUnique({ where: { id: r.currentVersionId! }, select: { program: true, templateHtml: true } });
    if (!v) continue;
    out.push({ slug: r.slug, title: r.title, program: v.program, templateHtml: v.templateHtml, kpis: r.kpis, connectionScope: r.connectionScope, visibleToAll: r.visibleToAll });
  }
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`exported ${out.length} dashboard(s) to ${file}`);
}

async function importSeeds(file: string): Promise<void> {
  const seeds = JSON.parse(readFileSync(file, 'utf8')) as Seed[];
  const admin = await prisma.user.findFirst({ where: { isAdmin: true, status: 'ACTIVE' }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('no active admin user to own seeded dashboards');

  for (const seed of seeds) {
    const parsed = safeParseProgram(seed.program);
    if (!parsed.ok) {
      console.error(`skip ${seed.slug}: invalid program — ${parsed.errors.join('; ')}`);
      continue;
    }
    const scope = seed.connectionScope ?? parsed.program.scope;
    const kpis = seed.kpis ?? parsed.program.kpis.map((k) => ({ label: k.label, unit: k.unit ?? null }));

    const existing = await prisma.dashboard.findUnique({ where: { slug: seed.slug }, select: { id: true } });
    const dashboardId = existing?.id ?? randomUUID();
    if (!existing) {
      await prisma.dashboard.create({
        data: {
          id: dashboardId,
          slug: seed.slug,
          title: seed.title,
          kind: 'seeded',
          status: 'live',
          kpis: kpis as object,
          visibleToAll: seed.visibleToAll ?? true,
          connectionScope: scope as object,
          createdById: admin.id,
        },
      });
    }
    const last = await prisma.dashboardVersion.findFirst({ where: { dashboardId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    const version = await prisma.dashboardVersion.create({
      data: {
        dashboardId,
        versionNo: (last?.versionNo ?? 0) + 1,
        program: parsed.program as object,
        templateHtml: seed.templateHtml,
        kpis: kpis as object,
        connectionScope: scope as object,
        approvedById: admin.id,
      },
      select: { id: true, versionNo: true },
    });
    await prisma.dashboard.update({
      where: { id: dashboardId },
      data: { title: seed.title, kind: 'seeded', status: 'live', kpis: kpis as object, connectionScope: scope as object, currentVersionId: version.id },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO report_schedules (id, dashboard_id, source_key, frequency, interval_minutes, enabled, next_run_at)
       VALUES (gen_random_uuid()::text, $1, 'lumentum', 'hourly', 60, true, now())
       ON CONFLICT (dashboard_id, source_key) DO UPDATE SET enabled = true, next_run_at = now()`,
      seed.slug,
    );
    console.log(`seeded ${seed.slug} (v${version.versionNo})`);
  }
}

async function main() {
  const [a, b] = process.argv.slice(2);
  if (a === '--export') {
    if (!b) throw new Error('usage: --export <file>');
    await exportSeeds(b);
  } else if (a) {
    await importSeeds(a);
  } else {
    throw new Error('usage: seed-dashboards.ts <seed.json> | --export <file>');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
