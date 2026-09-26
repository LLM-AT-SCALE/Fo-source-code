"use client";

import { cmfFetch } from "@/modules/master-data-load/lib/cmf/client-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolling } from "@/shared/hooks/use-polling";
import type {
  ExecutionLogEntry,
  ExecutionResult,
  MasterDataPackage,
  UserFriendlyObjectType,
} from "@/modules/master-data-load/lib/cmf/types";

export type DetailResponse = {
  instance: MasterDataPackage;
  objectTypes: UserFriendlyObjectType[];
};

/** The route's real reason plus the error-log id, when the failure was recorded. */
const describe = (data: { error?: { description?: string; errorId?: string } } | undefined, status: number) => {
  const d = data?.error?.description ?? `Request failed (HTTP ${status}).`;
  return data?.error?.errorId ? `${d} (error id ${data.error.errorId})` : d;
};

const endStamp = (v?: string | null): string | null =>
  v == null || v === "" ? null : v;

function parseLog(blob?: string): ExecutionLogEntry[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (Array.isArray(parsed)) return parsed as ExecutionLogEntry[];
    if (Array.isArray(parsed?.Entries)) return parsed.Entries as ExecutionLogEntry[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Owns the package instance + the queue-then-poll execution lifecycle for a
 * single CMF package. `start(kind, selected)` POSTs to the validate/load
 * route, then polls GET /api/cmf/packages/[id] until a *new* completion
 * appears (end-date differs from the baseline captured at submit) — the same
 * server-relative, clock-skew-safe signal used elsewhere.
 */
export function useExecutionRun(packageId: string | null) {
  const [pkg, setPkg] = useState<MasterDataPackage | null>(null);
  const [runningOp, setRunningOp] = useState<null | "validate" | "load">(null);
  const [error, setError] = useState<string | null>(null);
  /** True from the instant a run is submitted until the 202 returns — stops double-submit. */
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const baselineRef = useRef<string | null>(null);

  const fetchDetail = useCallback(async (): Promise<DetailResponse> => {
    if (!packageId) throw new Error("No package id");
    const res = await cmfFetch(`/api/cmf/packages/${encodeURIComponent(packageId)}`, {
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as Partial<DetailResponse> & {
      error?: { description?: string; errorId?: string };
    };
    if (!res.ok) throw new Error(describe(data, res.status));
    return {
      instance: data.instance as MasterDataPackage,
      objectTypes: (data.objectTypes ?? []) as UserFriendlyObjectType[],
    };
  }, [packageId]);

  const { data: polled, attempts } = usePolling<DetailResponse>({
    enabled: !!packageId && runningOp != null,
    intervalMs: 1500,
    fetcher: fetchDetail,
    until: (r) =>
      endStamp(r.instance.LastExecutionEndDate) != null &&
      endStamp(r.instance.LastExecutionEndDate) !== baselineRef.current,
  });

  useEffect(() => {
    if (polled?.instance) setPkg(polled.instance);
  }, [polled]);

  useEffect(() => {
    if (!runningOp || !pkg) return;
    const end = endStamp(pkg.LastExecutionEndDate);
    if (end != null && end !== baselineRef.current) {
      setRunningOp(null);
      baselineRef.current = end;
    }
  }, [pkg, runningOp]);

  const start = useCallback(
    async (kind: "validate" | "load", selected: UserFriendlyObjectType[]) => {
      // Re-entry guard: ignore extra clicks while a submit is in flight or a
      // run is already active. Synchronous ref check beats React state latency.
      if (!packageId || submittingRef.current || runningOp != null) return;
      submittingRef.current = true;
      setSubmitting(true);
      baselineRef.current = endStamp(pkg?.LastExecutionEndDate);
      setError(null);
      try {
        const res = await cmfFetch(
          `/api/cmf/packages/${encodeURIComponent(packageId)}/${kind}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ selectedTypes: selected }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          error?: { description?: string; errorId?: string };
        };
        if (!res.ok) {
          setError(describe(data, res.status));
          return;
        }
        setRunningOp(kind);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [packageId, pkg, runningOp],
  );

  const log = useMemo(() => parseLog(pkg?.LastExecutionLog), [pkg]);
  const result = pkg?.LastExecutionResult as ExecutionResult | undefined;

  return { pkg, setPkg, runningOp, submitting, attempts, log, result, error, start, fetchDetail };
}
