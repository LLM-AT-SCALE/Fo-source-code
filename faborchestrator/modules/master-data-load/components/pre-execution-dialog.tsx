"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Database, ShieldCheck, TriangleAlert } from "lucide-react";
import type { UserFriendlyObjectType } from "@/modules/master-data-load/lib/cmf/types";
import { cn } from "@/shared/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  op: "validate" | "load";
  packageName: string;
  fileName?: string;
  fileSizeBytes?: number | string;
  checksum?: string;
  selected: UserFriendlyObjectType[];
  totalAvailable: number;
  onConfirm: () => void;
  /**
   * When set, the user must type this exact word (e.g. "LOAD") before the
   * confirm button unlocks — a deliberate friction gate for production writes.
   */
  requireTypedConfirm?: string;
};

const INLINE_LIMIT = 8;

export function PreExecutionDialog({
  open,
  onOpenChange,
  op,
  packageName,
  fileName,
  fileSizeBytes,
  checksum,
  selected,
  totalAvailable,
  onConfirm,
  requireTypedConfirm,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [typed, setTyped] = useState("");

  const isLoad = op === "load";
  const typedOk =
    !requireTypedConfirm ||
    typed.trim().toUpperCase() === requireTypedConfirm.trim().toUpperCase();
  const confirmDisabled = selected.length === 0 || !typedOk;

  // Clear the typed gate whenever the dialog is reopened.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const title = isLoad
    ? `About to load "${packageName}"`
    : `About to validate "${packageName}"`;

  const sizeText = useMemo(() => formatBytes(fileSizeBytes), [fileSizeBytes]);
  const shortHash = useMemo(() => {
    if (!checksum) return null;
    const up = checksum.toUpperCase();
    if (up.length <= 12) return up;
    return `${up.slice(0, 8)}…${up.slice(-4)}`;
  }, [checksum]);

  const inline = selected.slice(0, INLINE_LIMIT);
  const moreCount = Math.max(0, selected.length - inline.length);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-lg",
          isLoad ? "ring-destructive/30" : "ring-primary/20",
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {(fileName || sizeText !== "—" || shortHash) && (
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5">
              {fileName && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">File</span>
                  <span className="min-w-0 flex-1 truncate text-right text-sm text-foreground">
                    {fileName}
                  </span>
                  <span className="font-mono nums text-xs text-muted-foreground shrink-0">
                    {sizeText}
                  </span>
                </div>
              )}
              {shortHash && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    SHA-256
                  </span>
                  <span
                    title={checksum?.toUpperCase()}
                    className="font-mono nums text-xs text-foreground cursor-help"
                  >
                    {shortHash}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm text-foreground">
              You&apos;ve selected{" "}
              <span className="font-mono nums font-semibold">
                {selected.length}
              </span>{" "}
              of{" "}
              <span className="font-mono nums font-semibold">
                {totalAvailable}
              </span>{" "}
              object type{selected.length === 1 ? "" : "s"}:
            </p>

            {selected.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing selected.
              </p>
            ) : !expanded ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {inline.map((t) => t.ObjectType).join(", ")}
                {moreCount > 0 && (
                  <>
                    {" "}
                    <span className="text-muted-foreground">
                      … (and{" "}
                      <span className="font-mono nums">{moreCount}</span> more)
                    </span>
                  </>
                )}
                {selected.length > INLINE_LIMIT && (
                  <>
                    {"  "}
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      className="ml-1 inline text-primary hover:underline"
                    >
                      Show all {selected.length}
                    </button>
                  </>
                )}
              </p>
            ) : (
              <div className="rounded-md border border-border bg-background">
                <ul className="max-h-48 overflow-auto py-1">
                  {selected.map((t) => (
                    <li
                      key={t.ObjectType}
                      className="flex items-baseline gap-3 px-3 py-1.5"
                    >
                      <span className="text-sm text-foreground truncate">
                        {t.ObjectType}
                      </span>
                      {t.ObjectDescription && (
                        <span className="ml-auto truncate text-[11px] text-muted-foreground">
                          {t.ObjectDescription}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end border-t border-border px-2 py-1">
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Collapse
                  </button>
                </div>
              </div>
            )}
          </div>

          <div
            className={cn(
              "flex items-start gap-2.5 rounded-md border p-3 text-xs",
              isLoad
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
            )}
          >
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
            <p className="leading-relaxed">
              {isLoad ? (
                <>
                  This will load data into MES (production). Object types will
                  be created or updated as defined in the file.
                </>
              ) : (
                <>
                  This will write to the production database. CMF processes
                  the rows and updates affected tables.
                </>
              )}
            </p>
          </div>

          {requireTypedConfirm && (
            <div className="space-y-1.5">
              <label htmlFor="typed-confirm" className="block text-xs text-muted-foreground">
                Type{" "}
                <span className="font-mono font-semibold text-foreground">
                  {requireTypedConfirm}
                </span>{" "}
                to enable the button below.
              </label>
              <input
                id="typed-confirm"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={requireTypedConfirm}
                className={cn(
                  "h-9 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  typedOk && typed
                    ? "border-emerald-500/50 focus-visible:ring-emerald-500/40"
                    : "border-input focus-visible:ring-destructive/40",
                )}
              />
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border">
          <DialogClose asChild>
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-secondary"
            >
              Cancel
            </button>
          </DialogClose>
          <DialogClose asChild>
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
                isLoad
                  ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive"
                  : "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring",
              )}
            >
              {isLoad ? (
                <Database className="h-4 w-4" aria-hidden />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden />
              )}
              {isLoad ? "Confirm and load" : "Confirm and validate"}
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(size?: string | number | null): string {
  if (size == null) return "—";
  const n = typeof size === "string" ? Number(size) : size;
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
