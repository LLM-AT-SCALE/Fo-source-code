"use client";

/**
 * ExecutionLogViewer — renders an `ExecutionLogEntry[]` from a CMF
 * PerformMasterDataPackage response.
 *
 * Each entry is a stacked row with a clean Title Case status and
 * counters for created / updated / skipped. State numbers are kept in
 * the title attribute as a tooltip only.
 */

import { useMemo, useState } from "react";
import { Check, X, ChevronRight, MessageCircle } from "lucide-react";
import type { ExecutionLogEntry } from "@/modules/master-data-load/lib/cmf/types";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/components/ui/collapsible";
import { cn } from "@/shared/lib/utils";

type Props = {
  entries: ExecutionLogEntry[] | undefined | null;
  defaultOpenFailed?: boolean;
  className?: string;
};

export function ExecutionLogViewer({
  entries,
  defaultOpenFailed = true,
  className,
}: Props) {
  const items = useMemo(() => entries ?? [], [entries]);

  const totals = useMemo(() => {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const e of items) {
      created += e.CreatedObjectsCounter ?? 0;
      updated += e.UpdatedObjectsCounter ?? 0;
      skipped += e.SkippedObjectsCounter ?? 0;
      if (e.State === 3) failed += 1;
    }
    return { created, updated, skipped, failed, total: items.length };
  }, [items]);

  if (items.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg border border-border bg-card p-8 text-center shadow-sm",
          className,
        )}
      >
        <p className="text-sm text-muted-foreground">
          No execution log yet. Run validate or load to populate it.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-5 py-3 shadow-sm">
        <h3 className="text-sm font-semibold">Execution summary</h3>
        <Counter label="Entries" value={totals.total} />
        <Counter label="Created" value={totals.created} tone="success" />
        <Counter label="Updated" value={totals.updated} tone="primary" />
        <Counter label="Skipped" value={totals.skipped} tone="muted" />
        {totals.failed > 0 && (
          <Counter label="Failed" value={totals.failed} tone="danger" />
        )}
      </header>

      <ul className="space-y-2">
        {items.map((entry, i) => (
          <LogRow
            key={`${entry.Name}-${i}`}
            entry={entry}
            defaultOpen={defaultOpenFailed && entry.State === 3}
          />
        ))}
      </ul>
    </div>
  );
}

function LogRow({
  entry,
  defaultOpen,
}: {
  entry: ExecutionLogEntry;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const failed = entry.State === 3;
  const duration = computeDurationMs(entry.StartDate, entry.EndDate);
  const hasMessages = (entry.Messages?.length ?? 0) > 0;

  return (
    <li
      className={cn(
        "rounded-lg border bg-card shadow-sm",
        failed
          ? "border-destructive/30"
          : "border-border",
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={!hasMessages}
          className={cn(
            "flex w-full items-start gap-3 rounded-lg px-4 py-3 text-left",
            hasMessages && "cursor-pointer hover:bg-secondary/40",
            "transition-colors",
          )}
        >
          <StateGlyph failed={failed} />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground truncate">
                {entry.Name}
              </span>
              <span
                title={`STATE-${entry.State}`}
                className={cn(
                  "text-xs font-medium",
                  failed
                    ? "text-destructive"
                    : "text-emerald-700 dark:text-emerald-400",
                )}
              >
                {failed ? "Failed" : "Success"}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                  +{entry.CreatedObjectsCounter ?? 0}
                </span>{" "}
                created
              </span>
              <span>
                <span className="text-primary font-medium">
                  ~{entry.UpdatedObjectsCounter ?? 0}
                </span>{" "}
                updated
              </span>
              <span>
                <span className="text-foreground font-medium">
                  ×{entry.SkippedObjectsCounter ?? 0}
                </span>{" "}
                skipped
              </span>
              {hasMessages && (
                <span className="inline-flex items-center gap-1">
                  <MessageCircle className="h-3 w-3" aria-hidden />
                  {entry.Messages.length}{" "}
                  {entry.Messages.length === 1 ? "message" : "messages"}
                </span>
              )}
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="font-mono nums text-xs text-foreground">
              {formatTime(entry.StartDate)}
              <span className="text-muted-foreground"> → </span>
              {formatTime(entry.EndDate)}
            </div>
            <div className="font-mono nums text-[11px] text-muted-foreground">
              {duration != null ? `${duration.toLocaleString()} ms` : "—"}
            </div>
          </div>

          {hasMessages && (
            <ChevronRight
              aria-hidden
              className={cn(
                "ml-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
          )}
        </CollapsibleTrigger>

        {hasMessages && (
          <CollapsibleContent>
            <ul className="border-t border-border bg-muted/30 rounded-b-lg">
              {entry.Messages.map((msg, i) => (
                <li
                  key={i}
                  className="flex gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0"
                >
                  <span className="font-mono nums text-[11px] text-muted-foreground w-8 shrink-0 pt-0.5">
                    {String(i + 1).padStart(3, "0")}
                  </span>
                  <pre
                    className={cn(
                      "min-w-0 flex-1 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed",
                      failed ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {msg}
                  </pre>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

function StateGlyph({ failed }: { failed: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
        failed
          ? "bg-destructive/10 text-destructive"
          : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      )}
    >
      {failed ? (
        <X className="h-3.5 w-3.5" />
      ) : (
        <Check className="h-3.5 w-3.5" />
      )}
    </div>
  );
}

function Counter({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "muted" | "danger" | "success" | "primary";
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-sm font-semibold nums",
          tone === "danger" && "text-destructive",
          tone === "muted" && "text-foreground",
          tone === "success" && "text-emerald-700 dark:text-emerald-400",
          tone === "primary" && "text-primary",
          tone === "default" && "text-foreground",
        )}
      >
        {value.toLocaleString()}
      </span>
    </span>
  );
}

function computeDurationMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.max(0, e - s);
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
