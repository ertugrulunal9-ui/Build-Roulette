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
 * Env (placeholders until the production domains exist, see docs/BOARD.md):
 *   BR_APP_ORIGINS  comma-separated app origins (frame-ancestors + postMessage targets)
 *   BR_CDN_ORIGIN   package CDN origin
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildPagesWorker, buildShell, SHELL_BASE_PATH } from '../src/build-shell';
import { CAPTURE_PATH } from '../src/capture-gate';
import {
  RESET_ENDPOINT,
  captureHeaders,
  renderHeadersFile,
  staticHeaderRules,
} from '../src/headers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appOrigins = (process.env['BR_APP_ORIGINS'] ?? 'https://buildroulette.app')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const cdnOrigin = process.env['BR_CDN_ORIGIN'] ?? 'https://pkg.buildroulette-cdn.net';

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
