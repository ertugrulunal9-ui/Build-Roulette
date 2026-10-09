/**
 * Static build of the shell for a static host (Cloudflare Pages layout):
 *   dist/v{N}/index.html, dist/v{N}/shell.js, dist/v{N}/capture.js, dist/v{N}/reset,
 *   dist/_headers, dist/_worker.js, dist/_routes.json
 *
 * `_headers` puts the security headers on `/*` (every path, 404s included) and gives
 * `/v{N}/reset` its `Clear-Site-Data` + `no-store` headers (see src/headers.ts and the
 * README of @br/runtime, "Reset isolation").
 *
 * `_worker.js` + `_routes.json` (Pages advanced mode): the capture gate answers
 * `/v{N}/capture` only after checking the HMAC (src/capture-gate.ts). The secret is the
 * Pages secret `CAPTURE_HMAC_SECRET`; it is not part of the build.
 *
 * Env:
 *   BR_APP_ORIGINS  comma-separated app origins (frame-ancestors + postMessage targets)
 *   BR_PKG_CDN_URL  the package CDN's base URL, the same value as the web app's
 *                   NEXT_PUBLIC_PKG_CDN_URL and the capture worker's PKG_CDN_URL; its origin
 *                   goes into `script-src`. Default: https://esm.sh (the free plan, T-035).
 *                   BR_CDN_ORIGIN (the older name, an origin) is still read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildPagesWorker, buildShell, SHELL_BASE_PATH } from '../src/build-shell';
import { CAPTURE_PATH } from '../src/capture-gate';
import {
  PUBLIC_ESM_SH_URL,
  RESET_ENDPOINT,
  captureHeaders,
  cdnOriginOf,
  renderHeadersFile,
  staticHeaderRules,
} from '../src/headers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appOrigins = (process.env['BR_APP_ORIGINS'] ?? 'https://buildroulette.app')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const setting = (name: string) => process.env[name]?.trim() || undefined;
const cdnOrigin = cdnOriginOf(
  setting('BR_PKG_CDN_URL') ?? setting('BR_CDN_ORIGIN') ?? PUBLIC_ESM_SH_URL,
);

const built = await buildShell({ appOrigins, minify: true });
const dist = path.join(ROOT, 'dist');
const outDir = path.join(dist, SHELL_BASE_PATH);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'index.html'), built.html);
writeFileSync(path.join(outDir, 'shell.js'), built.js);
writeFileSync(path.join(outDir, 'capture.js'), built.captureJs);
// The body is irrelevant; the headers from `_headers` do the work.
writeFileSync(path.join(outDir, RESET_ENDPOINT), 'ok\n');
writeFileSync(
  path.join(dist, '_headers'),
  renderHeadersFile(staticHeaderRules({ appOrigins, cdnOrigin }, SHELL_BASE_PATH)),
);
writeFileSync(
  path.join(dist, '_worker.js'),
  await buildPagesWorker(captureHeaders({ appOrigins, cdnOrigin })),
);
writeFileSync(
  path.join(dist, '_routes.json'),
  `${JSON.stringify({ version: 1, include: [CAPTURE_PATH], exclude: [] }, null, 2)}\n`,
);

const size = (js: string) =>
  `${String(Buffer.byteLength(js))} B (${String(gzipSync(js, { level: 9 }).byteLength)} B gzip)`;
console.log(`sandbox-shell: dist${SHELL_BASE_PATH}shell.js ${size(built.js)}`);
console.log(`sandbox-shell: dist${SHELL_BASE_PATH}capture.js ${size(built.captureJs)}`);
console.log(`sandbox-shell: app origins ${appOrigins.join(', ')}; cdn ${cdnOrigin}`);
