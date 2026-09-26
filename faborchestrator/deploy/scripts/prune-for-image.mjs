#!/usr/bin/env node
/**
 * Trim a BUILD COPY of the app down to one image before `next build`.
 *
 *   node deploy/scripts/prune-for-image.mjs <image> [--dry]
 *
 * Runs inside the Docker builder stage (never against a working tree — it
 * deletes files). What it does, in order:
 *   1. app/: keeps the common files and the image's own routes, removes every
 *      other page and API folder, so the build compiles only this image's
 *      routes and the container cannot serve another module's URLs.
 *   2. instrumentation.ts: replaced by a no-op unless the image is the
 *      scheduler, so web images never import the worker code.
 *   3. Asset folders (templates/, po-ui-assets/): kept when declared for the
 *      image, otherwise emptied (the folder stays so the Dockerfile's COPY works).
 *
 * Source under modules/, shared/ and lib/ is left in place on purpose: the
 * runner ships only the bundle `next build` traces from the remaining routes,
 * and the build's type check covers every file in the tree, so removing a
 * module that some shared file still imports would fail the build even though
 * no route of the image bundles it. `module-closure.mjs` reports what each
 * image actually contains.
 *
 * `--dry` prints the plan without touching anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, closureOf, imageEntries, loadManifest } from './closure-lib.mjs';

const [image, ...flags] = process.argv.slice(2);
const dry = flags.includes('--dry');
if (!image) {
  console.error('usage: prune-for-image.mjs <image> [--dry]');
  process.exit(2);
}
const manifest = loadManifest();
const img = manifest.images[image];
if (!img) {
  console.error(`unknown image "${image}" (known: ${Object.keys(manifest.images).join(', ')})`);
  process.exit(2);
}

const keep = new Set([...manifest.common.routes, ...img.routes].map((r) => r.replace(/\/$/, '')));
const closure = closureOf(imageEntries(manifest, image));
const removed = [];
const emptied = [];

const rm = (rel) => {
  removed.push(rel);
  if (!dry) fs.rmSync(path.join(APP_ROOT, rel), { recursive: true, force: true });
};

// 1. app/ routes
const walkApp = (dirRel) => {
  for (const name of fs.readdirSync(path.join(APP_ROOT, dirRel))) {
    const rel = `${dirRel}/${name}`;
    if (keep.has(rel)) continue;
    if (rel === 'app/api') {
      walkApp(rel); // decide per API folder
      continue;
    }
    rm(rel);
  }
};
walkApp('app');

// 2. instrumentation.ts
if (!img.scheduler) {
  removed.push('instrumentation.ts (replaced by a no-op)');
  if (!dry) {
    fs.writeFileSync(
      path.join(APP_ROOT, 'instrumentation.ts'),
      '// Web image: background workers run only in the fabinsight image.\nexport async function register() {}\n'
    );
  }
}

// 3. asset folders
const allAssets = new Set(Object.values(manifest.images).flatMap((i) => i.assets));
for (const dir of allAssets) {
  if (img.assets.includes(dir)) continue;
  const abs = path.join(APP_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  emptied.push(dir);
  if (!dry) {
    fs.rmSync(abs, { recursive: true, force: true });
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, '.keep'), '');
  }
}

console.log(`[prune-for-image] ${image}: ${closure.size} source files reachable from ${keep.size} route entries`);
console.log(`  removed (${removed.length}): ${removed.join(', ')}`);
if (emptied.length) console.log(`  emptied asset dirs: ${emptied.join(', ')}`);
if (dry) console.log('  (dry run — nothing changed)');
