"use client";

/**
 * MCP health pill — the small status pill shown on each connector card in the
 * Admin Console (and reusable on the cockpit). Same visual language as the
 * card's Active/Inactive pill: a dot + label, followed by muted "checked …"
 * text with the total round-trip time when the check measured one.
 */
import {
  MCP_HEALTH_LABELS,
  healthLayers,
  type McpDatabaseLayer,
  type McpHealthDetail,
  type McpHealthStatus,
  type McpServerLayer,
} from "@/modules/mcp/lib/mcp-health-types";

/** Colour classes per status: the pill surface, its text and the dot. */
export function statusTone(status: McpHealthStatus): { pill: string; dot: string; text: string } {
  switch (status) {
    case "healthy":
      return { pill: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400", dot: "bg-green-500", text: "text-green-700 dark:text-green-400" };
    case "degraded":
      return { pill: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" };
    case "down":
      return { pill: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400", dot: "bg-red-500", text: "text-red-700 dark:text-red-400" };
    default:
      return { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground", text: "text-muted-foreground" };
  }
}

const STAGE_LABELS: Record<number, string> = {
  0: "Not reachable",
  1: "Reachable (initialize answered)",
  2: "Tools listed",
  3: "Data returned",
};

/** "just now", "2 min ago", "3 h ago", "2 d ago"; re-evaluated on every render. */
export function healthRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 1) return "1 min ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

/** Sum of the stage timings that were measured; null when none was. */
export function healthTotalMs(detail: McpHealthDetail | null | undefined): number | null {
  if (!detail) return null;
  const parts = [detail.reachMs, detail.toolsMs, detail.dataMs].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Tooltip text: the stage reached plus the error, when there is one. */
export function healthTitle(status: McpHealthStatus, detail: McpHealthDetail | null | undefined, checkedAt: string | null | undefined): string {
  const lines: string[] = [MCP_HEALTH_LABELS[status] ?? status];
  if (detail) lines.push(`Stage ${detail.stage}/3: ${STAGE_LABELS[detail.stage] ?? "Unknown stage"}`);
  else if (!checkedAt) lines.push("Not checked yet");
  if (checkedAt) lines.push(`Checked ${new Date(checkedAt).toLocaleString()}`);
  if (detail?.error) lines.push(`Error: ${detail.error}`);
  return lines.join("\n");
}

/** Words and colour per layer state — the same wording as the cockpit. */
const SERVER_LAYER: Record<McpServerLayer, { text: string; tone: McpHealthStatus }> = {
  up: { text: "Healthy", tone: "healthy" },
  down: { text: "Down", tone: "down" },
  "not-checked": { text: "Not checked", tone: "unknown" },
};
const DATABASE_LAYER: Record<McpDatabaseLayer, { text: string; tone: McpHealthStatus }> = {
  ok: { text: "Healthy", tone: "healthy" },
  failed: { text: "Down", tone: "down" },
  "not-tested": { text: "Not checked", tone: "unknown" },
};

function LayerPill({ label, text, tone, title }: { label: string; text: string; tone: McpHealthStatus; title: string }) {
  const t = statusTone(tone);
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${t.pill}`} role="status" aria-label={`${label}: ${text}`} title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
      <span className="opacity-75">{label}</span> {text}
    </span>
  );
}

/**
 * The two things an operator asks about a connector: is the MCP server up, and
 * does its database answer. Followed by "checked … · … ms".
 */
export function McpLayerPills({ detail, checkedAt, className }: { detail: McpHealthDetail | null | undefined; checkedAt?: string | null; className?: string }) {
  const when = checkedAt ?? detail?.checkedAt ?? null;
  const layers = healthLayers(when ? detail : null);
  const server = SERVER_LAYER[layers.server];
  const database = DATABASE_LAYER[layers.database];
  const total = healthTotalMs(detail);
  const title = healthTitle(detail?.status ?? "unknown", detail, when);
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      <LayerPill label="MCP Server" text={server.text} tone={server.tone} title={title} />
      <LayerPill label="DB" text={database.text} tone={database.tone} title={detail?.toolUsed ? `${title}\nDatabase checked with ${detail.toolUsed}` : title} />
      <span className="truncate text-xs text-muted-foreground">
        {when ? `checked ${healthRelativeTime(when)}` : "not checked yet"}
        {total !== null ? ` · ${formatMs(total)}` : ""}
      </span>
    </span>
  );
}

export interface McpHealthPillProps {
  status: McpHealthStatus | null | undefined;
  checkedAt?: string | null;
  detail?: McpHealthDetail | null;
  /** Hide the "checked … · … ms" text (e.g. in dense lists). */
  compact?: boolean;
  className?: string;
}

export function McpHealthPill({ status, checkedAt, detail, compact = false, className }: McpHealthPillProps) {
  const s: McpHealthStatus = status ?? "unknown";
  const tone = statusTone(s);
  const when = checkedAt ?? detail?.checkedAt ?? null;
  const total = healthTotalMs(detail);
  const title = healthTitle(s, detail, when);

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ""}`} title={title}>
      <span
        className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${tone.pill}`}
        role="status"
        aria-label={`Health: ${MCP_HEALTH_LABELS[s]}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
        {MCP_HEALTH_LABELS[s]}
      </span>
      {!compact && (
        <span className="truncate text-xs text-muted-foreground">
          {when ? `checked ${healthRelativeTime(when)}` : "not checked yet"}
          {total !== null ? ` · ${formatMs(total)}` : ""}
        </span>
      )}
    </span>
  );
}
