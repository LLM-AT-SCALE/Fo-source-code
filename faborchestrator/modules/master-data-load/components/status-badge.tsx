/**
 * StatusBadge — friendly pill for CMF execution / process states.
 *
 * Primary label is the human word ("Success", "Failed", "Validating…").
 * The raw wire code (RESULT-0, STATE-2) is preserved on the title attribute
 * so power users can still see it on hover.
 */

import type { ReactNode } from "react";
import { Check, X, Clock, Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";

type StatusKind =
  | "running"
  | "success"
  | "failed"
  | "queued"
  | "pending";

type Props = {
  status: StatusKind;
  /** Raw wire code rendered into title for power users — e.g. "RESULT-0". */
  code?: string;
  /** Override human label (defaults from DEFAULT_LABEL). */
  label?: string;
  className?: string;
  children?: ReactNode;
};

const DEFAULT_LABEL: Record<StatusKind, string> = {
  running: "Validating…",
  success: "Success",
  failed: "Failed",
  queued: "Queued",
  pending: "Pending",
};

const DEFAULT_CODE: Record<StatusKind, string> = {
  running: "running",
  success: "RESULT-0",
  failed: "RESULT-1",
  queued: "queued",
  pending: "pending",
};

const TONE: Record<
  StatusKind,
  { box: string; text: string; dot: string }
> = {
  running: {
    box: "border-primary/30 bg-primary/10",
    text: "text-primary",
    dot: "bg-primary",
  },
  success: {
    box: "border-emerald-500/30 bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  failed: {
    box: "border-destructive/30 bg-destructive/10",
    text: "text-destructive",
    dot: "bg-destructive",
  },
  queued: {
    box: "border-border bg-muted/50",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  pending: {
    box: "border-border bg-transparent",
    text: "text-muted-foreground",
    dot: "bg-transparent border border-muted-foreground",
  },
};

export function StatusBadge({
  status,
  code,
  label,
  className,
  children,
}: Props) {
  const text = label ?? DEFAULT_LABEL[status];
  const wireCode = code ?? DEFAULT_CODE[status];

  return (
    <span
      role="status"
      title={wireCode}
      aria-label={`${text} (${wireCode})`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
        "text-xs font-medium leading-5",
        "whitespace-nowrap",
        TONE[status].box,
        TONE[status].text,
        className,
      )}
    >
      <StatusGlyph status={status} />
      <span>{text}</span>
      {children}
    </span>
  );
}

function StatusGlyph({ status }: { status: StatusKind }) {
  if (status === "success") {
    return <Check className="h-3 w-3" aria-hidden />;
  }
  if (status === "failed") {
    return <X className="h-3 w-3" aria-hidden />;
  }
  if (status === "running") {
    return <Loader2 className="h-3 w-3 animate-spin" aria-hidden />;
  }
  if (status === "queued") {
    return <Clock className="h-3 w-3" aria-hidden />;
  }
  return (
    <span
      aria-hidden
      className={cn("inline-block h-1.5 w-1.5 rounded-full", TONE[status].dot)}
    />
  );
}

/**
 * Convenience wrapper: map a CMF wire result (0/1) directly to a badge.
 */
export function ResultBadge({
  result,
  className,
}: {
  result: 0 | 1 | null | undefined;
  className?: string;
}) {
  if (result === 0)
    return <StatusBadge status="success" className={className} />;
  if (result === 1)
    return <StatusBadge status="failed" className={className} />;
  return (
    <StatusBadge
      status="pending"
      label="Not run yet"
      className={className}
    />
  );
}
