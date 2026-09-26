"use client";

/**
 * FileDropZone — drag/drop or browse for a CMF master-data package file.
 * Accepts Excel (.xlsx) only — the master-data template is an Excel workbook.
 * Computes SHA-256 client-side using SubtleCrypto and reports back via onFile.
 */

import { useCallback, useId, useRef, useState } from "react";
import { FileUp, FileCheck2, X } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { Spinner } from "@/shared/components/ui/spinner";
import { cn } from "@/shared/lib/utils";

type Props = {
  onFile: (file: File, sha256Hex: string) => void;
  onClear?: () => void;
  accept?: string;
  className?: string;
  disabled?: boolean;
};

type Selected = {
  file: File;
  sha256: string;
};

const DEFAULT_ACCEPT = ".xlsx";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel-only: the master-data template is an .xlsx workbook. */
function isExcel(file: File): boolean {
  return file.name.toLowerCase().endsWith(".xlsx") || file.type === XLSX_MIME;
}

export function FileDropZone({
  onFile,
  onClear,
  accept = DEFAULT_ACCEPT,
  className,
  disabled = false,
}: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [hashing, setHashing] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!isExcel(file)) {
        setSelected(null);
        setError(`Only Excel files (.xlsx) are supported — "${file.name}" was rejected.`);
        onClear?.();
        return;
      }
      setHashing(true);
      try {
        const sha256 = await sha256Hex(file);
        const next = { file, sha256 };
        setSelected(next);
        onFile(file, sha256);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Hash failed.");
        setSelected(null);
      } finally {
        setHashing(false);
      }
    },
    [onFile, onClear],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [disabled, handleFile],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const clear = () => {
    setSelected(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
    onClear?.();
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <label
        htmlFor={inputId}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/50",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          onChange={onChange}
          className="sr-only"
          disabled={disabled}
        />

        <span
          className={cn(
            "flex size-11 items-center justify-center rounded-full transition-colors",
            dragOver ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
          )}
        >
          <FileUp className="size-5" aria-hidden />
        </span>
        <span className={cn("mt-4 text-sm font-medium", dragOver ? "text-primary" : "text-foreground")}>
          Drop your master-data file here
        </span>
        <span className="mt-1 text-xs text-muted-foreground">
          or <span className="font-medium text-primary underline-offset-2 hover:underline">click to browse</span>
        </span>
        <span className="mt-3 text-[11px] text-muted-foreground">
          Accepts {accept.split(",").join(", ")}
        </span>
      </label>

      {hashing && (
        <p role="status" className="flex items-center gap-2 text-xs text-primary">
          <Spinner className="size-3.5" />
          Computing checksum…
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}

      {selected && !hashing && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
            <FileCheck2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="text-sm font-medium">File ready</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clear}
              className="ml-auto"
              aria-label="Remove file"
            >
              <X data-icon="inline-start" />
              Clear
            </Button>
          </div>
          <dl className="divide-y divide-border text-sm">
            <Row k="Name" v={selected.file.name} />
            <Row k="Size" v={formatBytes(selected.file.size)} mono />
            <Row k="Type" v={selected.file.type || "application/octet-stream"} />
            <Row k="SHA-256" v={selected.sha256.toUpperCase()} mono breakAll />
          </dl>
        </div>
      )}
    </div>
  );
}

function Row({
  k,
  v,
  mono,
  breakAll,
}: {
  k: string;
  v: string;
  mono?: boolean;
  breakAll?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 px-4 py-2.5">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd
        className={cn(
          "text-foreground",
          mono ? "nums font-mono text-xs" : "text-sm",
          breakAll && "break-all",
        )}
      >
        {v}
      </dd>
    </div>
  );
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "--";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function sha256Hex(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SubtleCrypto unavailable in this browser.");
  }
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
