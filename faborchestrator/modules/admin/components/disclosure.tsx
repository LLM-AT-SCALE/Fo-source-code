"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * A collapsed-by-default section for secondary detail. Native <details> so it
 * needs no state, works with the keyboard and prints open. The summary row
 * carries a title, an optional one-line hint (what is inside / current value)
 * and an optional count.
 */
export function Disclosure({
  title,
  hint,
  count,
  defaultOpen = false,
  children,
  className = "",
}: {
  title: string;
  hint?: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`admin-disclosure group rounded-lg border bg-card ${className}`} open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <span className="font-medium">{title}</span>
        {typeof count === "number" && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
        )}
        {hint && <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{hint}</span>}
      </summary>
      <div className="border-t px-4 py-4">{children}</div>
    </details>
  );
}

/** Compact horizontal progress: the stages of a request, current one highlighted. */
export function StageStrip({ stages, current }: { stages: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label="Progress">
      {stages.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              className={
                active
                  ? "rounded-full bg-primary px-2.5 py-0.5 font-medium text-primary-foreground"
                  : done
                    ? "rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary"
                    : "rounded-full border px-2.5 py-0.5 text-muted-foreground"
              }
              aria-current={active ? "step" : undefined}
            >
              {s}
            </span>
            {i < stages.length - 1 && <span className="text-muted-foreground/60" aria-hidden>›</span>}
          </li>
        );
      })}
    </ol>
  );
}
