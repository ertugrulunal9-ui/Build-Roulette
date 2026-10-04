/**
 * Shared fixtures for the integration tests: the local sandbox shell with its capture gate,
 * the mock package CDN (React from packages/runtime's node_modules), a tiny file server for
 * bundles that do not come from Supabase, and React bundles built with @br/runtime's real
 * bundler.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import * as esbuild from 'esbuild';
import { bundle } from '@br/runtime/bundler';
import { startShellServer, type ShellServer } from '@br/sandbox-shell/server';
// Imported by path: @br/runtime does not export its test support (same as apps/web).
import { startMockCdn, type MockCdn } from '../../../packages/runtime/test-support/mock-cdn';

export const SECRET = 'integration-secret-0123456789abcdef0123456789abcdef';
export const REACT_VERSION = '19.3.0';

export interface FileServer {
  url: string;
  files: Map<string, { body: string; type: string }>;
  close(): Promise<void>;
}

/** Serves `files` with CORS; `/hang` never answers (keeps the network busy). */
export async function startFileServer(): Promise<FileServer> {
  const files = new Map<string, { body: string; type: string }>();
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
  cdn: MockCdn;
  shell: ShellServer;
  close(): Promise<void>;
}

/** Mock CDN + shell (capture gate with SECRET). `connectSrc`: extra origins the page may fetch. */
export async function startFixtures(connectSrc: readonly string[]): Promise<Fixtures> {
  const cdn = await startMockCdn({ host: 'localhost' });
  const shell = await startShellServer({
    host: '127.0.0.1',
    appOrigins: ['http://localhost:3000'],
    cdnOrigin: cdn.url,
    extraConnectSrc: connectSrc,
    captureSecret: SECRET,
  });
  return {
    cdn,
    shell,
    close: async () => {
      await Promise.all([shell.close(), cdn.close()]);
    },
  };
}

export interface BuiltBundle {
  js: string;
  css: string;
  source: string;
}

/** Bundles a React project with @br/runtime's bundler (native esbuild, same plugins as the worker). */
export async function buildReactBundle(
  cdnUrl: string,
  files: Record<string, string>,
): Promise<BuiltBundle> {
  const manifest = {
    entry: 'src/main.tsx',
    dependencies: { react: REACT_VERSION, 'react-dom': REACT_VERSION },
  };
  const result = await bundle(
    esbuild,
    { files, manifest, mode: 'production' },
    {
      cdnBaseUrl: cdnUrl,
      fetchText: () => Promise.reject(new Error('no package CSS in these fixtures')),
    },
  );
  if (!result.ok) throw new Error(`bundle failed: ${JSON.stringify(result.diagnostics)}`);
  return { js: result.js, css: result.css, source: JSON.stringify({ files, manifest }) };
}

/**
 * A React app filling the 1280×800 viewport with `background` and a big white title. It
 * calls `window.buildRoulette.ready()` after its first paint when `signalReady` is set.
 */
export function reactApp(opts: {
  title: string;
  background: string;
  signalReady: boolean;
  /** Inline styles instead of a CSS file (autosaves have no CSS file). */
  inlineStyles?: boolean;
}): Record<string, string> {
  const css = `body { margin: 0; }
.hero { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: ${opts.background}; color: #fff; font: bold 120px sans-serif; }`;
  const style = opts.inlineStyles
    ? `style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '${opts.background}', color: '#fff', font: 'bold 120px sans-serif', margin: 0 }}`
    : 'className="hero"';
  return {
    'src/main.tsx': `import { createRoot } from 'react-dom/client';
${opts.inlineStyles ? '' : "import './styles.css';\n"}import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    'src/App.tsx': `import { useEffect } from 'react';
declare global { interface Window { buildRoulette?: { ready(): void } } }
export function App() {
  useEffect(() => {
    ${opts.signalReady ? 'requestAnimationFrame(() => window.buildRoulette?.ready());' : ''}
  }, []);
  return <main ${style}><h1 style={{ margin: 0, font: 'inherit' }}>${opts.title}</h1></main>;
}
`,
    ...(opts.inlineStyles ? {} : { 'src/styles.css': css }),
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
