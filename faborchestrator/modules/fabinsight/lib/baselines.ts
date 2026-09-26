/**
 * Metric baseline sampler.
 *
 * Records each live dashboard's numeric columns into `metric_samples` on a slow
 * cadence, so the admin "Alert Thresholds" form can show a DYNAMIC normal range
 * (7-day min / avg / max + current) when picking a metric. Values come from the
 * dashboard's last replay snapshot (`dashboards.cached_sets`) — no source is
 * queried here. The discovered columns are persisted onto `dashboards.metric_columns`
 * so the admin can pick them. Globally throttled; prunes old rows.
 */
import { prisma } from "@/shared/lib/db";
import { recordCaptured } from "@/shared/lib/errors/capture";
import { FabOrchErrorType } from "@/shared/lib/errors/error-catalog-defaults";

import { parseCachedSets, samplesFromSets, type Sample } from "@/modules/fabinsight/lib/snapshot-metrics";

export { customMetricKey } from "@/modules/fabinsight/lib/snapshot-metrics";

const INTERVAL_MIN = Number(process.env.FABINSIGHT_BASELINE_INTERVAL_MIN ?? "15");
const RETAIN_DAYS = Number(process.env.FABINSIGHT_BASELINE_RETAIN_DAYS ?? "30");
const SOURCE = "lumentum";

async function insertSamples(samples: Sample[]): Promise<void> {
  if (!samples.length) return;
  const values = samples.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, '${SOURCE}', now())`).join(", ");
  const params = samples.flatMap((s) => [s.key, s.value]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO metric_samples (metric_key, value, source_key, sampled_at) VALUES ${values}`,
    ...params,
  );
}

/** Sample every live dashboard's numeric columns from its cached snapshot. */
async function sampleDashboards(): Promise<Sample[]> {
  const dashboards = await prisma.dashboard.findMany({
    where: { status: "live" },
    select: { id: true, slug: true, cachedSets: true },
  });

  const out: Sample[] = [];
  for (const d of dashboards) {
    try {
      const sets = parseCachedSets(d.cachedSets);
      if (!sets.length) continue;
      const { columns, samples } = samplesFromSets(sets, d.slug);
      out.push(...samples);
      await prisma.dashboard
        .update({ where: { id: d.id }, data: { metricColumns: columns } })
        .catch(() => {});
    } catch (e) {
      console.error(`[baselines] dashboard ${d.slug} sampling failed`, e);
      recordCaptured({ system: "Metric baselines", operation: "sampleDashboard", target: `dashboard ${d.slug}`, type: FabOrchErrorType.LAMBDA_MCP_CRASH }, e);
    }
  }
  return out;
}

/** Sample all metrics once (throttled). Safe to call each scheduler tick. */
export async function sampleMetricBaselines(): Promise<void> {
  try {
    const recent = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM metric_samples WHERE sampled_at > now() - ($1 || ' minutes')::interval LIMIT 1`,
      String(INTERVAL_MIN),
    )) as unknown[];
    if (recent.length) return;

    const samples = await sampleDashboards();
    await insertSamples(samples);

    await prisma
      .$executeRawUnsafe(`DELETE FROM metric_samples WHERE sampled_at < now() - ($1 || ' days')::interval`, String(RETAIN_DAYS))
      .catch(() => {});

    if (samples.length) console.log(`[baselines] recorded ${samples.length} metric samples`);
  } catch (e) {
    console.error("[baselines] sampling failed", e);
    recordCaptured({ system: "Metric baselines", operation: "sampleMetricBaselines", type: FabOrchErrorType.LAMBDA_MCP_CRASH }, e);
  }
}
