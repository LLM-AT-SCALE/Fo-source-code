// Build the deployable runtime base zip for the on-the-fly MCP feature.
//
//   node build.mjs   →   ../runtime-base-v1.zip
//
// The zip contains the FIXED runtime (index.mjs + guard.mjs) plus `pg`. It does
// NOT bundle @aws-sdk/* — the Lambda Node 20 runtime already provides the AWS SDK.
// The deploy step (modules/admin/lib/mcp/mcp-onthefly/deploy.ts) downloads this base
// zip and injects the per-source manifest.json before CreateFunction.
//
// Publish it once (ask-first) to:
//   s3://mcp-otf-artifacts-628203515088/runtime-base/v1.zip
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const outZip = join(here, "..", "runtime-base-v1.zip");

// Build dep: adm-zip (forward-slash entries — Lambda-safe, unlike PowerShell 5.1
// Compress-Archive which writes backslashes that break require() on Linux).
if (!existsSync(join(here, "node_modules", "adm-zip"))) {
  console.log("• installing build dep adm-zip");
  execSync("npm install --no-audit --no-fund", { cwd: here, stdio: "inherit" });
}
const { default: AdmZip } = await import("adm-zip");

// pg version from the runtime package.json (single source of truth).
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const pgVersion = pkg.dependencies?.pg || "^8.13.0";

console.log("• staging dist/");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(here, "index.mjs"), join(dist, "index.mjs"));
copyFileSync(join(here, "guard.mjs"), join(dist, "guard.mjs"));
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify({ name: "mcp-otf-runtime", version: "0.1.0", type: "module", main: "index.mjs", dependencies: { pg: pgVersion } }, null, 2),
);

console.log("• installing prod deps (pg only; @aws-sdk comes from the Lambda runtime)");
execSync("npm install --omit=dev --no-audit --no-fund --no-package-lock", { cwd: dist, stdio: "inherit" });

console.log("• zipping →", outZip);
rmSync(outZip, { force: true });
// adm-zip writes forward-slash entries with files at the ROOT (Handler = index.handler).
const zip = new AdmZip();
zip.addLocalFile(join(dist, "index.mjs"));
zip.addLocalFile(join(dist, "guard.mjs"));
zip.addLocalFile(join(dist, "package.json"));
zip.addLocalFolder(join(dist, "node_modules"), "node_modules");
zip.writeZip(outZip);

const mb = (statSync(outZip).size / 1024 / 1024).toFixed(2);
console.log(`✔ built ${outZip} (${mb} MB)`);
