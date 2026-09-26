"use client";

import { Badge } from "@/shared/components/ui/badge";

/** Status pill for a dashboard request (shared by the list and detail pages). */
export function RequestStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "requested":
      return <Badge variant="warning">Awaiting review</Badge>;
    case "approved":
    case "compiling":
      return <Badge variant="secondary">Compiling</Badge>;
    case "compile_failed":
      return <Badge variant="destructive">Compile failed</Badge>;
    case "preview_ready":
      return <Badge className="border-transparent bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Preview ready</Badge>;
    case "live":
      return <Badge variant="success">Live</Badge>;
    case "denied":
      return <Badge variant="outline" className="text-muted-foreground">Denied</Badge>;
    case "cancelled":
      return <Badge variant="outline" className="text-muted-foreground">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

/** "3 min" / "2 h" / "5 d" since an ISO timestamp. */
export function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d`;
}
