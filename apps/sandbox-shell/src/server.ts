/**
 * Local static server for the shell, applying the same headers as production
 * (`shellHeaders`) adapted for local http origins:
 * - `frame-ancestors` lists the local app origin instead of https://<app-domain>;
 * - `script-src`/`style-src`/`connect-src` include the http mock CDN origin;
 * - `Cache-Control: no-store` so edits show up without cache busting.
 */
import { createServer, type Server } from 'node:http';
import { buildShell, SHELL_BASE_PATH } from './build-shell';
import { shellHeaders } from './headers';

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
  server: Server;
  close(): Promise<void>;
}

export async function startShellServer(opts: ShellServerOptions): Promise<ShellServer> {
  const built = await buildShell({ appOrigins: opts.appOrigins, minify: true });
  const headers = shellHeaders({
    appOrigins: opts.appOrigins,
    cdnOrigin: opts.cdnOrigin,
    extraConnectSrc: opts.cdnOrigin.startsWith('https:') ? [] : [opts.cdnOrigin],
    cacheControl: 'no-store',
  });
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
    res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
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
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
