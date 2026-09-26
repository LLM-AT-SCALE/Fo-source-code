/**
 * Deployment-skew guard for the per-module images.
 *
 * Every image is its own Next.js build with its own deploymentId
 * (`<image>.<stamp>`, see next.config.ts). The Next.js client sends that id in
 * `x-deployment-id` with every RSC fetch (navigation, prefetch) and server
 * action call — plain page loads and API calls never carry it. When a page
 * served by one image fetches a route owned by another image, this server
 * cannot answer with a flight payload the caller's runtime could decode, so it
 * answers with an empty HTML response instead. The client treats a non-flight
 * response as a full-page navigation, which is exactly what a cross-image link
 * should be. (Next strips its own `RSC` header before the proxy runs, so the
 * deployment id is the signal to key on.) A single-image build has no
 * FAB_IMAGE and the guard is a no-op.
 */
import { NextResponse, type NextRequest } from "next/server";

// Inlined at build time (next.config.ts `env`), never read from the runtime environment.
const OWN_IMAGE = process.env.FAB_IMAGE_BUILD ?? "";

export function proxy(req: NextRequest) {
  if (OWN_IMAGE) {
    const dpl = req.headers.get("x-deployment-id");
    if (dpl && !dpl.startsWith(`${OWN_IMAGE}.`)) {
      return new NextResponse(null, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-fab-skew": `served-by=${OWN_IMAGE}`,
        },
      });
    }
  }
  return NextResponse.next();
}

export const config = {
  // Only page routes can be RSC-fetched; skip assets and APIs entirely.
  matcher: ["/((?!_next/|_fab/|api/|favicon.ico|.*\\.[a-z0-9]+$).*)"],
};
