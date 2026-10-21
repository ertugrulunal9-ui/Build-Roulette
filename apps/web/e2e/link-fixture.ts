/**
 * A published site for the link import's e2e (docs/10, T-052): a static server on this machine
 * that the `import-url` Edge Function copies from. The function runs in Docker and reaches it as
 * `http://host.docker.internal:4330`, which the public host allowlist refuses; the solo suite
 * allows exactly that origin, on both sides and for tests only:
 *
 * - the function: `IMPORT_URL_TEST_HOSTS=host.docker.internal:4330` (playwright.solo.config.ts
 *   → scripts/solo-services.ts → `supabase functions serve --env-file`), honored on a local
 *   stack only;
 * - the page's own check: `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS=http://host.docker.internal:4330`
 *   in the `test:e2e:solo` build (package.json), refused by scripts/pages-config.ts for a
 *   non-local Supabase.
 *
 * `serve(files)` publishes a site at `/` (a test at a time: the solo suite runs serially).
 * Fixed paths: `/private/` (401, a password page → "That site is private"), `/gone/` (404 →
 * "That site couldn't be loaded"), `/slow/` (answers after `SLOW_MS`: the copying state and
 * Cancel).
 */
import { createServer, type Server } from 'node:http';
import { extname } from 'node:path';
import type { SiteFiles } from './sites';

export const LINK_FIXTURE_PORT = 4330;
/** `IMPORT_URL_TEST_HOSTS` for the function. */
export const LINK_FIXTURE_HOST = `host.docker.internal:${String(LINK_FIXTURE_PORT)}`;
/** The fixture as the function (and the page's link field) sees it. */
export const LINK_FIXTURE_ORIGIN = `http://${LINK_FIXTURE_HOST}`;
export const SLOW_MS = 6_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface LinkFixture {
  /** Publishes `files` at `/` (replacing the last site). */
  serve(files: SiteFiles): void;
  /** Paths requested so far (to check what the function fetched). */
  hits: string[];
  close(): Promise<void>;
}

export async function startLinkFixture(): Promise<LinkFixture> {
  let site: SiteFiles = {};
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    hits.push(path);
    if (path.startsWith('/private/')) {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Password required</title><form>password</form>');
      return;
    }
    if (path.startsWith('/slow/')) {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': TYPES['.html'] ?? '' });
        res.end('<!doctype html><title>Slow</title><h1 class="e2e-title">Slow site</h1>');
      }, SLOW_MS);
      res.on('close', () => {
        clearTimeout(timer);
      });
      return;
    }
    const file = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
    const body = path.startsWith('/gone/') ? undefined : site[file];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  // 0.0.0.0: the Edge Runtime container reaches it through the Docker host gateway.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(LINK_FIXTURE_PORT, '0.0.0.0', resolve);
  });
  return {
    serve(files) {
      site = files;
    },
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
