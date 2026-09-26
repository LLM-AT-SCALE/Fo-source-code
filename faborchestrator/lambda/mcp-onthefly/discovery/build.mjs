// Build the discovery Lambda zip.  node build.mjs → ../discovery-v1.zip
// Bundles index.mjs + pg + mssql (excludes @aws-sdk — provided by the Lambda runtime).
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const outZip = join(here, "..", "discovery-v1.zip");

if (!existsSync(join(here, "node_modules", "adm-zip"))) {
  console.log("• installing build dep adm-zip");
  execSync("npm install --no-audit --no-fund", { cwd: here, stdio: "inherit" });
}
const { default: AdmZip } = await import("adm-zip");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

console.log("• staging dist/");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(here, "index.mjs"), join(dist, "index.mjs"));
writeFileSync(join(dist, "package.json"), JSON.stringify({ name: "mcp-otf-discovery", version: "0.1.0", type: "module", main: "index.mjs", dependencies: { pg: pkg.dependencies.pg, mssql: pkg.dependencies.mssql } }, null, 2));

console.log("• installing prod deps (pg + mssql)");
execSync("npm install --omit=dev --no-audit --no-fund --no-package-lock", { cwd: dist, stdio: "inherit" });

console.log("• zipping →", outZip);
rmSync(outZip, { force: true });
const zip = new AdmZip();
zip.addLocalFile(join(dist, "index.mjs"));
zip.addLocalFile(join(dist, "package.json"));
zip.addLocalFolder(join(dist, "node_modules"), "node_modules");
zip.writeZip(outZip);
console.log(`✔ built ${outZip} (${(statSync(outZip).size / 1024 / 1024).toFixed(2)} MB)`);
