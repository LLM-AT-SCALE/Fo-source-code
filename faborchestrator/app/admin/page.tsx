"use client";

import { Suspense, useEffect, useState } from "react";
import { AdminPage, AdminMetricGroup } from "@/modules/admin/components/admin-page-patterns";
import { AnalyticsFilterBar, useAnalyticsParams } from "@/modules/admin/components/date-range-control";
import { describeRange } from "@/modules/admin/lib/date-range";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { DataLoaderDashboard } from "@/modules/admin/components/data-loader-dashboard";
import { KpiCard } from "@/modules/admin/components/kpi-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Badge } from "@/shared/components/ui/badge";
import {
  DailyUsageChart,
  ModelCostChart,
  CategoryBarChart,
  SuccessGauge,
  fmtNumber,
  fmtCurrency,
} from "@/modules/admin/components/analytics-charts";
import {
  Users,
  MessageSquare,
  Zap,
  DollarSign,
  Activity,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface DashboardData {
  totalUsers: number;
  activeUsers: number;
  totalConversations: number;
  totalRoles: number;
  totalRequests30d: number;
  totalTokens30d: number;
  users: { total: number; active: number; suspended: number; admins: number };
  conversations: { total: number; last7d: number; last30d: number };
  messages: { total: number };
  mcp: { total: number; connected: number };
  sessions: { active: number; closedIdle7d: number; avgDurationSec: number };
  usage: {
    last7d: { requests: number; tokens: { total: number } };
    last30d: { requests: number; tokens: { total: number } };
    selected?: { requests: number; tokens: { total: number } };
  };
  cost: { last7d: number; last30d: number; selected?: number; source: string };
  errors: {
    open: number;
    total30d: number;
    totalSelected?: number;
    byPriority: Array<{ priority: string; count: number }>;
    byType: Array<{ type: string; count: number }>;
  };
  prompts: {
    total: number;
    successRate: number | null;
    avgResponseMs: number;
    byTopic: Array<{ topic: string; count: number }>;
  };
}

interface UsageData {
  totalCost: number;
  byModel: Array<{ model: string; displayName: string; cost: number; tokens: number }>;
  timeSeries: Array<{ date: string; tokens: number; cost: number; requests: number }>;
}

function fmtDuration(sec: number): string {
  if (!sec) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function AdminDashboard() {
  return (
    <Suspense fallback={<AdminPage className="admin-workspace-overview"><div className="h-8 w-48 animate-pulse rounded-md bg-muted" aria-hidden="true" /></AdminPage>}>
      <AdminDashboardContent />
    </Suspense>
  );
}

function AdminDashboardContent() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"fab" | "loader">("fab");
  // Selected range lives in the URL (?range | ?from&to); default last 30 days.
  const { range, setRange, query } = useAnalyticsParams();
  const qs = query();
  const rangeText = describeRange(range);
  const rangeLower = rangeText.toLowerCase();

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const headers = { Authorization: `Bearer ${token}` };
    setLoading(true);
    Promise.all([
      fetch(`/api/admin/dashboard?${qs}`, { headers }).then(async (r) => ({ ok: r.ok, body: await r.json() })),
      fetch(`/api/admin/usage?${qs}`, { headers }).then(async (r) => ({ ok: r.ok, body: await r.json() })),
    ])
      .then(([d, u]) => {
        // Ignore error envelopes so a partial/failed response never breaks the UI.
        setData(d.ok && d.body?.users ? d.body : null);
        setUsage(u.ok && u.body?.tokenBreakdown ? u.body : null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [qs]);

  const selRequests = data?.usage?.selected?.requests ?? data?.usage?.last30d?.requests ?? data?.totalRequests30d ?? 0;
  const selTokens = data?.usage?.selected?.tokens?.total ?? data?.usage?.last30d?.tokens?.total ?? data?.totalTokens30d ?? 0;
  const selCost = data?.cost?.selected ?? data?.cost?.last30d ?? 0;
  const selErrors = data?.errors?.totalSelected ?? data?.errors?.total30d ?? 0;

  const priorityVariant = (p: string): "destructive" | "warning" | "secondary" => {
    if (p === "HIGH") return "destructive";
    if (p === "MEDIUM") return "warning";
    return "secondary";
  };

  return (
    <AdminPage className="admin-workspace-overview">
      <AdminPageHeader section="Overview"
        title="Dashboard"
        description={`Platform activity, spend, and reliability, ${rangeLower}.`}
      >
      {/* App switch: Fab AI (default) vs the CMF Data Loader (Modeling Agent). */}
      <div aria-label="Dashboard view" role="group" className="admin-view-switch">
        <button
          onClick={() => setView("fab")}
          aria-pressed={view === "fab"}
          className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
            view === "fab" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Fab AI
        </button>
        <button
          onClick={() => setView("loader")}
          aria-pressed={view === "loader"}
          className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
            view === "loader" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Data Loader
        </button>
      </div>
      </AdminPageHeader>

      <AnalyticsFilterBar range={range} onRangeChange={setRange} label="Dashboard period" />



      {view === "loader" ? (
        <DataLoaderDashboard />
      ) : loading ? (
        <div className="mt-8 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg border bg-muted motion-reduce:animate-none" />
            ))}
          </div>
          <div className="admin-analytics-primary">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-80 animate-pulse rounded-lg border bg-muted motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      ) : data ? (
        <div className="mt-8 space-y-6">
          {/* ── Stat tiles ── */}
          <div className="admin-overview-metrics">
            <AdminMetricGroup title="Core metrics">
            <KpiCard
              title="Users"
              value={fmtNumber(data.users?.total ?? data.totalUsers)}
              subtitle={`${data.users?.active ?? data.activeUsers} active · ${data.users?.suspended ?? 0} suspended`}
              icon={<Users className="h-5 w-5" />}
            />
            <KpiCard
              title="Active Sessions"
              value={fmtNumber(data.sessions?.active ?? 0)}
              subtitle={`avg ${fmtDuration(data.sessions?.avgDurationSec ?? 0)} · ${data.sessions?.closedIdle7d ?? 0} idle-out (7d)`}
              icon={<Activity className="h-5 w-5" />}
            />
            <KpiCard
              title="Requests"
              value={fmtNumber(selRequests)}
              subtitle={`${rangeText} · ${fmtNumber(data.usage?.last7d?.requests ?? 0)} in last 7 days`}
              icon={<MessageSquare className="h-5 w-5" />}
            />
            <KpiCard
              title="Total Cost"
              value={fmtCurrency(selCost)}
              subtitle={`${rangeText} · ${fmtCurrency(data.cost?.last7d ?? 0)} last 7d · via ${data.cost?.source ?? "usage"}`}
              icon={<DollarSign className="h-5 w-5" />}
            />
            <KpiCard
              title="Tokens"
              value={fmtNumber(selTokens)}
              subtitle={`${rangeText} · input + output + cache`}
              icon={<Zap className="h-5 w-5" />}
            />
            <KpiCard
              title="Conversations"
              value={fmtNumber(data.conversations?.total ?? data.totalConversations)}
              subtitle={`${data.conversations?.last7d ?? 0} new this week`}
              icon={<MessageSquare className="h-5 w-5" />}
            />
            </AdminMetricGroup>
            <AdminMetricGroup title="Reliability & health" className="admin-health-metrics">
            <KpiCard
              title="Open Errors"
              value={fmtNumber(data.errors?.open ?? 0)}
              subtitle={`${selErrors} logged ${rangeLower}`}
              icon={<AlertTriangle className="h-5 w-5" />}
            />
            <KpiCard
              title="Prompt Success"
              value={data.prompts?.successRate === null || data.prompts?.successRate === undefined ? "—" : `${data.prompts.successRate}%`}
              subtitle={`${fmtNumber(data.prompts?.total ?? 0)} prompts · ${Math.round((data.prompts?.avgResponseMs ?? 0))}ms avg`}
              icon={<CheckCircle2 className="h-5 w-5" />}
            />
            </AdminMetricGroup>
          </div>

          {/* ── Trend + model cost ── */}
          <div className="admin-analytics-primary">
            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Daily Token Usage</CardTitle>
                <CardDescription>Total tokens consumed per day ({rangeLower})</CardDescription>
              </CardHeader>
              <CardContent>
                <DailyUsageChart data={usage?.timeSeries ?? []} />
              </CardContent>
            </Card>

            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Cost by Model</CardTitle>
                <CardDescription>Estimated USD spend per model ({rangeLower})</CardDescription>
              </CardHeader>
              <CardContent>
                <ModelCostChart data={usage?.byModel ?? []} />
              </CardContent>
            </Card>
          </div>

          {/* ── Reliability + prompts ── */}
          <div className="admin-analytics-secondary">
            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Errors by Type</CardTitle>
                <CardDescription>{rangeText}</CardDescription>
              </CardHeader>
              <CardContent>
                <CategoryBarChart
                  data={(data.errors?.byType ?? []).map((e) => ({ label: e.type, count: e.count }))}
                  valueLabel="Errors"
                  emptyMessage="No errors logged"
                />
                {(data.errors?.byPriority?.length ?? 0) > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {data.errors.byPriority.map((p) => (
                      <Badge key={p.priority} variant={priorityVariant(p.priority)}>
                        {p.priority}: {p.count}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Prompts by Topic</CardTitle>
                <CardDescription>Distribution across use cases ({rangeLower})</CardDescription>
              </CardHeader>
              <CardContent>
                <CategoryBarChart
                  data={(data.prompts?.byTopic ?? []).map((t) => ({ label: t.topic, count: t.count }))}
                  valueLabel="Prompts"
                  emptyMessage="No prompts yet"
                />
              </CardContent>
            </Card>

            <Card className="admin-card">
              <CardHeader>
                <CardTitle className="admin-card-title text-lg">Prompt Success</CardTitle>
                <CardDescription>Share of successful prompts ({rangeLower})</CardDescription>
              </CardHeader>
              <CardContent>
                <SuccessGauge rate={data.prompts?.successRate ?? null} />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <Card className="admin-card mt-8">
          <CardContent className="flex flex-col items-center gap-1.5 py-16 text-center">
            <p className="text-sm font-medium text-foreground">Couldn&apos;t load dashboard data</p>
            <p className="text-sm text-muted-foreground">Check your connection and refresh the page.</p>
          </CardContent>
        </Card>
      )}
    </AdminPage>
  );
}
