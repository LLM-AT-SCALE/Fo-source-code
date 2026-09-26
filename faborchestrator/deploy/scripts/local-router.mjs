#!/usr/bin/env node
/**
 * One-port front door for the local six-image stack. Plays the role the
 * ALB path rules (plus the /_fab/<image>/* asset rewrite) play in AWS.
 *
 *   ROUTER_PORT       port to listen on (default 8080)
 *   MODULES_JSON      path to deploy/modules.json (default ./modules.json)
 *   TARGET_TEMPLATE   upstream URL per image, `{image}` substituted
 *                     (default http://{image}:3000 — the compose service names)
 *   TARGET_<IMAGE>    override for one image, e.g. TARGET_CODING_AGENT=http://host:3004
 *
 * Routing, first match wins:
 *   /_fab/<image>/<rest>   -> that image, with the prefix stripped (its _next assets)
 *   longest `paths` prefix -> the image that owns it (segment-aligned; "/" is exact)
 *   anything else          -> the default image (public/ files, favicon, unknown URLs)
 *
 * Streams request and response bodies untouched, so SSE chat responses and
 * multi-megabyte uploads pass through; no buffering, no size limit here.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = process.env.MODULES_JSON || path.join(here, 'modules.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const port = Number(process.env.ROUTER_PORT || 8080);
const template = process.env.TARGET_TEMPLATE || 'http://{image}:3000';

const images = Object.entries(manifest.images).filter(([, v]) => v.paths && v.paths.length);
const defaultImage = (Object.entries(manifest.images).find(([, v]) => v.default) || images[0])[0];

// Longest prefix first so "/api/admin" beats "/api" style overlaps.
const rules = images
  .flatMap(([name, v]) => v.paths.map((p) => ({ prefix: p.replace(/\/$/, '') || '/', image: name })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

function targetFor(image) {
  const override = process.env[`TARGET_${image.toUpperCase().replace(/-/g, '_')}`];
  const url = new URL(override || template.replace('{image}', image));
  const imgPort = manifest.images[image]?.port;
  if (!override && imgPort) url.port = String(imgPort);
  return url;
}

function route(pathname) {
  const m = pathname.match(/^\/_fab\/([a-z0-9-]+)(\/.*)?$/);
  if (m && manifest.images[m[1]]) return { image: m[1], pathname: m[2] || '/' };
  for (const r of rules) {
    if (r.prefix === '/' ? pathname === '/' : pathname === r.prefix || pathname.startsWith(r.prefix + '/')) {
      return { image: r.image, pathname };
    }
  }
  return { image: defaultImage, pathname };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://router');
  if (url.pathname === '/_router/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', images: Object.keys(manifest.images) }));
    return;
  }
  const { image, pathname } = route(url.pathname);
  const target = targetFor(image);
  const headers = { ...req.headers, host: target.host, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': 'http', 'x-fab-image': image };
  const upstream = http.request(
    { hostname: target.hostname, port: target.port || 80, method: req.method, path: pathname + url.search, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream ${image} unavailable`, detail: err.message }));
  });
  req.pipe(upstream);
});

server.keepAliveTimeout = 620_000; // above the 600 s SSE/long-request ceiling the ALB used
server.headersTimeout = 625_000;
server.listen(port, () => {
  console.log(`[router] listening on :${port}; default -> ${defaultImage}`);
  for (const r of rules) console.log(`[router]   ${r.prefix.padEnd(24)} -> ${r.image}`);
});
