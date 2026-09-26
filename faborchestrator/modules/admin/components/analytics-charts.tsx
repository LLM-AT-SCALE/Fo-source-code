"use client";

/**
 * Reusable, theme-aware analytics charts for the admin dashboard + usage pages.
 * Colors come exclusively from the --chart-* CSS tokens (no hardcoded hex),
 * so they follow the active platform theme in both light and dark mode.
 *
 * Every chart: locale-formatted tooltips, a visible legend, labeled/subtle
 * gridded axes, an empty state, a loading skeleton and reduced-motion support.
 */

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  LabelList,
  Line,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/shared/components/ui/chart";
import { cn } from "@/shared/lib/utils";
import { BarChart3 } from "lucide-react";

/* ── Locale-aware formatters ─────────────────────────────────────────── */

/** Compact, abbreviated number (K/M/B) — for axes and stat tiles. */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** Full, grouped integer (e.g. 1,234,567) — for tooltips and tables. */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString();
}

/** Compact currency (K-abbreviated) — for stat tiles and axes. */
export function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (Math.abs(n) >= 1_000)
    return `$${(n / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Exact, localized USD — for tooltips where precision matters. */
function fmtCurrencyExact(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 1 ? 4 : 2,
  });
}

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function shortDate(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ── Shared UI: reduced-motion, skeleton, empty state ────────────────── */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "w-full animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none",
        className
      )}
      aria-hidden="true"
    />
  );
}

function ChartEmpty({
  message = "No data yet",
  hint,
  className,
}: {
  message?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 text-center",
        className
      )}
      role="status"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <BarChart3 className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-foreground">{message}</p>
      {hint && <p className="max-w-[240px] text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Wraps a chart with an accessible text summary of its key insight. */
function ChartFrame({
  summary,
  className,
  children,
}: {
  summary: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="img" aria-label={summary} className={className}>
      {children}
    </div>
  );
}

/* ── Daily tokens (area) + cost (line), dual-axis trend ──────────────── */
export function DailyUsageChart({
  data,
  loading = false,
}: {
  data: Array<{ date: string; tokens: number; cost: number; requests: number }>;
  loading?: boolean;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="h-[280px]" />;
  if (!data?.length)
    return (
      <ChartEmpty
        className="h-[280px]"
        message="No usage data yet"
        hint="Token and cost trends appear here once requests are recorded."
      />
    );

  const totalTokens = data.reduce((s, d) => s + (d.tokens || 0), 0);
  const totalCost = data.reduce((s, d) => s + (d.cost || 0), 0);
  const config: ChartConfig = {
    tokens: { label: "Tokens", color: "var(--chart-1)" },
    cost: { label: "Cost (USD)", color: "var(--chart-3)" },
  };

  return (
    <ChartFrame
      summary={`Daily usage over ${data.length} days: ${fmtInt(totalTokens)} tokens and ${fmtCurrencyExact(totalCost)} total spend.`}
    >
      <ChartContainer config={config} className="h-[280px] w-full">
        <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
          <defs>
            <linearGradient id="fillTokens" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-tokens)" stopOpacity={0.5} />
              <stop offset="95%" stopColor="var(--color-tokens)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={shortDate}
          />
          <YAxis
            yAxisId="tokens"
            tickLine={false}
            axisLine={false}
            width={44}
            className="tabular-nums"
            tickFormatter={(v) => fmtNumber(Number(v))}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            tickLine={false}
            axisLine={false}
            width={52}
            className="tabular-nums"
            tickFormatter={(v) => fmtCurrency(Number(v))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(v) => shortDate(String(v))}
                formatter={(value, name) => {
                  const isCost = name === "cost";
                  const val = isCost ? fmtCurrencyExact(Number(value)) : fmtInt(Number(value));
                  return (
                    <span className="flex w-full justify-between gap-4">
                      <span className="text-muted-foreground">
                        {isCost ? "Cost" : "Tokens"}
                      </span>
                      <span className="font-mono font-medium tabular-nums">{val}</span>
                    </span>
                  );
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Area
            yAxisId="tokens"
            dataKey="tokens"
            type="monotone"
            fill="url(#fillTokens)"
            stroke="var(--color-tokens)"
            strokeWidth={2}
            isAnimationActive={!reduce}
          />
          <Line
            yAxisId="cost"
            dataKey="cost"
            type="monotone"
            stroke="var(--color-cost)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={!reduce}
          />
        </AreaChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/* ── Usage-by-model bar (cost) ───────────────────────────────────────── */
export function ModelCostChart({
  data,
  loading = false,
}: {
  data: Array<{ model: string; displayName?: string; cost: number; tokens: number }>;
  loading?: boolean;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="h-[280px]" />;
  if (!data?.length)
    return (
      <ChartEmpty
        className="h-[280px]"
        message="No model usage yet"
        hint="Per-model spend appears here once models are used."
      />
    );

  const rows = data.slice(0, 8).map((d) => ({
    name: d.displayName || d.model,
    cost: d.cost,
    tokens: d.tokens,
  }));
  const top = rows.reduce((a, b) => (b.cost > a.cost ? b : a), rows[0]);
  const config: ChartConfig = { cost: { label: "Cost", color: "var(--chart-1)" } };

  return (
    <ChartFrame
      summary={`Cost by model across ${rows.length} models. Highest spend: ${top.name} at ${fmtCurrencyExact(top.cost)}.`}
    >
      <ChartContainer config={config} className="h-[280px] w-full">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 56 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            className="tabular-nums"
            tickFormatter={(v) => fmtCurrency(Number(v))}
          />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={120}
            tick={{ fontSize: 12 }}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => (
                  <span className="font-mono font-medium tabular-nums">
                    {fmtCurrencyExact(Number(value))}
                  </span>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="cost" fill="var(--color-cost)" radius={[0, 4, 4, 0]} isAnimationActive={!reduce}>
            <LabelList
              dataKey="cost"
              position="right"
              className="fill-muted-foreground tabular-nums"
              fontSize={11}
              formatter={(v) => fmtCurrency(Number(v))}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/* ── Generic categorical horizontal bar ──────────────────────────────── */
export function CategoryBarChart({
  data,
  valueLabel = "Count",
  loading = false,
  emptyMessage = "No data in this window",
}: {
  data: Array<{ label: string; count: number }>;
  valueLabel?: string;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="h-[240px]" />;
  const rows = data.slice(0, 10);
  if (rows.length === 0) return <ChartEmpty className="h-[240px]" message={emptyMessage} />;

  const config: ChartConfig = { count: { label: valueLabel, color: "var(--chart-2)" } };

  return (
    <ChartFrame
      summary={`${valueLabel} across ${rows.length} categories. Top: ${rows[0].label} (${fmtInt(rows[0].count)}).`}
    >
      <ChartContainer config={config} className="h-[240px] w-full">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 32 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            className="tabular-nums"
          />
          <YAxis
            type="category"
            dataKey="label"
            tickLine={false}
            axisLine={false}
            width={150}
            tick={{ fontSize: 12 }}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">{valueLabel}</span>
                    <span className="font-mono font-medium tabular-nums">{fmtInt(Number(value))}</span>
                  </span>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} isAnimationActive={!reduce}>
            <LabelList
              dataKey="count"
              position="right"
              className="fill-muted-foreground tabular-nums"
              fontSize={11}
              formatter={(v) => fmtInt(Number(v))}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/* ── Donut for token-type breakdown (<=5 categories) ─────────────────── */
export function BreakdownDonut({
  data,
  centerLabel,
  centerValue,
  loading = false,
}: {
  data: Array<{ label: string; value: number }>;
  centerLabel?: string;
  centerValue?: string;
  loading?: boolean;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="mx-auto aspect-square h-[240px]" />;

  const rows = data.filter((d) => d.value > 0);
  if (rows.length === 0)
    return <ChartEmpty className="h-[240px]" message="No token data yet" />;

  const config: ChartConfig = Object.fromEntries(
    rows.map((r, i) => [r.label, { label: r.label, color: CHART_COLORS[i % CHART_COLORS.length] }])
  );
  const total = rows.reduce((s, r) => s + r.value, 0);
  const top = rows.reduce((a, b) => (b.value > a.value ? b : a), rows[0]);

  return (
    <ChartFrame
      summary={`Token breakdown, ${fmtInt(total)} total. Largest share: ${top.label} at ${Math.round((top.value / total) * 100)}%.`}
    >
      <ChartContainer config={config} className="mx-auto aspect-square h-[240px]">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">{name}</span>
                    <span className="font-mono font-medium tabular-nums">
                      {fmtInt(Number(value))}
                    </span>
                  </span>
                )}
              />
            }
          />
          <Pie
            data={rows}
            dataKey="value"
            nameKey="label"
            innerRadius={58}
            outerRadius={90}
            strokeWidth={2}
            isAnimationActive={!reduce}
          >
            {rows.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
            {centerValue !== undefined && (
              <Label
                content={({ viewBox }) => {
                  if (!viewBox || !("cx" in viewBox)) return null;
                  const { cx, cy } = viewBox as { cx: number; cy: number };
                  return (
                    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={cx} y={cy} className="fill-foreground text-2xl font-bold tabular-nums">
                        {centerValue}
                      </tspan>
                      {centerLabel && (
                        <tspan x={cx} y={cy + 22} className="fill-muted-foreground text-xs">
                          {centerLabel}
                        </tspan>
                      )}
                    </text>
                  );
                }}
              />
            )}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="label" className="flex-wrap gap-2" />} />
        </PieChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/* ── Prompt-success gauge ────────────────────────────────────────────── */
export function SuccessGauge({ rate, loading = false }: { rate: number | null; loading?: boolean }) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="mx-auto aspect-square h-[220px]" />;
  if (rate === null)
    return (
      <ChartEmpty
        className="h-[220px]"
        message="No prompts yet"
        hint="Success rate appears once prompts are evaluated."
      />
    );

  const value = rate;
  const config: ChartConfig = {
    success: { label: "Success", color: "var(--chart-1)" },
    rest: { label: "Other", color: "var(--muted)" },
  };
  const data = [
    { key: "success", value },
    { key: "rest", value: Math.max(0, 100 - value) },
  ];

  return (
    <ChartFrame summary={`Prompt success rate: ${value}%.`}>
      <ChartContainer config={config} className="mx-auto aspect-square h-[220px]">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="key"
            innerRadius={62}
            outerRadius={92}
            startAngle={90}
            endAngle={-270}
            strokeWidth={0}
            isAnimationActive={!reduce}
          >
            <Cell fill="var(--chart-1)" />
            <Cell fill="var(--muted)" />
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !("cx" in viewBox)) return null;
                const { cx, cy } = viewBox as { cx: number; cy: number };
                return (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={cx} y={cy} className="fill-foreground text-3xl font-bold tabular-nums">
                      {`${value}%`}
                    </tspan>
                    <tspan x={cx} y={cy + 24} className="fill-muted-foreground text-xs">
                      success rate
                    </tspan>
                  </text>
                );
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/* ── Response-time charts ─────────────────────────────────────────────
 *
 * Source: prompt_audit_logs.timings, written per request by the Fab app's
 * PhaseTimer. Durations are milliseconds on the wire and formatted for display
 * here — a chart axis reading "94600" helps nobody.
 * ─────────────────────────────────────────────────────────────────────── */

/** ms → a duration a human reads at a glance ("820ms", "12.4s", "2m 44s"). */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/**
 * Daily response time: median vs 95th percentile, with volume behind it.
 *
 * Median and p95 together because they answer different questions — the median
 * is the typical experience, p95 is the one people complain about. A median
 * that holds steady while p95 climbs is a tail problem, not a general slowdown,
 * and plotting only an average would hide exactly that.
 */
export function LatencyTrendChart({
  data,
  loading = false,
  emptyMessage = "No measured turns in this window",
}: {
  data: Array<{ day: string; turns: number; p50: number; p95: number; ttft: number }>;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="h-[260px]" />;
  if (data.length === 0) return <ChartEmpty className="h-[260px]" message={emptyMessage} />;

  const config: ChartConfig = {
    turns: { label: "Turns", color: "var(--chart-4)" },
    p50: { label: "Median", color: "var(--chart-1)" },
    p95: { label: "95th pct", color: "var(--chart-3)" },
    ttft: { label: "First token", color: "var(--chart-2)" },
  };
  const last = data[data.length - 1];

  return (
    <ChartFrame
      summary={`Response time by day. Latest: median ${fmtDuration(last.p50)}, 95th percentile ${fmtDuration(last.p95)}, first token ${fmtDuration(last.ttft)} across ${fmtInt(last.turns)} turns.`}
    >
      <ChartContainer config={config} className="h-[260px] w-full">
        <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis
            yAxisId="ms"
            tickLine={false}
            axisLine={false}
            className="tabular-nums"
            tickFormatter={(v) => fmtDuration(Number(v))}
          />
          <YAxis yAxisId="turns" orientation="right" hide />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) =>
                  name === "turns"
                    ? `${fmtInt(Number(value))} turns`
                    : fmtDuration(Number(value))
                }
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {/* Volume sits behind the lines: a spike in p95 on two turns is noise,
              on two hundred it is a real regression. */}
          <Bar
            yAxisId="turns"
            dataKey="turns"
            fill="var(--color-turns)"
            opacity={0.18}
            isAnimationActive={!reduce}
          />
          <Line
            yAxisId="ms"
            type="monotone"
            dataKey="p95"
            stroke="var(--color-p95)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={!reduce}
          />
          <Line
            yAxisId="ms"
            type="monotone"
            dataKey="p50"
            stroke="var(--color-p50)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={!reduce}
          />
          <Line
            yAxisId="ms"
            type="monotone"
            dataKey="ttft"
            stroke="var(--color-ttft)"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={!reduce}
          />
        </ComposedChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/**
 * Slowest tools by total time contributed.
 *
 * Ranked by TOTAL rather than average: a 3-second tool called 200 times costs
 * far more than a 30-second one called twice, and only the total says which to
 * fix first. The average and worst case ride along in the tooltip.
 */
export function ToolLatencyChart({
  data,
  loading = false,
  emptyMessage = "No tool calls measured in this window",
}: {
  data: Array<{ name: string; calls: number; avgMs: number; maxMs: number; totalMs: number }>;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="h-[280px]" />;
  const rows = data.slice(0, 10);
  if (rows.length === 0) return <ChartEmpty className="h-[280px]" message={emptyMessage} />;

  const config: ChartConfig = { totalMs: { label: "Total time", color: "var(--chart-3)" } };

  return (
    <ChartFrame
      summary={`Slowest tools by total time. Top: ${rows[0].name} — ${fmtDuration(rows[0].totalMs)} across ${fmtInt(rows[0].calls)} calls (avg ${fmtDuration(rows[0].avgMs)}).`}
    >
      <ChartContainer config={config} className="h-[280px] w-full">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 56 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            className="tabular-nums"
            tickFormatter={(v) => fmtDuration(Number(v))}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={190}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12 }}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, _name, item) => {
                  const r = item?.payload as (typeof rows)[number] | undefined;
                  if (!r) return fmtDuration(Number(value));
                  return `${fmtDuration(r.totalMs)} total · ${fmtInt(r.calls)} calls · avg ${fmtDuration(r.avgMs)} · worst ${fmtDuration(r.maxMs)}`;
                }}
              />
            }
          />
          <Bar dataKey="totalMs" fill="var(--color-totalMs)" radius={4} isAnimationActive={!reduce}>
            <LabelList
              dataKey="totalMs"
              position="right"
              className="fill-muted-foreground tabular-nums"
              formatter={(v) => fmtDuration(Number(v))}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

/**
 * Where an average turn's time goes.
 *
 * Deliberately only two segments that sum to the whole: time before the first
 * token, and time streaming the answer. Tool time is NOT a third segment — it
 * happens DURING streaming, so adding it would double-count and produce a bar
 * longer than the request. It is shown as a separate reference row instead.
 */
export function TimeBreakdownChart({
  data,
  loading = false,
}: {
  data: { ttftMs: number; streamMs: number; toolWaitedMs: number; blockingMs: number };
  loading?: boolean;
}) {
  const reduce = usePrefersReducedMotion();
  if (loading) return <ChartSkeleton className="h-[200px]" />;
  const total = data.ttftMs + data.streamMs;
  if (total <= 0) return <ChartEmpty className="h-[200px]" message="No measured turns in this window" />;

  const rows = [
    { label: "Whole request", ttft: data.ttftMs, stream: data.streamMs },
  ];
  const config: ChartConfig = {
    ttft: { label: "Before first token", color: "var(--chart-2)" },
    stream: { label: "Streaming the answer", color: "var(--chart-1)" },
  };
  const toolPct = total > 0 ? (data.toolWaitedMs / total) * 100 : 0;

  return (
    <ChartFrame
      summary={`Average turn: ${fmtDuration(data.ttftMs)} before the first token, then ${fmtDuration(data.streamMs)} streaming. Tools account for ${fmtDuration(data.toolWaitedMs)} of the streaming time (${toolPct.toFixed(0)}% of the request).`}
    >
      <div className="space-y-3">
        <ChartContainer config={config} className="h-[120px] w-full">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }} barSize={38}>
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              className="tabular-nums"
              tickFormatter={(v) => fmtDuration(Number(v))}
            />
            <YAxis type="category" dataKey="label" width={110} tickLine={false} axisLine={false} />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(v) => fmtDuration(Number(v))} />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="ttft" stackId="t" fill="var(--color-ttft)" isAnimationActive={!reduce} />
            <Bar dataKey="stream" stackId="t" fill="var(--color-stream)" radius={[0, 4, 4, 0]} isAnimationActive={!reduce} />
          </BarChart>
        </ChartContainer>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-border p-3">
            <dt className="text-xs text-muted-foreground">Waiting on tools</dt>
            <dd className="mt-1 font-semibold tabular-nums">
              {fmtDuration(data.toolWaitedMs)}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({toolPct.toFixed(0)}% of request)
              </span>
            </dd>
          </div>
          <div className="rounded-lg border border-border p-3">
            <dt className="text-xs text-muted-foreground">Lost to slowest parallel tool</dt>
            <dd className="mt-1 font-semibold tabular-nums">{fmtDuration(data.blockingMs)}</dd>
          </div>
        </dl>
      </div>
    </ChartFrame>
  );
}
