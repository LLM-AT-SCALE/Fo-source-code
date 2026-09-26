"use client";

import { useEffect, useState } from "react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

const POLL_MS = 30_000;

/**
 * Number of dashboard requests awaiting an admin action, polled every 30 s for
 * the sidebar badge. Returns 0 until the first response (and when logged out).
 */
export function usePendingDashboardRequests(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
      if (!token) return;
      try {
        const res = await fetch("/api/admin/dashboard-requests?count=1", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const j = (await res.json()) as { pendingCount?: number };
        if (!cancelled) setCount(typeof j.pendingCount === "number" ? j.pendingCount : 0);
      } catch {
        /* keep the last value */
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return count;
}
