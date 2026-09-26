"use client";

import { cn } from "@/shared/lib/utils";

/**
 * Sandboxed preview of model-authored dashboard HTML. `allow-scripts` only —
 * NEVER `allow-same-origin`, so the document cannot reach the admin session,
 * localStorage or cookies.
 */
export function DashboardPreview({
  html,
  title = "Dashboard preview",
  className,
  height = 520,
}: {
  html: string | null | undefined;
  title?: string;
  className?: string;
  height?: number;
}) {
  if (!html) {
    return (
      <div className={cn("flex items-center justify-center rounded-lg border bg-muted/30 text-sm text-muted-foreground", className)} style={{ height }}>
        No preview available.
      </div>
    );
  }
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      srcDoc={html}
      className={cn("w-full rounded-lg border bg-white", className)}
      style={{ height }}
    />
  );
}
