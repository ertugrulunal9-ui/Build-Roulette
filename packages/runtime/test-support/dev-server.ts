/**
 * Local three-origin setup for the playground and the e2e tests:
 *
 *   app (playground)                    http://localhost:<appPort>
 *   sandbox shell (/v2/, site worker)   http://127.0.0.1:<shellPort>   (a different site)
 *   other origin (files, probes)        http://localhost:<otherPort>
 *
 * Run: pnpm --filter @br/runtime playground   (ports via APP_PORT / SHELL_PORT / OTHER_PORT)
 *
 * Test support only:
 * - `PUT /__test/site?name=N` (app origin) stores a site pack; the other origin serves it as
 *   `GET /sites/N.bin` with CORS, like a signed Storage URL.
 * - `GET /__test/capture-url?name=N` (app origin) answers with a signed capture URL of the
 *   shell (`/v2/capture?src=<other>/sites/N.bin&exp=…&sig=…`). The capture secret is random
 *   per process and never leaves it.
 * - `GET /health` (other origin): a blank page on an origin that is neither the app nor the
 *   sandbox (frame-ancestors e2e).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { SITE_LIMITS } from '@br/site';
import { signCaptureUrl } from '@br/sandbox-shell/capture-sig';
import { startShellServer } from '@br/sandbox-shell/server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface DevServerOptions {
  appPort?: number;
  shellPort?: number;
  otherPort?: number;
}

export interface DevServers {
  appUrl: string;
  shellUrl: string;
  otherUrl: string;
  shellJsBytes: number;
  swJsBytes: number;
  close(): Promise<void>;
}

export interface PlaygroundConfig {
  shellUrl: string;
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

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.byteLength;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

export async function startDevServers(opts: DevServerOptions = {}): Promise<DevServers> {
  const packs = new Map<string, Buffer>();

  // The other origin: site packs with CORS (what a signed Storage URL is), and a blank page.
  const other = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://other.local');
    const m = /^\/sites\/([\w-]+)\.bin$/.exec(url.pathname);
    const body = m?.[1] === undefined ? undefined : packs.get(m[1]);
    if (body) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>other origin</title>');
      return;
    }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });
  const otherPort = await listen(other, opts.otherPort ?? 0, 'localhost');
  const otherOrigin = `http://localhost:${String(otherPort)}`;

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

  const captureSecret = randomBytes(32).toString('hex');
  const shell = await startShellServer({
    port: opts.shellPort ?? 0,
    host: '127.0.0.1',
    appOrigins: [appOrigin],
    // The capture page fetches site packs from the other origin (plain http locally).
    extraConnectSrc: [otherOrigin],
    captureSecret,
  });

  const config: PlaygroundConfig = { shellUrl: shell.shellUrl };
  const playgroundJs = await bundleForBrowser(path.join(ROOT, 'playground/main.ts'), {
    __PLAYGROUND_CONFIG__: JSON.stringify(config),
  });
  const html = readFileSync(path.join(ROOT, 'playground/index.html'), 'utf8');

  const routes: Record<string, { type: string; body: string | Buffer }> = {
    '/': { type: 'text/html; charset=utf-8', body: html },
    '/playground.js': { type: 'text/javascript; charset=utf-8', body: playgroundJs },
    // Policy e2e: a classic script on the app origin (plain http), which is NOT in the site
    // CSP's script-src. A site that adds <script src> for it must not run it.
    '/csp-probe.js': {
      type: 'text/javascript; charset=utf-8',
      body: 'window.__cspProbeRan = true;\n',
    },
  };
  handler = (req, res) => {
    const url = new URL(req.url ?? '/', appOrigin);
    const name = url.searchParams.get('name') ?? '';
    if (url.pathname === '/__test/site' && req.method === 'PUT' && /^[\w-]+$/.test(name)) {
      void readBody(req, SITE_LIMITS.maxPackBytes).then(
        (body) => {
          packs.set(name, body);
          res.writeHead(204);
          res.end();
        },
        () => {
          res.writeHead(413);
          res.end();
        },
      );
      return;
    }
    if (url.pathname === '/__test/capture-url' && /^[\w-]+$/.test(name)) {
      void signCaptureUrl({
        captureUrl: shell.captureUrl,
        src: `${otherOrigin}/sites/${name}.bin`,
        exp: Math.floor(Date.now() / 1000) + 300,
        secret: captureSecret,
      }).then((signed) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(signed);
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
    otherUrl: otherOrigin,
    shellJsBytes: shell.shellJsBytes,
    swJsBytes: shell.swJsBytes,
    close: async () => {
      await Promise.all([shell.close(), close(other), close(app)]);
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
    otherPort: Number(env['OTHER_PORT'] ?? 4312),
  });
  console.log(`playground  ${servers.appUrl}`);
  console.log(
    `shell       ${servers.shellUrl} (shell.js ${String(servers.shellJsBytes)} B, sw.js ${String(servers.swJsBytes)} B)`,
  );
  console.log(`other       ${servers.otherUrl}`);
  const stop = () => {
    void servers.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
