"use client";

import { useEffect, useState } from "react";
import { KpiCard } from "@/modules/admin/components/kpi-card";
import { AdminCollectionHeader } from "@/modules/admin/components/admin-page-patterns";
import { Package, PlayCircle, CheckCircle2, XCircle } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

type Recent = {
  id: string;
  packageName: string;
  operation: string;
  status: string;
  result: number | null;
  user: string;
  startedAt: string;
};

type LoaderStats = {
  totalPackages: number;
  totalRuns: number;
  success: number;
  failure: number;
  inFlight: number;
  successRate: number | null;
  recent: Recent[];
  degraded?: boolean;
};

function StatusPill({ status, result }: { status: string; result: number | null }) {
  let text = status;
  let tone = "bg-primary/10 text-primary";
  if (result === 0) {
    text = "Success";
    tone = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  } else if (result === 1) {
    text = "Failure";
    tone = "bg-destructive/15 text-destructive";
  } else if (status === "FAILURE") {
    text = "Errored";
    tone = "bg-amber-500/15 text-amber-600";
  } else if (status === "EXPIRED") {
    text = "Expired";
    tone = "bg-amber-500/15 text-amber-600";
  } else {
    text = status === "QUEUED" || status === "RUNNING" ? "Running" : status;
  }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{text}</span>;
}

export function DataLoaderDashboard() {
  const [stats, setStats] = useState<LoaderStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    fetch("/api/admin/cmf-loads", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  if (!stats) return <p className="mt-6 text-sm text-muted-foreground">Couldn&apos;t load Data Loader metrics.</p>;

  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard icon={<Package className="h-5 w-5" />} title="Packages" value={stats.totalPackages} />
        <KpiCard icon={<PlayCircle className="h-5 w-5" />} title="Total loads" value={stats.totalRuns} />
        <KpiCard
          icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />}
          title="Success rate"
          value={stats.successRate == null ? "—" : `${stats.successRate}%`}
          subtitle={`${stats.success} succeeded`}
        />
        <KpiCard
          icon={<XCircle className="h-5 w-5 text-destructive" />}
          title="Failures"
          value={stats.failure}
          subtitle={stats.inFlight > 0 ? `${stats.inFlight} in flight` : undefined}
        />
      </div>

      <section className="admin-collection">
        <AdminCollectionHeader title="Recent loads" description="Load and validation runs from the Modeling Agent." count={stats.recent.length} />
        {stats.recent.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No master-data loads yet. Runs from the Modeling Agent appear here.
          </p>
        ) : (
          <div className="admin-table-surface" role="region" aria-label="Recent data loads" tabIndex={0}>
            <table className="w-full min-w-[640px] text-sm" data-slot="table">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th scope="col" data-slot="table-head" className="px-4 py-2 text-left font-medium">Package</th>
                  <th scope="col" data-slot="table-head" className="px-4 py-2 text-left font-medium">Operation</th>
                  <th scope="col" data-slot="table-head" className="px-4 py-2 text-left font-medium">Status</th>
                  <th scope="col" data-slot="table-head" className="px-4 py-2 text-left font-medium">By</th>
                  <th scope="col" data-slot="table-head" className="px-4 py-2 text-left font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td data-slot="table-cell" className="px-4 py-2.5 font-medium">{r.packageName}</td>
                    <td data-slot="table-cell" className="px-4 py-2.5 text-muted-foreground">
                      {r.operation === "LOAD" ? "Load" : "Validate"}
                    </td>
                    <td data-slot="table-cell" className="px-4 py-2.5">
                      <StatusPill status={r.status} result={r.result} />
                    </td>
                    <td data-slot="table-cell" className="px-4 py-2.5 text-muted-foreground">{r.user}</td>
                    <td data-slot="table-cell" className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {r.startedAt.slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
