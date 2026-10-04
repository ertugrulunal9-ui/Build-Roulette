/**
 * Local static server for the shell, applying the same headers as production
 * (`securityHeaders` on every response, 404s included) adapted for local http origins:
 * - `frame-ancestors` lists the local app origin instead of https://<app-domain>;
 * - `script-src`/`style-src`/`connect-src` include the http mock CDN origin;
 * - `Cache-Control: no-store` so edits show up without cache busting.
 *
 * Routes mirror the static build (scripts/build.ts): `/v{N}/`, `/v{N}/index.html`,
 * `/v{N}/shell.js` and `/v{N}/reset` (`Clear-Site-Data`, fetched by the shell's
 * `reset-storage`). `/v{N}/sw-test.js` is a same-origin script used only by the policy e2e
 * (service worker registration must be rejected); it is not part of the static build.
 */
import { createServer, type Server } from 'node:http';
import { buildShell, SHELL_BASE_PATH } from './build-shell';
import { RESET_ENDPOINT, RESET_HEADERS, securityHeaders } from './headers';

export interface ShellServerOptions {
  port?: number;
  /** Use a different site from the app (e.g. 127.0.0.1 vs localhost) to get a cross-site iframe. */
  host?: string;
  appOrigins: readonly string[];
  cdnOrigin: string;
}

export interface ShellServer {
  /** e.g. http://127.0.0.1:4311/v1/ */
  shellUrl: string;
  origin: string;
  /** Size of the served shell.js in bytes. */
  shellJsBytes: number;
  /** Number of `/v{N}/reset` requests served (for tests). */
  resetRequests(): number;
  server: Server;
  close(): Promise<void>;
}

export async function startShellServer(opts: ShellServerOptions): Promise<ShellServer> {
  const built = await buildShell({ appOrigins: opts.appOrigins, minify: true });
  const security = securityHeaders({
    appOrigins: opts.appOrigins,
    cdnOrigin: opts.cdnOrigin,
    extraConnectSrc: opts.cdnOrigin.startsWith('https:') ? [] : [opts.cdnOrigin],
  });
  const headers = { ...security, 'Cache-Control': 'no-store' };
  let resets = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shell.local');
    if (url.pathname === SHELL_BASE_PATH || url.pathname === `${SHELL_BASE_PATH}index.html`) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(built.html);
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}shell.js`) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(built.js);
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}${RESET_ENDPOINT}`) {
      resets++;
      res.writeHead(200, { ...security, ...RESET_HEADERS, 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}sw-test.js`) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end('// service worker script for the policy e2e; must never be registered\n');
      return;
    }
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
  const origin = `http://${host}:${String(port)}`;
  return {
    shellUrl: `${origin}${SHELL_BASE_PATH}`,
    origin,
    shellJsBytes: Buffer.byteLength(built.js),
    resetRequests: () => resets,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
