import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import { Input } from "@/shared/components/ui/input";
import { Search } from "lucide-react";

/** Page-local patterns: never wrap the AI Chat route in AdminPage. */
export function AdminPage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("admin-page", className)}>{children}</div>;
}

/** A single collection workspace for context, filters, records and pagination. */
export function AdminCollection({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("admin-collection", className)}>{children}</section>;
}

/** UI/UX Pro Max data-dense dashboard pattern: labeled, comparable metric groups. */
export function AdminMetricGroup({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <section className={cn("admin-metric-group", className)} aria-label={title}><h2>{title}</h2><div className="admin-metric-group-body">{children}</div></section>;
}

/** Keeps related form fields together without changing their state or handlers. */
export function AdminFormSection({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return <fieldset className={cn("admin-form-section", className)}><legend>{title}</legend>{description && <p className="admin-form-description">{description}</p>}<div className="admin-form-fields">{children}</div></fieldset>;
}

export function AdminToolbar({ children, label = "Filters and actions", className }: { children: ReactNode; label?: string; className?: string }) {
  return <div role="group" aria-label={label} className={cn("admin-toolbar", className)}>{children}</div>;
}

export function AdminSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full sm:max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} className="pl-9" />
    </div>
  );
}

export function AdminCollectionHeader({ title, description, count, children }: { title: string; description?: string; count?: number; children?: ReactNode }) {
  return (
    <div className="admin-collection-header">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {count !== undefined && <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{count}</span>}
        </h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
