/**
 * Local three-origin setup for the playground and the e2e tests:
 *
 *   app (playground + bundler worker + esbuild.wasm)  http://localhost:<appPort>
 *   sandbox shell (/v1/)                              http://127.0.0.1:<shellPort>   (different site)
 *   mock package CDN                                  http://localhost:<cdnPort>
 *
 * Run: pnpm --filter @br/runtime playground   (ports via APP_PORT / SHELL_PORT / CDN_PORT)
 *
 * `POST /__test/cdn-outage?mode=refuse|error|hang|off` on the app origin starts or ends a
 * simulated package CDN outage (T-032 e2e, `MockCdn.setOutage`). Test support only.
 * `CDN_LAYOUT=esm.sh` makes the mock CDN answer like the public esm.sh (an entry module that
 * re-exports an internal build path, T-035; `MockCdnLayout`).
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { startShellServer } from '@br/sandbox-shell/server';
import {
  parseLayout,
  parseOutage,
  startMockCdn,
  type CdnOutage,
  type MockCdnLayout,
} from './mock-cdn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface DevServerOptions {
  appPort?: number;
  shellPort?: number;
  cdnPort?: number;
  cdnLayout?: MockCdnLayout;
}

export interface DevServers {
  appUrl: string;
  shellUrl: string;
  cdnUrl: string;
  shellJsBytes: number;
  setCdnOutage(outage: CdnOutage | null): Promise<void>;
  close(): Promise<void>;
}

export interface PlaygroundConfig {
  shellUrl: string;
  cdnBaseUrl: string;
  wasmUrl: string;
  workerUrl: string;
}

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
    sourcemap: 'inline',
    logLevel: 'silent',
    define,
  });
  const out = result.outputFiles[0]?.text;
  if (out === undefined) throw new Error(`no output for ${entry}`);
  return out;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

export async function startDevServers(opts: DevServerOptions = {}): Promise<DevServers> {
  const cdn = await startMockCdn({
    port: opts.cdnPort ?? 0,
    host: 'localhost',
    layout: opts.cdnLayout ?? 'bundle',
  });

  // The app origin must be known before the shell is built (frame-ancestors, hello target),
  // so bind the app server first and fill in its handler afterwards.
  let handler: Parameters<typeof createServer>[1] = (_req, res) => {
    res.writeHead(503);
    res.end('starting');
  };
  const app = createServer((req, res) => {
    handler?.(req, res);
  });
  const appPort = await listen(app, opts.appPort ?? 0, 'localhost');
  const appOrigin = `http://localhost:${String(appPort)}`;

  const shell = await startShellServer({
    port: opts.shellPort ?? 0,
    host: '127.0.0.1',
    appOrigins: [appOrigin],
    cdnOrigin: cdn.url,
  });

  const config: PlaygroundConfig = {
    shellUrl: shell.shellUrl,
    cdnBaseUrl: cdn.url,
    wasmUrl: '/esbuild.wasm',
    workerUrl: '/bundler.worker.js',
  };
  const [playgroundJs, workerJs] = await Promise.all([
    bundleForBrowser(path.join(ROOT, 'playground/main.ts'), {
      __PLAYGROUND_CONFIG__: JSON.stringify(config),
    }),
    bundleForBrowser(path.join(ROOT, 'src/worker/bundler.worker.ts')),
  ]);
  const html = readFileSync(path.join(ROOT, 'playground/index.html'), 'utf8');
  const require = createRequire(import.meta.url);
  const wasm = readFileSync(
    path.join(path.dirname(require.resolve('esbuild-wasm/package.json')), 'esbuild.wasm'),
  );

  const routes: Record<string, { type: string; body: string | Buffer }> = {
    '/': { type: 'text/html; charset=utf-8', body: html },
    '/playground.js': { type: 'text/javascript; charset=utf-8', body: playgroundJs },
    '/bundler.worker.js': { type: 'text/javascript; charset=utf-8', body: workerJs },
    '/esbuild.wasm': { type: 'application/wasm', body: wasm },
    // Policy e2e: a classic script on the app origin, which is NOT in the shell's
    // script-src. A build that adds <script src> for it must not run it.
    '/csp-probe.js': {
      type: 'text/javascript; charset=utf-8',
      body: 'window.__cspProbeRan = true;\n',
    },
  };
  handler = (req, res) => {
    const url = new URL(req.url ?? '/', appOrigin);
    if (url.pathname === '/__test/cdn-outage' && req.method === 'POST') {
      const outage = parseOutage(url.searchParams.get('mode'));
      if (outage === undefined) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('mode must be refuse, error, hang or off');
        return;
      }
      void cdn.setOutage(outage).then(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(`cdn outage: ${outage ?? 'off'}\n`);
      });
      return;
    }
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': route.type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(route.body);
  };

  return {
    appUrl: `${appOrigin}/`,
    shellUrl: shell.shellUrl,
    cdnUrl: cdn.url,
    shellJsBytes: shell.shellJsBytes,
    setCdnOutage: (outage) => cdn.setOutage(outage),
    close: async () => {
      await Promise.all([
        shell.close(),
        cdn.close(),
        new Promise<void>((resolve) => {
          app.close(() => {
            resolve();
          });
        }),
      ]);
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const env = process.env;
  const servers = await startDevServers({
    appPort: Number(env['APP_PORT'] ?? 4310),
    shellPort: Number(env['SHELL_PORT'] ?? 4311),
    cdnPort: Number(env['CDN_PORT'] ?? 4312),
    cdnLayout: parseLayout(env['CDN_LAYOUT']),
  });
  console.log(`playground  ${servers.appUrl}`);
  console.log(`shell       ${servers.shellUrl} (shell.js ${String(servers.shellJsBytes)} B)`);
  console.log(`mock CDN    ${servers.cdnUrl} (${env['CDN_LAYOUT'] || 'bundle'} layout)`);
  const stop = () => {
    void servers.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
