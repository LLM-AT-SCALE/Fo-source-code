"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { KpiCard } from "@/modules/admin/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import {
  ShieldCheck,
  Database,
  Clock,
  Eraser,
  FileX,
  Loader2,
  Save,
  AlertTriangle,
} from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface AuditStats {
  totalPrompts: number;
  oldestDatetime: string | null;
  redactablePrompts: number;
  redactedPrompts: number;
}

const fmtNum = (n: number) => new Intl.NumberFormat().format(n);

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CompliancePage() {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [retentionDays, setRetentionDays] = useState<number>(90);
  const [retentionInput, setRetentionInput] = useState<string>("90");
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [redacting, setRedacting] = useState(false);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/compliance", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("load failed");
      const data = await res.json();
      const days = Number(data.retentionDays) || 90;
      setRetentionDays(days);
      setRetentionInput(String(days));
      setStats(data.stats || null);
    } catch {
      toast.error("Failed to load compliance data");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSaveRetention = async () => {
    const days = Number(retentionInput);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      toast.error("Retention must be a whole number of days between 1 and 3650");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ retentionDays: days }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "save failed");
      }
      toast.success(`Retention window set to ${days} days`);
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update retention");
    } finally {
      setSaving(false);
    }
  };

  const handleRedact = async () => {
    const ok = await confirm({
      title: `Redact prompts older than ${retentionDays} days?`,
      description:
        "This permanently removes the prompt text, LLM response, retrieved data, executed queries, and tool calls from those audit rows. Token counts, cost, user, timestamp, topic, status, and model are KEPT. This cannot be undone.",
      confirmText: "Redact content",
      destructive: true,
    });
    if (!ok) return;
    setRedacting(true);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "redact failed");
      }
      const data = await res.json();
      const count = Number(data.redacted) || 0;
      toast.success(
        count > 0
          ? `Redacted content from ${fmtNum(count)} prompt${count === 1 ? "" : "s"}`
          : "No prompts needed redaction"
      );
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to redact prompts");
    } finally {
      setRedacting(false);
    }
  };

  const retentionChanged = retentionInput.trim() !== String(retentionDays);

  return (
    <AdminPage className="admin-workspace-settings">
      <AdminPageHeader section="Monitoring"
        title="Data Retention & Compliance"
        description="Control how long prompt-audit content is kept, and redact sensitive prompt/response content while preserving audit metadata."
      />

      {/* Audit stats */}
      <div className="admin-compliance-metrics grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Total Prompts"
          value={loading ? "—" : fmtNum(stats?.totalPrompts ?? 0)}
          subtitle="Rows in the prompt-audit log"
          icon={<Database className="size-5" />}
        />
        <KpiCard
          title="Oldest Entry"
          value={loading ? "—" : fmtDate(stats?.oldestDatetime ?? null)}
          subtitle="Earliest recorded prompt"
          icon={<Clock className="size-5" />}
        />
        <KpiCard
          title="Redactable"
          value={loading ? "—" : fmtNum(stats?.redactablePrompts ?? 0)}
          subtitle={`Older than ${retentionDays} days, not yet redacted`}
          icon={<FileX className="size-5" />}
        />
        <KpiCard
          title="Already Redacted"
          value={loading ? "—" : fmtNum(stats?.redactedPrompts ?? 0)}
          subtitle="Content scrubbed, metadata kept"
          icon={<Eraser className="size-5" />}
        />
      </div>

      <div className="admin-compliance-workspace mt-6 grid gap-6 lg:grid-cols-2">
        {/* Retention window */}
        <Card className="admin-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">Retention Window</CardTitle>
            </div>
            <CardDescription>
              The number of days prompt-audit content is retained before it becomes eligible for
              redaction. Applies platform-wide.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="retention-days">Retention (days)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="retention-days"
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={retentionInput}
                  onChange={(e) => setRetentionInput(e.target.value)}
                  disabled={loading || saving}
                  className="max-w-[160px]"
                />
                <Button
                  onClick={handleSaveRetention}
                  disabled={loading || saving || !retentionChanged}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Between 1 and 3650 days. Currently set to {retentionDays} days.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Redaction */}
        <Card className="admin-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Eraser className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">Redact Old Content</CardTitle>
            </div>
            <CardDescription>
              Permanently scrub sensitive content from audit rows older than the retention window.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              <p className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                This action is irreversible.
              </p>
              <p>
                Redaction removes the <strong>prompt text</strong>, <strong>LLM response</strong>,{" "}
                <strong>retrieved data</strong>, <strong>executed queries</strong>, and{" "}
                <strong>tool calls</strong>. It <strong>keeps</strong> token counts, cost, user,
                timestamp, topic, status, and model so usage and audit reporting stay intact.
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={handleRedact}
              disabled={loading || redacting || (stats?.redactablePrompts ?? 0) === 0}
            >
              {redacting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eraser className="h-4 w-4" />
              )}
              Redact prompts older than retention
            </Button>
            {!loading && (stats?.redactablePrompts ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground">
                No prompts are currently older than the retention window.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
