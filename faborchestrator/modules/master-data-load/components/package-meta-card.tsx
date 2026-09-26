/**
 * PackageMetaCard — compact metadata card for a MasterDataPackage detail page.
 * Title-case labels, mono font reserved for IDs / checksums / timestamps.
 */

import type { MasterDataPackage } from "@/modules/master-data-load/lib/cmf/types";
import { cn } from "@/shared/lib/utils";

type Props = {
  pkg: MasterDataPackage;
  className?: string;
};

export function PackageMetaCard({ pkg, className }: Props) {
  const file = pkg.Package;
  const rows: Array<{ k: string; v: React.ReactNode; mono?: boolean; full?: boolean }> = [
    { k: "ID", v: pkg.Id, mono: true },
    { k: "Name", v: pkg.Name },
    { k: "Type", v: pkg.Type ?? "Generic" },
    { k: "Revision", v: pkg.Revision ?? "—", mono: true },
    { k: "Created by", v: pkg.CreatedBy ?? "—" },
    { k: "Created on", v: formatDate(pkg.CreatedOn), mono: true },
    { k: "Modified by", v: pkg.ModifiedBy ?? "—" },
    { k: "Modified on", v: formatDate(pkg.ModifiedOn), mono: true },
  ];

  const fileRows: Array<{ k: string; v: React.ReactNode; mono?: boolean; full?: boolean }> = file
    ? [
        { k: "File name", v: file.Filename },
        { k: "File size", v: formatBytes(file.Size), mono: true },
        { k: "Content type", v: file.ContentType ?? "—" },
        {
          k: "Content location",
          v: file.ContentLocation ?? "—",
          mono: true,
          full: true,
        },
        {
          k: "SHA-256",
          v: file.Checksum ? file.Checksum.toUpperCase() : "—",
          mono: true,
          full: true,
        },
      ]
    : [];

  return (
    <section
      aria-label="Package metadata"
      className={cn(
        "rounded-lg border border-border bg-card shadow-sm",
        className,
      )}
    >
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate">{pkg.Name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Package details</p>
        </div>
        <span className="ml-auto pill font-mono nums text-[11px]" data-tone="muted">
          {shortId(pkg.Id)}
        </span>
      </header>

      <dl className="grid grid-cols-1 md:grid-cols-2">
        {rows.map((r) => (
          <Row key={r.k} {...r} />
        ))}
      </dl>

      {fileRows.length > 0 && (
        <>
          <div className="border-t border-border px-5 py-2.5 text-xs font-medium text-muted-foreground bg-muted/30">
            File
          </div>
          <dl className="grid grid-cols-1 md:grid-cols-2">
            {fileRows.map((r) => (
              <Row key={r.k} {...r} />
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

function Row({
  k,
  v,
  mono,
  full,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[8rem_1fr] gap-3 border-b border-border px-5 py-2.5 last:border-b-0",
        full && "md:col-span-2",
      )}
    >
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd
        className={cn(
          "min-w-0 break-all text-foreground",
          mono ? "font-mono nums text-xs" : "text-sm",
        )}
      >
        {v}
      </dd>
    </div>
  );
}

function formatBytes(size?: string | number): string {
  const n = typeof size === "string" ? Number(size) : size;
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function shortId(id: string): string {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}` : id;
}
