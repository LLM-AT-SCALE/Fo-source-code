"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/shared/components/ui/button";
import { describeRange, MAX_RANGE_DAYS, parseRange, RANGE_PRESETS, rangeToParams, type DateRange } from "@/modules/admin/lib/date-range";

const inputCls =
  "h-9 rounded-md border border-input bg-background px-2.5 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * URL-backed state for the analytics filters. `range` follows ?range / ?from&to
 * (and legacy ?days); `set` merges a patch into the current query with
 * router.replace so a reload keeps the selection. Pages must be wrapped in
 * <Suspense> because this reads useSearchParams.
 */
export function useAnalyticsParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const range = useMemo(() => parseRange(searchParams), [searchParams]);
  const get = useCallback((key: string) => searchParams.get(key) ?? "", [searchParams]);
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  const setRange = useCallback(
    (r: DateRange) => set({ range: null, from: null, to: null, days: null, ...rangeToParams(r) }),
    [set],
  );
  /** Query string carrying the range + any extra filters, for API calls. */
  const query = useCallback(
    (extra: Record<string, string | null | undefined> = {}) => {
      const p = new URLSearchParams(rangeToParams(range));
      for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
      return p.toString();
    },
    [range],
  );
  return { range, get, set, setRange, query };
}

const toDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Last 7 / 30 / 90 days presets plus "Custom" (two date inputs, to defaults to
 * today; from ≤ to; at most 365 days). Emits a DateRange.
 */
function DateRangeControl({ value, onChange, disabled = false, showLabel = false }: { value: DateRange; onChange: (r: DateRange) => void; disabled?: boolean; showLabel?: boolean }) {
  const [customOpen, setCustomOpen] = useState(value.preset === "custom");
  const [from, setFrom] = useState(toDay(value.from));
  const [to, setTo] = useState(toDay(value.to));
  const showCustom = customOpen || value.preset === "custom";

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  const valid = !Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime());
  const error = !valid
    ? "Pick both dates."
    : fromDate > toDate
      ? "The start date must be on or before the end date."
      : toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * 86_400_000
        ? `Ranges are limited to ${MAX_RANGE_DAYS} days.`
        : null;

  const applyCustom = () => {
    if (error) return;
    onChange(parseRange({ from, to }));
  };

  const pickPreset = (p: (typeof RANGE_PRESETS)[number]) => {
    setCustomOpen(false);
    onChange(parseRange({ range: p }));
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
      {/* Presets as one segmented control so they read as a single choice. */}
      <div className="inline-flex overflow-hidden rounded-md border border-input bg-background">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={value.preset === p}
            disabled={disabled}
            onClick={() => pickPreset(p)}
            className={`h-9 border-r border-input px-3 text-sm font-medium transition-colors last:border-r-0 disabled:opacity-50 ${
              value.preset === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {p}d
          </button>
        ))}
        <button
          type="button"
          aria-pressed={showCustom}
          disabled={disabled}
          onClick={() => {
            setCustomOpen(true);
            setFrom(toDay(value.from));
            setTo(toDay(value.preset === "custom" ? value.to : new Date()));
          }}
          className={`h-9 border-l border-input px-3 text-sm font-medium transition-colors disabled:opacity-50 ${
            value.preset === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          Custom
        </button>
      </div>
      {showCustom && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="range-from">From</label>
          <input id="range-from" type="date" className={inputCls} value={from} max={to} disabled={disabled} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-xs text-muted-foreground">to</span>
          <label className="sr-only" htmlFor="range-to">To</label>
          <input id="range-to" type="date" className={inputCls} value={to} min={from} disabled={disabled} onChange={(e) => setTo(e.target.value)} />
          <Button size="sm" onClick={applyCustom} disabled={disabled || !!error} className="bg-primary">Apply</Button>
          {error && <span className="text-xs text-destructive" role="alert">{error}</span>}
        </div>
      )}
      {showLabel && <span className="text-xs text-muted-foreground">{describeRange(value)}</span>}
    </div>
  );
}

/**
 * Full-width filter bar that sits UNDER the page title (never inside it, where
 * it wraps badly): the date range first, then any filter selects, then
 * `trailing` (range text, counts, export) pushed to the right edge.
 */
export function AnalyticsFilterBar({
  range,
  onRangeChange,
  children,
  trailing,
  label = "Filters",
}: {
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  children?: React.ReactNode;
  trailing?: React.ReactNode;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border bg-card px-3 py-2.5">
      <DateRangeControl value={range} onChange={onRangeChange} />
      {children && <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />}
      {children}
      {(trailing || true) && (
        <div className="ml-auto flex flex-wrap items-center gap-2 pl-2 text-sm text-muted-foreground">
          <span>{describeRange(range)}</span>
          {trailing}
        </div>
      )}
    </div>
  );
}
