/**
 * Shared fixtures for the integration tests: the local sandbox shell (protocol v2) with its
 * capture gate, a tiny file server for site packs that do not come from Supabase, and built
 * static sites packed with `@br/site`'s `packSite`, the format players import (docs/09).
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { contentTypeOf, packSite } from '@br/site';
import { startShellServer, type ShellServer } from '@br/sandbox-shell/server';

export const SECRET = 'integration-secret-0123456789abcdef0123456789abcdef';

export interface FileServer {
  url: string;
  files: Map<string, { body: string | Uint8Array; type: string }>;
  close(): Promise<void>;
}

/** Serves `files` with CORS; `/hang` never answers (keeps the network busy). */
export async function startFileServer(): Promise<FileServer> {
  const files = new Map<string, { body: string | Uint8Array; type: string }>();
  const hanging = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/hang') {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
      res.write(' ');
      hanging.add(res);
      return;
    }
    const f = files.get(path);
    if (!f) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': f.type });
    res.end(f.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    files,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of hanging) r.destroy();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface Fixtures {
  shell: ShellServer;
  close(): Promise<void>;
}

/** The shell (capture gate with SECRET). `connectSrc`: extra origins the page may fetch. */
export async function startFixtures(connectSrc: readonly string[]): Promise<Fixtures> {
  const shell = await startShellServer({
    host: '127.0.0.1',
    appOrigins: ['http://localhost:3000'],
    extraConnectSrc: connectSrc,
    captureSecret: SECRET,
  });
  return { shell, close: () => shell.close() };
}

/** The media type a site pack is stored with (the `ephemeral-builds` bucket allows it). */
export const SITE_PACK_TYPE = 'application/octet-stream';

/** Packs `files` (path → text) as a site pack (`@br/site`); content types from the paths. */
export function sitePack(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  return packSite(
    Object.entries(files).map(([path, text]) => ({
      path,
      type: contentTypeOf(path),
      bytes: new TextEncoder().encode(text),
    })),
  );
}

function html(head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Capture fixture</title>
    ${head}
  </head>
  <body>${body}</body>
</html>
`;
}

/**
 * A built site the way a bundler emits it (Vite's layout: root-relative hashed assets, a
 * lazily imported chunk, `fetch('/data.json')`), filling the 1280×800 viewport with
 * `background` (from the stylesheet) and a big white title. It calls
 * `window.buildRoulette.ready()` after its first paint when `signalReady` is set.
 */
export function builtSite(opts: {
  title: string;
  background: string;
  signalReady: boolean;
}): Record<string, string> {
  const css = `body { margin: 0; }
.hero { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: ${opts.background}; color: #fff; font: bold 120px sans-serif; }
.hero h1 { margin: 0; font: inherit; }
`;
  return {
    'index.html': html(
      `<script type="module" crossorigin src="/assets/index-c4pt.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-c4pt.css" />`,
      '<div id="root"></div>',
    ),
    'assets/index-c4pt.js': `const { heading } = await import('./title-c4pt.js');
const data = await (await fetch('/data.json')).json();
const main = document.createElement('main');
main.className = 'hero';
main.append(heading(data.title));
document.getElementById('root').append(main);
${opts.signalReady ? 'requestAnimationFrame(() => window.buildRoulette?.ready());' : ''}
`,
    'assets/title-c4pt.js': `export function heading(text) {
  const h1 = document.createElement('h1');
  h1.textContent = text;
  return h1;
}
`,
    'assets/index-c4pt.css': css,
    'data.json': JSON.stringify({ title: opts.title }),
  };
}

/** A site whose one classic script (`/main.js`, at the end of the body) is `js`. */
export function scriptSite(js: string): Record<string, string> {
  return {
    'index.html': html('', '<script src="/main.js"></script>'),
    'main.js': js,
  };
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function colorClose(a: Rgb, b: Rgb, tolerance = 12): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}
