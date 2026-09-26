"use client";

/**
 * ObjectTypeSelector — controlled card-with-checkboxes letting the user
 * pick which UserFriendlyObjectTypes from a master-data package will be
 * processed.
 *
 * Default state is intentionally empty (opt-in) — Load writes to the
 * database in CMF, so we don't want fire-and-forget selections.
 *
 * Toolbar (top): search box + Select all / Clear + selection tally.
 * The list itself scrolls internally so a long file (hundreds of object
 * types) doesn't push the rest of the page off-screen.
 */

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { ObjectModelType, UserFriendlyObjectType } from "@/modules/master-data-load/lib/cmf/types";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { Input } from "@/shared/components/ui/input";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/shared/components/ui/empty";
import { cn } from "@/shared/lib/utils";

type Props = {
  objectTypes: UserFriendlyObjectType[];
  selected: UserFriendlyObjectType[];
  onChange: (selected: UserFriendlyObjectType[]) => void;
  disabled?: boolean;
  className?: string;
  /** Maximum height of the scrollable list area. Defaults to 24rem (~384 px). */
  listMaxHeightClass?: string;
};

const MODEL_LABEL: Record<ObjectModelType, string> = {
  1: "Lookup",
  2: "Entity",
  3: "Generic Table",
  4: "Smart Table",
};

export function ObjectTypeSelector({
  objectTypes,
  selected,
  onChange,
  disabled = false,
  className,
  listMaxHeightClass = "max-h-96",
}: Props) {
  const [query, setQuery] = useState("");

  const selectedKeys = useMemo(
    () => new Set(selected.map((t) => t.ObjectType)),
    [selected],
  );

  // Case-insensitive filter on ObjectType + ObjectDescription.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return objectTypes;
    return objectTypes.filter((t) => {
      const name = t.ObjectType.toLowerCase();
      const desc = (t.ObjectDescription ?? "").toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [objectTypes, query]);

  const toggleOne = (t: UserFriendlyObjectType) => {
    if (disabled) return;
    if (selectedKeys.has(t.ObjectType)) {
      onChange(selected.filter((s) => s.ObjectType !== t.ObjectType));
    } else {
      onChange([...selected, t]);
    }
  };

  // Select all acts on the CURRENT filter (what the user can see).
  const selectAllVisible = () => {
    if (disabled) return;
    const merged = new Map<string, UserFriendlyObjectType>();
    for (const s of selected) merged.set(s.ObjectType, s);
    for (const t of filtered) merged.set(t.ObjectType, t);
    onChange(Array.from(merged.values()));
  };

  const clearAll = () => {
    if (disabled) return;
    onChange([]);
  };

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((t) => selectedKeys.has(t.ObjectType));

  const hasResults = filtered.length > 0;

  return (
    <section
      aria-label="Select what to load"
      className={cn("flex flex-col overflow-hidden rounded-xl border border-border bg-card", className)}
    >
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-heading text-sm font-medium">Select what to load</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Choose which object types from this file should be processed.
            </p>
          </div>
          <Badge variant={selected.length > 0 ? "default" : "secondary"}>
            {selected.length} of {objectTypes.length} selected
          </Badge>
        </div>

        {/* Toolbar: search left, action buttons right */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="text"
              role="searchbox"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={disabled}
              placeholder="Search object types…"
              aria-label="Filter object types"
              className="h-8 pl-8 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={selectAllVisible}
              disabled={disabled || !hasResults || allVisibleSelected}
              title={query ? `Select all ${filtered.length} matching object types` : "Select all"}
            >
              {query ? `Select all (${filtered.length})` : "Select all"}
            </Button>
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={disabled || selected.length === 0}>
              Clear
            </Button>
          </div>
        </div>
      </header>

      {objectTypes.length === 0 ? (
        <Empty className="border-0 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>No object types</EmptyTitle>
            <EmptyDescription>CMF didn&apos;t report any object types for this package.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !hasResults ? (
        <Empty className="border-0 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>No matches</EmptyTitle>
            <EmptyDescription>
              Nothing matches <span className="font-mono text-foreground">“{query}”</span>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className={cn("overflow-y-auto", listMaxHeightClass)}>
          <ul className="divide-y divide-border">
            {filtered.map((t) => {
              const isOn = selectedKeys.has(t.ObjectType);
              return (
                <li key={t.ObjectType}>
                  <label
                    className={cn(
                      "group flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors",
                      isOn ? "bg-primary/5" : "hover:bg-muted/40",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <Checkbox
                      checked={isOn}
                      onCheckedChange={() => toggleOne(t)}
                      disabled={disabled}
                      className="mt-0.5"
                      aria-label={`Select ${t.ObjectType}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{t.ObjectType}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {MODEL_LABEL[t.ObjectModelType] ?? "Unknown"}
                        </Badge>
                      </div>
                      {t.ObjectDescription && (
                        <p className="mt-1 text-xs text-muted-foreground">{t.ObjectDescription}</p>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
