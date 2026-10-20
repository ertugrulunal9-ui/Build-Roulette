/**
 * Local static server for the shell, applying the same headers as production
 * (`securityHeaders` on every response, 404s included) adapted for local http origins:
 * - `frame-ancestors` lists the local app origin instead of https://<app-domain>;
 * - `connect-src` also includes any `extraConnectSrc` (e.g. the local Supabase API or a test
 *   file server, from which the capture page fetches site packs); the site worker's site CSP
 *   gets them too;
 * - `Cache-Control: no-store` so edits show up without cache busting.
 *
 * Routes mirror the static build (scripts/build.ts): `/v{N}/`, `/v{N}/index.html`,
 * `/v{N}/shell.js`, `/v{N}/capture.js`, `/v{N}/sw.js` (the site worker, with
 * `Service-Worker-Allowed: /`), `/v{N}/reset` (`Clear-Site-Data`, fetched by the shell's
 * `reset-storage`) and `/v{N}/capture`, answered by the same capture gate as the production
 * Worker (`worker.ts`; HMAC check with `captureSecret`; without a secret it answers 503).
 * Every other path is a 404 with the security headers: the host serves no script but its
 * own, which is what keeps a site from registering a service worker of its own.
 */
import { createServer, type Server } from 'node:http';
import { buildShell, SHELL_BASE_PATH } from './build-shell';
import { CAPTURE_PATH, handleCaptureRequest } from './capture-gate';
import {
  RESET_ENDPOINT,
  RESET_HEADERS,
  SITE_WORKER_HEADERS,
  captureHeaders,
  securityHeaders,
} from './headers';
import { SITE_WORKER_FILE } from './site-protocol';

export interface ShellServerOptions {
  port?: number;
  /** Use a different site from the app (e.g. 127.0.0.1 vs localhost) to get a cross-site iframe. */
  host?: string;
  appOrigins: readonly string[];
  /** Extra `connect-src` sources (local http origins; production allows `https:`). */
  extraConnectSrc?: readonly string[];
  /** HMAC secret of the capture gate. Without it `/v{N}/capture` answers 503. */
  captureSecret?: string;
}

export interface ShellServer {
  /** e.g. http://127.0.0.1:4311/v2/ */
  shellUrl: string;
  /** e.g. http://127.0.0.1:4311/v2/capture (sign it with `signCaptureUrl`). */
  captureUrl: string;
  origin: string;
  /** Size of the served shell.js in bytes. */
  shellJsBytes: number;
  /** Size of the served sw.js in bytes. */
  swJsBytes: number;
  /** Number of `/v{N}/reset` requests served (for tests). */
  resetRequests(): number;
  /** Number of `/v{N}/sw.js` requests served (for tests: registrations and update checks). */
  workerScriptRequests(): number;
  /** Capture page requests: served (valid signature) and refused (for tests). */
  captureRequests(): { served: number; refused: number };
  server: Server;
  close(): Promise<void>;
}

export async function startShellServer(opts: ShellServerOptions): Promise<ShellServer> {
  const headerOpts = {
    appOrigins: opts.appOrigins,
    ...(opts.extraConnectSrc ? { extraConnectSrc: opts.extraConnectSrc } : {}),
  };
  const built = await buildShell({ ...headerOpts, minify: true });
  const security = securityHeaders(headerOpts);
  const capture = captureHeaders(headerOpts);
  const headers = { ...security, 'Cache-Control': 'no-store' };
  const js = { 'Content-Type': 'text/javascript; charset=utf-8' };
  let resets = 0;
  let workerScripts = 0;
  const captures = { served: 0, refused: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shell.local');
    if (url.pathname === SHELL_BASE_PATH || url.pathname === `${SHELL_BASE_PATH}index.html`) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(built.html);
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}shell.js`) {
      res.writeHead(200, { ...headers, ...js });
      res.end(built.js);
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}capture.js`) {
      res.writeHead(200, { ...headers, ...js });
      res.end(built.captureJs);
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}${SITE_WORKER_FILE}`) {
      workerScripts++;
      res.writeHead(200, { ...security, ...SITE_WORKER_HEADERS, ...js });
      res.end(built.swJs);
      return;
    }
    if (url.pathname === CAPTURE_PATH) {
      // Same gate as production. The URL is rebuilt from the Host header, as a Worker sees it.
      const request = new Request(`http://${req.headers.host ?? 'shell.local'}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
      });
      void handleCaptureRequest(request, { secret: opts.captureSecret, headers: capture }).then(
        async (response) => {
          if (response.ok) captures.served++;
          else captures.refused++;
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        },
        () => {
          captures.refused++;
          res.writeHead(500, headers);
          res.end();
        },
      );
      return;
    }
    if (url.pathname === `${SHELL_BASE_PATH}${RESET_ENDPOINT}`) {
      resets++;
      res.writeHead(200, { ...security, ...RESET_HEADERS, 'Content-Type': 'text/plain' });
      res.end('ok\n');
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
    captureUrl: `${origin}${CAPTURE_PATH}`,
    origin,
    shellJsBytes: Buffer.byteLength(built.js),
    swJsBytes: Buffer.byteLength(built.swJs),
    resetRequests: () => resets,
    workerScriptRequests: () => workerScripts,
    captureRequests: () => ({ ...captures }),
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
