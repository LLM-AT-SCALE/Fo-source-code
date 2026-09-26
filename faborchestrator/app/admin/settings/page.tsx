"use client";

import { useEffect, useState } from "react";
import { AdminPage } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { toast } from "sonner";
import { Settings, Database, Shield, Key, Palette, Check } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

const PLATFORM_THEMES: { id: string; label: string; description: string; accent: string }[] = [
  { id: "fab-blue", label: "Fab Blue", description: "Deep navy + sky blue", accent: "#2563eb" },
  { id: "claude", label: "Claude", description: "Warm earthy tones", accent: "#D97757" },
  { id: "vercel", label: "Vercel", description: "Clean monochrome", accent: "#000000" },
  { id: "solar-dusk", label: "Solar Dusk", description: "Amber & sunset", accent: "#C0630A" },
  { id: "twitter", label: "Twitter", description: "Blue accent", accent: "#1D9BF0" },
  { id: "violet-bloom", label: "Violet Bloom", description: "Rich violet", accent: "#7C3AED" },
];

export default function SettingsPage() {
  const [stats, setStats] = useState<{
    totalUsers: number;
    totalRoles: number;
    totalConversations: number;
    dbConnected: boolean;
  } | null>(null);
  const [theme, setTheme] = useState<string>("fab-blue");
  const [savingTheme, setSavingTheme] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    fetch("/api/admin/dashboard", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        setStats({
          totalUsers: data.totalUsers || 0,
          totalRoles: data.totalRoles || 0,
          totalConversations: data.totalConversations || 0,
          dbConnected: true,
        });
      })
      .catch(() => {
        setStats({ totalUsers: 0, totalRoles: 0, totalConversations: 0, dbConnected: false });
      });

    fetch("/api/admin/settings/theme", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setTheme(d?.colorTheme || "fab-blue"))
      .catch(() => {});
  }, []);

  const handleThemeChange = async (next: string) => {
    if (next === theme || savingTheme) return;
    const prev = theme;
    setTheme(next);
    setSavingTheme(true);
    // Apply immediately to the admin console.
    document.documentElement.setAttribute("data-theme", next);
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const res = await fetch("/api/admin/settings/theme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ colorTheme: next }),
      });
      if (!res.ok) throw new Error("save failed");
      toast.success(`Platform theme set to ${PLATFORM_THEMES.find((t) => t.id === next)?.label || next}. Both apps update on next load.`);
    } catch {
      // Revert on failure
      setTheme(prev);
      document.documentElement.setAttribute("data-theme", prev);
      toast.error("Failed to update platform theme");
    } finally {
      setSavingTheme(false);
    }
  };

  return (
    <AdminPage className="admin-workspace-settings">
      <AdminPageHeader section="System" title="Settings" description="System configuration and status" />

      <div className="admin-settings-sections">
        {/* Platform Theme — global, applies to both the chat app and admin console */}
        <Card className="admin-card md:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Palette className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">Platform Theme</CardTitle>
            </div>
            <CardDescription>
              Sets the color theme for the whole platform — both the chat app and this admin console.
              Users see it on their next page load.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {PLATFORM_THEMES.map((t) => {
                const selected = theme === t.id;
                return (
                  <Button
                    key={t.id}
                    variant="ghost"
                    type="button"
                    disabled={savingTheme}
                    onClick={() => handleThemeChange(t.id)}
                    aria-pressed={selected}
                    aria-label={`${t.label} theme${selected ? " (current)" : ""}`}
                    className={`relative flex h-auto min-w-0 whitespace-normal cursor-pointer flex-col items-center gap-1.5 rounded-lg border-2 p-3 transition-colors hover:border-primary/50 disabled:opacity-60 ${
                      selected ? "border-primary bg-primary/5 hover:bg-primary/5" : "border-border hover:bg-transparent"
                    }`}
                  >
                    {selected && (
                      <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-2.5 w-2.5" />
                      </span>
                    )}
                    <span
                      className="size-7 rounded-full border border-border/50"
                      style={{ backgroundColor: t.accent }}
                    />
                    <span className="text-sm font-medium text-foreground leading-tight">{t.label}</span>
                    <span className="text-xs text-muted-foreground leading-tight text-center">{t.description}</span>
                  </Button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* System Status */}
        <Card className="admin-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">System Status</CardTitle>
            </div>
            <CardDescription>Current platform status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Database</span>
              <Badge variant={stats?.dbConnected ? "success" : "destructive"}>
                {stats?.dbConnected ? "Connected" : "Disconnected"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Users</span>
              <span className="text-sm font-medium tabular-nums">{stats?.totalUsers ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Roles</span>
              <span className="text-sm font-medium tabular-nums">{stats?.totalRoles ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Conversations</span>
              <span className="text-sm font-medium tabular-nums">{stats?.totalConversations ?? "—"}</span>
            </div>
          </CardContent>
        </Card>

        {/* Platform Info */}
        <Card className="admin-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">Platform Info</CardTitle>
            </div>
            <CardDescription>Application configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Application</span>
              <span className="text-sm font-medium">Admin Athena v0.1.0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Framework</span>
              <span className="text-sm font-medium">Next.js 16</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Database</span>
              <span className="text-sm font-medium">PostgreSQL + Prisma</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">AI Provider</span>
              <span className="text-sm font-medium">Anthropic Claude</span>
            </div>
          </CardContent>
        </Card>

        {/* Security */}
        <Card className="admin-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">Security</CardTitle>
            </div>
            <CardDescription>Authentication and encryption</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Password Hashing</span>
              <span className="text-sm font-medium">scrypt</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Credential Encryption</span>
              <span className="text-sm font-medium">AES-256-GCM</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Session Expiry</span>
              <span className="text-sm font-medium">30 days</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Audit Logging</span>
              <Badge variant="success">Enabled</Badge>
            </div>
          </CardContent>
        </Card>

        {/* API Keys */}
        <Card className="admin-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Key className="h-5 w-5 text-primary" />
              <CardTitle className="admin-card-title text-lg">API Configuration</CardTitle>
            </div>
            <CardDescription>External service connections</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Anthropic API Key</span>
              <Badge variant={process.env.NEXT_PUBLIC_HAS_API_KEY ? "success" : "secondary"}>
                Configured
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Encryption Key</span>
              <Badge variant="success">Configured</Badge>
            </div>
            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => toast.info("API key management coming in next version")}
              >
                Manage API Keys
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
