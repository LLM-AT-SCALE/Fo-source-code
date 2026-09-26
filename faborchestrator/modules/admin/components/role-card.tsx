"use client";

import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Shield, Pencil, Trash2 } from "lucide-react";
import { ADMIN_ROLE_NAME, PERMISSION_LABELS as SHARED_PERMISSION_LABELS } from "@/shared/lib/permissions";

interface RoleCardProps {
  role: {
    id: string;
    name: string;
    description: string | null;
    isSystemRole: boolean;
    allowedModels: unknown;
    permissions: unknown;
    personalMcpEnabled: boolean;
    dailyRequestLimit: number | null;
    dailyTokenLimit: number | null;
    memberCount: number;
  };
  onEdit: () => void;
  onDelete: () => void;
}

const PERMISSION_LABELS: Record<string, string> = { ...SHARED_PERMISSION_LABELS };

/** "file_upload" → "File upload"; unknown keys are humanised from snake_case. */
function permissionLabel(key: string): string {
  if (PERMISSION_LABELS[key]) return PERMISSION_LABELS[key];
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const MAX_CHIPS = 4;

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col items-center px-2 py-2 text-center">
      <span className="text-lg font-semibold tabular-nums leading-tight">{value.toLocaleString()}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** One role as an equal-height card: identity, three counts, permission chips, limits. */
export function RoleCard({ role, onEdit, onDelete }: RoleCardProps) {
  const models = Array.isArray(role.allowedModels) ? (role.allowedModels as unknown[]) : [];
  const permissions = Array.isArray(role.permissions) ? (role.permissions as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const shown = permissions.slice(0, MAX_CHIPS);
  const more = permissions.length - shown.length;
  const limits = `${role.dailyRequestLimit?.toLocaleString() ?? "Unlimited"} requests · ${role.dailyTokenLimit?.toLocaleString() ?? "Unlimited"} tokens`;

  return (
    <Card className="flex h-full min-w-0 flex-col gap-4 rounded-xl border p-5 shadow-none transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Shield className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold tracking-tight">{role.name}</h3>
            {role.isSystemRole && <Badge variant="secondary">System</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {role.description || "Access and usage policy for this role."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${role.name}`}>
            <Pencil className="size-3.5" aria-hidden="true" /> Edit
          </Button>
          {/* The built-in Admin role can never be deleted (the server refuses too). */}
          {!(role.isSystemRole && role.name === ADMIN_ROLE_NAME) && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label={`Delete ${role.name}`}
              title={role.isSystemRole ? "Delete this role (users must be reassigned first)" : "Delete this role"}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-border rounded-lg border bg-muted/30">
        <Stat label="Members" value={role.memberCount} />
        <Stat label="Models" value={models.length} />
        <Stat label="Permissions" value={permissions.length} />
      </div>

      <div className="flex min-w-0 flex-wrap gap-1.5">
        {shown.length === 0 && !role.personalMcpEnabled && <span className="text-xs text-muted-foreground">No permissions</span>}
        {shown.map((p) => (
          <Badge key={p} variant="outline" className="max-w-full truncate">{permissionLabel(p)}</Badge>
        ))}
        {more > 0 && <Badge variant="outline" className="text-muted-foreground">+{more}</Badge>}
        {role.personalMcpEnabled && <Badge variant="secondary">Personal MCP</Badge>}
      </div>

      <p className="mt-auto truncate text-xs text-muted-foreground" title={limits}>
        Daily limits: {limits}
      </p>
    </Card>
  );
}
