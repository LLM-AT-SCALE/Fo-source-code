import type { NextConfig } from "next";
import path from "node:path";

// Per-module images share one origin: each build serves its static assets under
// /_fab/<image>/ (deploy/modules.json) so six builds never collide on /_next/.
// Set FAB_IMAGE (the Dockerfile does) or FAB_ASSET_PREFIX explicitly; a plain
// `next dev` / `next build` keeps the default /_next/ prefix.
const assetPrefix = process.env.FAB_ASSET_PREFIX ?? (process.env.FAB_IMAGE ? `/_fab/${process.env.FAB_IMAGE}` : undefined);
// Each image is its own deployment. The client sends this id with every RSC
// fetch; a server built for another image answers with HTML instead of a flight
// payload (see proxy.ts), so a link that crosses images becomes a plain full-page
// navigation instead of the router trying (and failing) to decode a foreign bundle.
const deploymentId = process.env.FAB_IMAGE ? `${process.env.FAB_IMAGE}.${process.env.FAB_BUILD_STAMP ?? Date.now().toString(36)}` : undefined;

const nextConfig: NextConfig = {
  output: "standalone",
  ...(assetPrefix ? { assetPrefix } : {}),
  ...(deploymentId ? { deploymentId } : {}),
  // Baked into the bundles at build time so proxy.ts (edge runtime) knows which
  // image it is without depending on the container's environment.
  env: { FAB_IMAGE_BUILD: process.env.FAB_IMAGE ?? "" },
  // This app deploys as its own standalone zip (single lockfile). Pin the
  // tracing/workspace root to this dir so local monorepo checkouts don't infer
  // the parent folder as root (harmless warning) and match production layout.
  outputFileTracingRoot: path.join(__dirname),
  // Native / connection-pool packages must stay external to the server bundle.
  serverExternalPackages: ["pg", "pg-native", "pg-connection-string", "@prisma/adapter-pg"],
};

export default nextConfig;
