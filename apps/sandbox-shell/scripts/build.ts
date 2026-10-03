/**
 * Static build of the shell for a static host (Cloudflare Pages layout):
 *   dist/v{N}/index.html, dist/v{N}/shell.js, dist/_headers
 *
 * Env (placeholders until the production domains exist, see docs/BOARD.md):
 *   BR_APP_ORIGINS  comma-separated app origins (frame-ancestors + postMessage targets)
 *   BR_CDN_ORIGIN   package CDN origin
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildShell, SHELL_BASE_PATH } from '../src/build-shell';
import { renderHeadersFile, shellHeaders } from '../src/headers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appOrigins = (process.env['BR_APP_ORIGINS'] ?? 'https://buildroulette.app')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const cdnOrigin = process.env['BR_CDN_ORIGIN'] ?? 'https://pkg.buildroulette-cdn.net';

const built = await buildShell({ appOrigins, minify: true });
const outDir = path.join(ROOT, 'dist', SHELL_BASE_PATH);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'index.html'), built.html);
writeFileSync(path.join(outDir, 'shell.js'), built.js);
writeFileSync(
  path.join(ROOT, 'dist', '_headers'),
  renderHeadersFile(`${SHELL_BASE_PATH}*`, shellHeaders({ appOrigins, cdnOrigin })),
);

const raw = Buffer.byteLength(built.js);
const gz = gzipSync(built.js, { level: 9 }).byteLength;
console.log(
  `sandbox-shell: dist${SHELL_BASE_PATH}shell.js ${String(raw)} B (${String(gz)} B gzip)`,
);
console.log(`sandbox-shell: app origins ${appOrigins.join(', ')}; cdn ${cdnOrigin}`);
