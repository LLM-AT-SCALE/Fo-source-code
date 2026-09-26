"use client";

/**
 * usePolling — repeatedly call an async fetcher until `until(value)` returns
 * true, the component unmounts, or `enabled` flips false.
 *
 * @example
 *   const { data, error, attempts, stopped } = usePolling({
 *     enabled: !!pkgId,
 *     intervalMs: 2000,
 *     fetcher: () => fetch(`/api/cmf/packages/${pkgId}`).then(r => r.json()),
 *     until: (pkg) => pkg.LastExecutionEndDate != null,
 *   });
 *
 * Notes:
 *   - The first call happens immediately (no initial delay).
 *   - In-flight requests are tracked via an instance counter so a stale
 *     resolution can't overwrite a newer one.
 *   - Errors do NOT stop polling — they are surfaced via `error` while the
 *     loop continues.
 */

import { useEffect, useRef, useState } from "react";

export type UsePollingOptions<T> = {
  fetcher: () => Promise<T>;
  /** Stop polling when this returns true for the latest value. */
  until: (value: T) => boolean;
  intervalMs: number;
  enabled?: boolean;
};

export type UsePollingState<T> = {
  data: T | null;
  error: Error | null;
  attempts: number;
  stopped: boolean;
};

export function usePolling<T>({
  fetcher,
  until,
  intervalMs,
  enabled = true,
}: UsePollingOptions<T>): UsePollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [stopped, setStopped] = useState(false);

  // Refs so the polling loop sees the latest callbacks/values without
  // restarting the timer on every render.
  const fetcherRef = useRef(fetcher);
  const untilRef = useRef(until);
  useEffect(() => {
    fetcherRef.current = fetcher;
    untilRef.current = until;
  }, [fetcher, until]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      setAttempts((a) => a + 1);
      try {
        const value = await fetcherRef.current();
        if (cancelled) return;
        setData(value);
        setError(null);
        if (untilRef.current(value)) {
          setStopped(true);
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      }
      if (!cancelled) {
        timeout = setTimeout(tick, intervalMs);
      }
    };

    setStopped(false);
    void tick();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [enabled, intervalMs]);

  return { data, error, attempts, stopped };
}
