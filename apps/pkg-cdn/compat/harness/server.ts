/**
 * Three origins for the compatibility suite, like `@br/runtime`'s dev server but with the
 * real package CDN instead of the mock:
 *
 *   app (harness page + bundler worker + esbuild.wasm)  http://localhost:<port>
 *   sandbox shell (/v1/)                                http://127.0.0.1:<port>  (different site)
 *   package CDN (@br/pkg-cdn, npm registry)             http://localhost:<port>
 *     or an external one (`--cdn https://esm.sh`, T-035): not started, the shell's CSP allows
 *     its origin and the runtime uses its base URL, as a production build would.
 *
 * The page and worker are built from `@br/runtime`'s public exports (`.` and `./worker`), so
 * nothing in packages/runtime is imported by relative path.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { cdnOriginOf } from '@br/sandbox-shell/headers';
import { startShellServer } from '@br/sandbox-shell/server';
import type { CdnConfig } from '../../src/config';
import { startCdnServer, type CdnServer } from '../../src/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Harness {
  appUrl: string;
  shellUrl: string;
  /** The CDN base URL the runtime uses. */
  cdnUrl: string;
  /** Our own CDN when the harness started it; null for an external CDN. */
  cdn: CdnServer | null;
  close(): Promise<void>;
}

/** Our own CDN (started with this configuration) or an external CDN's base URL. */
export type HarnessCdn = { config: CdnConfig } | { externalUrl: string };

async function bundleForBrowser(
  entry: string,
  define: Record<string, string> = {},
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'silent',
    define,
  });
  const out = result.outputFiles[0]?.text;
  if (out === undefined) throw new Error(`no output for ${entry}`);
  return out;
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

export async function startHarness(
  cdnChoice: HarnessCdn,
  log?: (line: string) => void,
): Promise<Harness> {
  const cdn =
    'config' in cdnChoice
      ? await startCdnServer(
          { ...cdnChoice.config, host: 'localhost', port: 0 },
          log ? { log } : {},
        )
      : null;
  const cdnUrl = cdn ? cdn.url : (cdnChoice as { externalUrl: string }).externalUrl;

  let handler: Parameters<typeof createServer>[1] = (_req, res) => {
    res.writeHead(503);
    res.end('starting');
  };
  const app = createServer((req, res) => {
    handler?.(req, res);
  });
  const appPort = await listen(app, 'localhost');
  const appOrigin = `http://localhost:${String(appPort)}`;
  const shell = await startShellServer({
    port: 0,
    host: '127.0.0.1',
    appOrigins: [appOrigin],
    cdnOrigin: cdnOriginOf(cdnUrl),
  });

  const require = createRequire(import.meta.url);
  const workerEntry = fileURLToPath(import.meta.resolve('@br/runtime/worker'));
  const [pageJs, workerJs] = await Promise.all([
    bundleForBrowser(path.join(HERE, 'page.ts'), {
      __COMPAT_CONFIG__: JSON.stringify({
        shellUrl: shell.shellUrl,
        cdnBaseUrl: cdnUrl,
        wasmUrl: '/esbuild.wasm',
        workerUrl: '/bundler.worker.js',
      }),
    }),
    bundleForBrowser(workerEntry),
  ]);
  const wasm = readFileSync(
    path.join(path.dirname(require.resolve('esbuild-wasm/package.json')), 'esbuild.wasm'),
  );
  const routes: Record<string, { type: string; body: string | Buffer }> = {
    '/': {
      type: 'text/html; charset=utf-8',
      body: readFileSync(path.join(HERE, 'index.html'), 'utf8'),
    },
    '/compat.js': { type: 'text/javascript; charset=utf-8', body: pageJs },
    '/bundler.worker.js': { type: 'text/javascript; charset=utf-8', body: workerJs },
    '/esbuild.wasm': { type: 'application/wasm', body: wasm },
  };
  handler = (req, res) => {
    const route = routes[new URL(req.url ?? '/', appOrigin).pathname];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': route.type, 'Cache-Control': 'no-store' });
    res.end(route.body);
  };

  return {
    appUrl: `${appOrigin}/`,
    shellUrl: shell.shellUrl,
    cdnUrl,
    cdn,
    close: async () => {
      await Promise.all([
        shell.close(),
        cdn?.close(),
        new Promise<void>((resolve) => {
          app.close(() => {
            resolve();
          });
        }),
      ]);
    },
  };
}
