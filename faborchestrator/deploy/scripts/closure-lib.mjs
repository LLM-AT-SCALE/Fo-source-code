/**
 * Import-closure helpers shared by module-closure.mjs and prune-for-image.mjs.
 *
 * Walks TypeScript/JavaScript imports (static, dynamic `import()`, `require()`,
 * re-exports and CSS imports) from a set of entry files and returns every
 * source file reachable from them. `@/` resolves to the app root, relative
 * specifiers resolve against the importing file; bare package names are
 * external and ignored. Pure Node, no dependencies, so it runs inside the
 * Docker builder stage before `next build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCE_EXT = ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.mts', '.json', '.css'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '__tests__', 'docs', 'lambda', '.po-ui-runs']);

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"\n]+)\1/gm;

export function loadManifest(file = path.join(APP_ROOT, 'deploy', 'modules.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every source file under a directory (or the file itself), app-relative. */
export function expandEntry(rel) {
  const abs = path.join(APP_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return [rel];
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = path.join(dir, name);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p);
      else if (SOURCE_EXT.includes(path.extname(name))) out.push(path.relative(APP_ROOT, p));
    }
  };
  walk(abs);
  return out;
}

function resolveSpec(spec, fromRel) {
  let base;
  if (spec.startsWith('@/')) base = path.join(APP_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(APP_ROOT, path.dirname(fromRel), spec);
  else return null; // bare package
  const candidates = [base, ...SOURCE_EXT.map((e) => base + e), ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((i) => path.join(base, i))];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(APP_ROOT, c);
  }
  return null;
}

/** Direct dependencies of one file (app-relative paths). */
export function importsOf(rel) {
  const abs = path.join(APP_ROOT, rel);
  if (!/\.(tsx?|mts|mjs|jsx?)$/.test(rel)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(SPEC_RE)) {
    const target = resolveSpec(m[2], rel);
    if (target) out.add(target);
  }
  return [...out];
}

/** Transitive closure of `entries` (app-relative files or directories). */
export function closureOf(entries) {
  const seen = new Set();
  const stack = entries.flatMap(expandEntry);
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/** The module a file belongs to: `modules/<name>`, `shared`, `app`, `lib/po-ui`, … */
export function moduleOf(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'modules') return `modules/${parts[1]}`;
  if (parts[0] === 'lib') return `lib/${parts[1]}`;
  return parts[0];
}

/** Entry files of one image: its owned routes, the common files and (for the scheduler image) instrumentation.ts. */
export function imageEntries(manifest, image) {
  const img = manifest.images[image];
  if (!img) throw new Error(`unknown image "${image}" (known: ${Object.keys(manifest.images).join(', ')})`);
  const entries = [...manifest.common.routes, ...img.routes];
  if (img.scheduler) entries.push('instrumentation.ts');
  return entries;
}
