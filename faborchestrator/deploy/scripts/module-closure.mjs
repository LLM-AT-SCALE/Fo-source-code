#!/usr/bin/env node
/**
 * Report what each image contains and which images a change affects.
 *
 *   node deploy/scripts/module-closure.mjs                 # per-image summary + cross-module edges
 *   node deploy/scripts/module-closure.mjs chat            # files of one image
 *   node deploy/scripts/module-closure.mjs --affected modules/mcp/lib/mcp-client.ts shared/lib/db.ts
 *   node deploy/scripts/module-closure.mjs --json          # machine-readable summary
 *
 * The closure follows imports from the image's routes (see deploy/modules.json),
 * so a file is "in" an image when some route of that image reaches it. Files
 * read from disk at runtime (templates/, po-ui-assets/) are declared as
 * `assets` in the manifest, not discovered here.
 */
import { closureOf, imageEntries, importsOf, loadManifest, moduleOf } from './closure-lib.mjs';

const args = process.argv.slice(2);
const manifest = loadManifest();
const images = Object.keys(manifest.images);

const closures = Object.fromEntries(images.map((img) => [img, closureOf(imageEntries(manifest, img))]));

if (args[0] === '--affected') {
  const files = args.slice(1);
  if (!files.length) {
    console.error('usage: module-closure.mjs --affected <app-relative file> [...]');
    process.exit(2);
  }
  const hit = new Set();
  for (const f of files) {
    const owners = images.filter((img) => closures[img].has(f));
    // A change in deploy/ or the root config rebuilds everything.
    const all = /^(deploy\/|package(-lock)?\.json$|next\.config\.ts$|tsconfig\.json$|prisma\/schema\.prisma$)/.test(f);
    const list = all ? images : owners;
    list.forEach((i) => hit.add(i));
    console.log(`${f}: ${list.length ? list.join(', ') : '(no image — not reachable from any route)'}`);
  }
  console.log(`\nrebuild: ${[...hit].join(' ') || '(nothing)'}`);
  process.exit(0);
}

if (args[0] && !args[0].startsWith('--')) {
  const img = args[0];
  if (!closures[img]) {
    console.error(`unknown image "${img}"`);
    process.exit(2);
  }
  for (const f of [...closures[img]].sort()) console.log(f);
  process.exit(0);
}

const summary = {};
for (const img of images) {
  const byModule = {};
  for (const f of closures[img]) byModule[moduleOf(f)] = (byModule[moduleOf(f)] || 0) + 1;
  summary[img] = { files: closures[img].size, modules: byModule };
}

// Cross-module edges: a file in modules/<a> importing modules/<b>.
const edges = new Map();
for (const img of images) {
  for (const f of closures[img]) {
    const from = moduleOf(f);
    if (!from.startsWith('modules/')) continue;
    for (const dep of importsOf(f)) {
      const to = moduleOf(dep);
      if (to.startsWith('modules/') && to !== from) {
        const key = `${from} -> ${to}`;
        if (!edges.has(key)) edges.set(key, new Set());
        edges.get(key).add(`${f} -> ${dep}`);
      }
    }
  }
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ images: summary, crossModuleEdges: Object.fromEntries([...edges].map(([k, v]) => [k, [...v]])) }, null, 2));
  process.exit(0);
}

for (const img of images) {
  const s = summary[img];
  const mods = Object.entries(s.modules).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}:${n}`).join('  ');
  console.log(`${img.padEnd(18)} ${String(s.files).padStart(4)} files   ${mods}`);
}
console.log('\ncross-module edges (module -> module: files):');
for (const [k, v] of [...edges].sort()) console.log(`  ${k}: ${v.size}`);
