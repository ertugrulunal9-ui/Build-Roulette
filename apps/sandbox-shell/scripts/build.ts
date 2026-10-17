/**
 * Static build of the shell for Cloudflare Workers with static assets (T-043; `wrangler.jsonc`
 * next to this package's package.json reads it):
 *   dist/v{N}/index.html, dist/v{N}/shell.js, dist/v{N}/capture.js, dist/v{N}/sw.js,
 *   dist/v{N}/reset, dist/404.html, dist/_headers       the static assets
 *   dist/worker.js                                     the Worker (the capture gate)
 *   dist/.assetsignore                                 keeps worker.js out of the assets
 *
 * `_headers` puts the security headers on `/*` (every path, 404s included), gives
 * `/v{N}/sw.js` (the site worker, docs/09 §9.3) `Service-Worker-Allowed: /` and `no-store`,
 * and `/v{N}/reset` its `Clear-Site-Data` + `no-store` headers (see src/headers.ts and the
 * README of @br/runtime, "Reset isolation"). `404.html` is what an unknown path gets (with a
 * 404 status and the `/*` headers): with it, an unknown path is answered by the assets and
 * never invokes the Worker (`not_found_handling: "404-page"`).
 *
 * `worker.js`: the capture gate answers `/v{N}/capture` only after checking the HMAC
 * (src/capture-gate.ts); the config's `run_worker_first` routes only that path to it. The
 * secret is the Worker secret `CAPTURE_HMAC_SECRET`; it is not part of the build.
 *
 * The build owns `dist/`: it is emptied first, so nothing of an older layout (Cloudflare
 * Pages' `_worker.js` and `_routes.json`, before T-043; `/v1/`) is ever uploaded.
 *
 * Env:
 *   BR_APP_ORIGINS  comma-separated app origins (frame-ancestors + postMessage targets)
 * (Since protocol v2 there is no package CDN: BR_PKG_CDN_URL and BR_CDN_ORIGIN are ignored.)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  ASSETS_IGNORE,
  NOT_FOUND_HTML,
  SHELL_BASE_PATH,
  WORKER_FILE,
  buildShell,
  buildWorker,
} from '../src/build-shell';
import {
  RESET_ENDPOINT,
  captureHeaders,
  renderHeadersFile,
  staticHeaderRules,
} from '../src/headers';
import { SITE_WORKER_FILE } from '../src/site-protocol';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appOrigins = (process.env['BR_APP_ORIGINS'] ?? 'https://buildroulette.app')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const built = await buildShell({ appOrigins, minify: true });
const dist = path.join(ROOT, 'dist');
rmSync(dist, { recursive: true, force: true });
const outDir = path.join(dist, SHELL_BASE_PATH);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'index.html'), built.html);
writeFileSync(path.join(outDir, 'shell.js'), built.js);
writeFileSync(path.join(outDir, 'capture.js'), built.captureJs);
writeFileSync(path.join(outDir, SITE_WORKER_FILE), built.swJs);
// The body is irrelevant; the headers from `_headers` do the work.
writeFileSync(path.join(outDir, RESET_ENDPOINT), 'ok\n');
writeFileSync(path.join(dist, '404.html'), NOT_FOUND_HTML);
writeFileSync(
  path.join(dist, '_headers'),
  renderHeadersFile(staticHeaderRules({ appOrigins }, SHELL_BASE_PATH)),
);
const worker = await buildWorker(captureHeaders({ appOrigins }));
writeFileSync(path.join(dist, WORKER_FILE), worker);
writeFileSync(path.join(dist, '.assetsignore'), ASSETS_IGNORE);

const size = (js: string) =>
  `${String(Buffer.byteLength(js))} B (${String(gzipSync(js, { level: 9 }).byteLength)} B gzip)`;
console.log(`sandbox-shell: dist${SHELL_BASE_PATH}shell.js ${size(built.js)}`);
console.log(`sandbox-shell: dist${SHELL_BASE_PATH}capture.js ${size(built.captureJs)}`);
console.log(`sandbox-shell: dist${SHELL_BASE_PATH}${SITE_WORKER_FILE} ${size(built.swJs)}`);
console.log(`sandbox-shell: dist/${WORKER_FILE} (the capture gate) ${size(worker)}`);
console.log(`sandbox-shell: app origins ${appOrigins.join(', ')}`);
