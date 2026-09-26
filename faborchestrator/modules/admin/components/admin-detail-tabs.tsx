"use client";

import { cn } from "@/shared/lib/utils";

/** Manual page tabs with keyboard selection; panels stay mounted to retain drafts. */
export function AdminDetailTabs({ id, value, onChange, items }: { id: string; value: string; onChange: (value: string) => void; items: { id: string; label: string; count?: number }[] }) {
  return (
    <div className="admin-detail-tabs" role="tablist" aria-label="Detail sections">
      {items.map((item, index) => (
        <button
          key={item.id}
          id={`${id}-tab-${item.id}`}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          aria-controls={`${id}-panel-${item.id}`}
          tabIndex={value === item.id ? 0 : -1}
          className={cn("admin-detail-tab", value === item.id && "admin-detail-tab-active")}
          onClick={() => onChange(item.id)}
          onKeyDown={event => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % items.length;
            else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else return;
            event.preventDefault();
            onChange(items[next].id);
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons?.[next]?.focus();
          }}
        >
          {item.label}{item.count !== undefined && <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function AdminDetailPanel({ id, value, active, children }: { id: string; value: string; active: string; children: React.ReactNode }) {
  return <section className="admin-detail-panel" id={`${id}-panel-${value}`} role="tabpanel" aria-labelledby={`${id}-tab-${value}`} hidden={active !== value} tabIndex={0}>{children}</section>;
}
