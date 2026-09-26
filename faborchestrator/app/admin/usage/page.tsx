"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { AnalyticsFilterBar, useAnalyticsParams } from "@/modules/admin/components/date-range-control";
import { describeRange } from "@/modules/admin/lib/date-range";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { KpiCard } from "@/modules/admin/components/kpi-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Button } from "@/shared/components/ui/button";
import {
  DailyUsageChart,
  ModelCostChart,
  BreakdownDonut,
  fmtNumber,
  fmtCurrency,
} from "@/modules/admin/components/analytics-charts";
import { Zap, MessageSquare, Cpu, DollarSign, Timer, Download, Gauge, Database, PiggyBank } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface ModelRow {
  model: string;
  displayName: string;
  requests: number;
  tokens: number;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheCreation: number;
  cost: number;
}

interface UserRow {
  userId: string;
  name: string | null;
  email: string;
  requests: number;
  tokens: number;
  cost: number;
}

interface UsageData {
  days: number;
  filters?: { users: Array<{ id: string; label: string }>; models: string[]; user: string | null; model: string | null };
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  avgRequestDurationMs: number;
  tokenBreakdown: {
    input: number;
    output: number;
    thinking: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  cache?: {
    readTokens: number;
    writeTokens: number;
    uncachedInputTokens: number;
    hitRate: number | null;
    savingsUsd: number;
    source: string;
  };
  byModel: ModelRow[];
  topUsersByCost: UserRow[];
  topUsersByTokens: UserRow[];
  timeSeries: Array<{ date: string; tokens: number; cost: number; requests: number }>;
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms).toLocaleString()}ms`;
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}s`;
}

const EXPORT_OPTIONS = [
  { value: "user", label: "Export: by user" },
  { value: "model", label: "Export: by model" },
  { value: "day", label: "Export: by day" },
  { value: "prompt", label: "Export: by prompt" },
];

const ALL = "__all__";

export default function UsagePage() {
  return (
    <Suspense fallback={<AdminPage className="admin-workspace-analytics"><div className="h-8 w-48 animate-pulse rounded-md bg-muted" aria-hidden="true" /></AdminPage>}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState("user");
  const [exporting, setExporting] = useState(false);
  // Range + user/model filters live in the URL so a reload keeps them.
  const { range, get, set, setRange, query } = useAnalyticsParams();
  const user = get("user");
  const model = get("model");
  const qs = query({ user, model });
  const rangeText = describeRange(range);

  const load = useCallback(async () => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/usage?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      // Only accept a well-formed analytics payload; an error envelope
      // (e.g. before the model_registry migration) leaves data null.
      setData(res.ok && json && json.tokenBreakdown ? json : null);
    } catch {
      console.error("Failed to load usage data");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExport = useCallback(async () => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const from = range.from;
    const to = range.to;
    // Same range + user/model filters as the page, plus the grouping.
    const params = new URLSearchParams(qs);
    params.set("groupBy", groupBy);
    setExporting(true);
    try {
      const res = await fetch(`/api/admin/usage/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `usage-${groupBy}-${from.toISOString().slice(0, 10)}-${to
        .toISOString()
        .slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      console.error("Failed to export usage data");
    } finally {
      setExporting(false);
    }
  }, [qs, range, groupBy]);

  const breakdown = data
    ? [
        { label: "Input", value: data.tokenBreakdown.input },
        { label: "Output", value: data.tokenBreakdown.output },
        { label: "Thinking", value: data.tokenBreakdown.thinking },
        { label: "Cache read", value: data.tokenBreakdown.cacheRead },
        { label: "Cache write", value: data.tokenBreakdown.cacheCreation },
      ]
    : [];

  return (
    <AdminPage className="admin-workspace-analytics">
      <AdminPageHeader section="Monitoring" title="Usage & Cost" description="Token consumption, spend and per-user analytics" >

      </AdminPageHeader>

      <AnalyticsFilterBar
        range={range}
        onRangeChange={setRange}
        label="Usage filters and export"
        trailing={<div className="flex items-center gap-2">
          <Select value={groupBy} onValueChange={setGroupBy}>
            <SelectTrigger className="w-[150px]" aria-label="Export grouping (CSV rows)">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>}
      >
          <Select value={user || ALL} onValueChange={(v) => set({ user: v === ALL ? null : v })}>
            <SelectTrigger className="w-[170px]" aria-label="Filter by user">
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All users</SelectItem>
              {(data?.filters?.users ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.label}</SelectItem>
              ))}
              {user && !(data?.filters?.users ?? []).some((u) => u.id === user) && <SelectItem value={user}>{user}</SelectItem>}
            </SelectContent>
          </Select>
          <Select value={model || ALL} onValueChange={(v) => set({ model: v === ALL ? null : v })}>
            <SelectTrigger className="w-[190px]" aria-label="Filter by model">
              <SelectValue placeholder="All models" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All models</SelectItem>
              {(data?.filters?.models ?? []).map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
              {model && !(data?.filters?.models ?? []).includes(model) && <SelectItem value={model}>{model}</SelectItem>}
            </SelectContent>
          </Select>
      </AnalyticsFilterBar>

      {loading ? (
        <div className="space-y-6">
          <div className="admin-usage-metrics">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg border bg-muted motion-reduce:animate-none" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-lg border bg-muted motion-reduce:animate-none" />
        </div>
      ) : data ? (
        <div className="space-y-6">
          {/* ── KPIs ── */}
          <div className="admin-usage-metrics">
            <KpiCard title="Total Cost" value={fmtCurrency(data.totalCost)} subtitle={rangeText.toLowerCase()} icon={<DollarSign className="h-5 w-5" />} />
            <KpiCard title="Total Requests" value={fmtNumber(data.totalRequests)} subtitle={`${fmtNumber(data.totalTokens)} tokens`} icon={<MessageSquare className="h-5 w-5" />} />
            <KpiCard title="Total Tokens" value={fmtNumber(data.totalTokens)} subtitle="input + output + cache" icon={<Zap className="h-5 w-5" />} />
            <KpiCard title="Models Used" value={data.byModel?.length || 0} subtitle="with recorded usage" icon={<Cpu className="h-5 w-5" />} />
            <KpiCard
              title="Avg Duration"
              value={fmtDurationMs(data.avgRequestDurationMs)}
              subtitle="per request"
              icon={<Timer className="h-5 w-5" />}
            />
          </div>

          {/* ── Prompt cache KPIs ── */}
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Prompt Cache
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                title="Cache Hit Rate"
                value={data.cache?.hitRate != null ? `${data.cache.hitRate}%` : "—"}
                subtitle="of prompt input served from cache"
                icon={<Gauge className="h-5 w-5" />}
              />
              <KpiCard
                title="Est. Savings"
                value={fmtCurrency(data.cache?.savingsUsd ?? 0)}
                subtitle={rangeText.toLowerCase()}
                icon={<PiggyBank className="h-5 w-5" />}
              />
              <KpiCard
                title="Cache Reads"
                value={fmtNumber(data.cache?.readTokens ?? 0)}
                subtitle="tokens served at ~0.1× price"
                icon={<Database className="h-5 w-5" />}
              />
              <KpiCard
                title="Cache Writes"
                value={fmtNumber(data.cache?.writeTokens ?? 0)}
                subtitle="tokens written at ~1.25× price"
                icon={<Database className="h-5 w-5" />}
              />
            </div>
          </div>

          {/* ── Trend + token breakdown ── */}
          <div className="admin-analytics-primary">
            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Daily Tokens & Cost</CardTitle>
                <CardDescription>Consumption, {rangeText.toLowerCase()}{user ? ", one user" : ""}{model ? `, ${model}` : ""}</CardDescription>
              </CardHeader>
              <CardContent>
                <DailyUsageChart data={data.timeSeries ?? []} />
              </CardContent>
            </Card>

            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Token Breakdown</CardTitle>
                <CardDescription>By token type</CardDescription>
              </CardHeader>
              <CardContent>
                <BreakdownDonut
                  data={breakdown}
                  centerLabel="tokens"
                  centerValue={fmtNumber(data.tokenBreakdown.total)}
                />
              </CardContent>
            </Card>
          </div>

          {/* ── Cost by model chart ── */}
          <Card className="admin-card">
            <CardHeader>
              <CardTitle className="admin-card-title text-lg">Cost by Model</CardTitle>
              <CardDescription>Estimated USD spend per model</CardDescription>
            </CardHeader>
            <CardContent>
              <ModelCostChart data={data.byModel ?? []} />
            </CardContent>
          </Card>

          {/* ── Per-model table ── */}
          <Card className="admin-card">
            <CardHeader>
              <CardTitle className="admin-card-title text-lg">Usage by Model</CardTitle>
              <CardDescription>Requests, tokens and cost per model</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[480px] overflow-auto rounded-lg border" role="region" aria-label="Usage by model" tabIndex={0}>
                <Table className="min-w-[720px]">
                  <TableCaption className="sr-only">Token usage and cost broken down by model.</TableCaption>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Model</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Requests</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Input</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Output</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cache</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tokens</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byModel.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No usage data yet.</TableCell></TableRow>
                    ) : (
                      data.byModel.map((m) => (
                        <TableRow key={m.model} className="hover:bg-muted/30">
                          <TableCell className="px-4 py-3 font-medium">{m.displayName}</TableCell>
                          <TableCell className="px-4 py-3 text-right tabular-nums">{fmtNumber(m.requests)}</TableCell>
                          <TableCell className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtNumber(m.input)}</TableCell>
                          <TableCell className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtNumber(m.output + m.thinking)}</TableCell>
                          <TableCell className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtNumber(m.cacheRead + m.cacheCreation)}</TableCell>
                          <TableCell className="px-4 py-3 text-right tabular-nums">{fmtNumber(m.tokens)}</TableCell>
                          <TableCell className="px-4 py-3 text-right font-medium tabular-nums">{fmtCurrency(m.cost)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* ── Top users ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Top Users by Cost</CardTitle>
                <CardDescription>Highest spend, {rangeText.toLowerCase()}</CardDescription>
              </CardHeader>
              <CardContent>
                <TopUsersTable rows={data.topUsersByCost} metric="cost" />
              </CardContent>
            </Card>
            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Top Users by Tokens</CardTitle>
                <CardDescription>Highest consumption, {rangeText.toLowerCase()}</CardDescription>
              </CardHeader>
              <CardContent>
                <TopUsersTable rows={data.topUsersByTokens} metric="tokens" />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <Card className="admin-card mt-8">
          <CardContent className="flex flex-col items-center gap-1.5 py-16 text-center">
            <p className="text-sm font-medium text-foreground">Couldn&apos;t load usage data</p>
            <p className="text-sm text-muted-foreground">
              Try a different range or filter, or refresh the page.
            </p>
          </CardContent>
        </Card>
      )}
    </AdminPage>
  );
}

function TopUsersTable({ rows, metric }: { rows: UserRow[]; metric: "cost" | "tokens" }) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border" role="region" aria-label="Top users" tabIndex={0}>
      <Table className="min-w-[420px]">
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">User</TableHead>
            <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Requests</TableHead>
            <TableHead className="sticky top-0 z-10 bg-muted px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {metric === "cost" ? "Cost" : "Tokens"}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">No usage data yet.</TableCell></TableRow>
          ) : (
            rows.map((u) => (
              <TableRow key={u.userId} className="hover:bg-muted/30">
                <TableCell className="px-4 py-3">
                  <div className="font-medium">{u.name || u.email}</div>
                  {u.name && <div className="text-xs text-muted-foreground">{u.email}</div>}
                </TableCell>
                <TableCell className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtNumber(u.requests)}</TableCell>
                <TableCell className="px-4 py-3 text-right font-medium tabular-nums">
                  {metric === "cost" ? fmtCurrency(u.cost) : fmtNumber(u.tokens)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
