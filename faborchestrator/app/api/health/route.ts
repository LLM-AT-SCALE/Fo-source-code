/**
 * Liveness probe for the load balancer.
 *
 * Deliberately does NO work — no DB, no CMF/MES call, no page render. It answers
 * in microseconds even while the instance is busy with a heavy export or a slow
 * VPN query, so the ALB keeps the instance IN SERVICE through transient load
 * spikes instead of pulling it out (which turned one busy instance into a 504
 * for every user — prod incidents 2026-08-10 and 2026-08-19).
 *
 * The ALB target-group HealthCheckPath points here (see .ebextensions/01-alb.config).
 * Because it never touches a shared resource, a stuck dependency can no longer
 * mark the whole instance unhealthy — only a genuinely dead Node process fails it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok", ts: new Date().toISOString() }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
