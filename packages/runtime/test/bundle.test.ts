/**
 * Runs the real plugins in esbuild-wasm under Node (same wasm binary as the browser worker).
 */
import * as esbuild from 'esbuild-wasm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundle, cachedFetchText, fetchTextFromNetwork } from '../src/bundler/bundle';
import { PackageFetchError } from '../src/bundler/plugins';
import type { BundleInput, FileMap } from '../src/types';

const CDN = 'https://pkg.example.net';
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function input(
  files: FileMap,
  deps: Record<string, string> = {
    react: '19.3.0',
    'react-dom': '19.3.0',
    zustand: '5.0.15',
    'animate.css': '4.1.1',
  },
  mode: BundleInput['mode'] = 'dev',
): BundleInput {
  return { files, manifest: { entry: 'src/main.tsx', dependencies: deps }, mode };
}

const fetchText = vi.fn((url: string) => {
  if (url === `${CDN}/animate.css@4.1.1/animate.min.css`) {
    return Promise.resolve(
      '@import "./extra.css";.animate__animated{animation-duration:1s}.bg{background:url(./img/bg.png)}',
    );
  }
  return Promise.reject(new Error('HTTP 404'));
});

const PROJECT: FileMap = {
  'src/main.tsx': `import { createRoot } from 'react-dom/client';
import 'animate.css/animate.min.css';
import './styles.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
  'src/App.tsx': `import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { helper } from './lib';
import cls from './card.module.css';
import logo from './assets/logo.png';
import icon from './assets/icon.svg';
import data from './data.json';
const useStore = create(persist(() => ({ n: 1 }), { name: 's' }));
export function App() {
  const n: number = useStore((s) => s.n);
  return <img className={cls.card} src={logo} alt={icon + helper(n) + data.title} />;
}
`,
  'src/lib/index.ts': `export const helper = (n: number): string => String(n * 2);`,
  'src/styles.css': `@import './base.css';\n.title { color: rgb(255, 0, 128); background: url('./assets/logo.png'); }`,
  'src/base.css': `body { margin: 0; }`,
  'src/card.module.css': `.card { padding: 4px; }`,
  'src/assets/logo.png': PNG_1PX,
  'src/assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'src/data.json': '{"title":"hi"}',
};

describe('bundle() with esbuild-wasm', () => {
  it('bundles TSX, relative imports, index files, JSON, assets, local CSS, CSS modules and package CSS', async () => {
    const r = await bundle(esbuild, input(PROJECT), { cdnBaseUrl: CDN, fetchText });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    // React entry points stay bare (import map); other packages are pinned CDN URLs.
    expect(r.js).toMatch(/from\s*"react\/jsx-runtime"/);
    expect(r.js).toMatch(/from\s*"react-dom\/client"/);
    const q = '?external=react,react-dom&deps=animate.css@4.1.1,zustand@5.0.15';
    expect(r.js).toContain(`"${CDN}/zustand@5.0.15${q}"`);
    expect(r.js).toContain(`"${CDN}/zustand@5.0.15/middleware${q}"`);
    expect(r.js).not.toMatch(/from\s*"zustand"/);
    // Assets became data URLs, JSON was inlined, TS types stripped.
    expect(r.js).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(r.js).toContain('data:image/svg+xml');
    expect(r.js).toContain('"hi"');
    expect(r.js).not.toContain(': number');
    // CSS: local + @import + module + package CSS in one bundle; url() inside package CSS is absolute.
    expect(r.css).toContain('rgb(255, 0, 128)');
    expect(r.css).toContain('margin: 0');
    expect(r.css).toMatch(/\.card_[\w-]+/);
    expect(r.css).toContain('.animate__animated');
    expect(r.css).toContain(`${CDN}/animate.css@4.1.1/img/bg.png`);
    expect(r.css).toContain(`${CDN}/animate.css@4.1.1/extra.css`);
    expect(r.css).toContain('url(data:image/png;base64,');
    expect(r.importMap.imports['react']).toBe(`${CDN}/react@19.3.0`);
    expect(r.durationMs).toBeGreaterThan(0);
    // T-032: the CDN URLs the bundle imports, once each (the shell names them on failure).
    // React entry points as their import map URLs; not react/jsx-dev-runtime (not imported).
    expect(r.packages).toEqual([
      `${CDN}/react-dom@19.3.0/client?external=react,react-dom`,
      `${CDN}/react@19.3.0/jsx-runtime?external=react,react-dom`,
      `${CDN}/zustand@5.0.15/middleware${q}`,
      `${CDN}/zustand@5.0.15${q}`,
    ]);
  });

  it('defines NODE_ENV and minifies in production mode', async () => {
    const files = {
      'src/main.tsx': `if (process.env.NODE_ENV !== 'production') { console.log('dev only branch'); }\nexport const x = 1;`,
    };
    const dev = await bundle(esbuild, input(files), { cdnBaseUrl: CDN, fetchText });
    const prod = await bundle(esbuild, input(files, undefined, 'production'), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(dev.js).toContain('dev only branch');
    expect(prod.js).not.toContain('dev only branch');
  });

  it('reports a missing relative import with its location', async () => {
    const r = await bundle(esbuild, input({ 'src/main.tsx': `import './nope';\n` }), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        file: 'src/main.tsx',
        line: 1,
        text: 'Cannot find "./nope" imported from "src/main.tsx".',
      }),
    ]);
  });

  it('reports undeclared packages and Node built-ins as diagnostics (no CDN fallback)', async () => {
    const r = await bundle(
      esbuild,
      input({
        'src/main.tsx': `import _ from 'lodash';\nimport fs from 'fs';\nconsole.log(_, fs);`,
      }),
      {
        cdnBaseUrl: CDN,
        fetchText,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.js).toBe('');
    expect(r.diagnostics.map((d) => [d.line, d.text])).toEqual([
      [1, expect.stringContaining('Package "lodash" is not in dependencies')],
      [2, expect.stringContaining('Node.js built-in')],
    ]);
  });

  it('reports syntax errors, a missing entry, unpinned versions and oversized images', async () => {
    const syntax = await bundle(esbuild, input({ 'src/main.tsx': `const = 1;` }), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(syntax.ok).toBe(false);
    expect(syntax.diagnostics[0]).toMatchObject({ file: 'src/main.tsx', line: 1 });

    const noEntry = await bundle(esbuild, input({ 'src/other.ts': '' }), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(noEntry.diagnostics[0]?.text).toContain('Entry file "src/main.tsx" does not exist');

    const unpinned = await bundle(esbuild, input({ 'src/main.tsx': '' }, { zustand: 'latest' }), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(unpinned.ok).toBe(false);
    expect(unpinned.diagnostics[0]?.text).toContain('pinned');

    const big = `data:image/png;base64,${'A'.repeat(300 * 1024)}`;
    const huge = await bundle(
      esbuild,
      input({ 'src/main.tsx': `import u from './big.png'; console.log(u);`, 'src/big.png': big }),
      {
        cdnBaseUrl: CDN,
        fetchText,
      },
    );
    expect(huge.ok).toBe(false);
    expect(huge.diagnostics[0]?.text).toMatch(/limit is 200 KB/);
  });

  it('reports a package CSS fetch failure', async () => {
    const r = await bundle(esbuild, input({ 'src/main.tsx': `import 'zustand/missing.css';` }), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.text).toContain('Failed to fetch package CSS');
  });

  it('says the package server is unreachable, or what it answered, for package CSS (T-032)', async () => {
    const files = { 'src/main.tsx': `import 'animate.css/animate.min.css';` };
    const down = await bundle(esbuild, input(files), {
      cdnBaseUrl: CDN,
      fetchText: () => Promise.reject(new PackageFetchError(null)),
    });
    expect(down.ok).toBe(false);
    expect(down.diagnostics[0]).toMatchObject({ severity: 'error', file: 'src/main.tsx', line: 1 });
    expect(down.diagnostics[0]?.text).toMatch(
      /^Package server unreachable: animate\.css@4\.1\.1\/animate\.min\.css\n/,
    );
    const missing = await bundle(esbuild, input(files), {
      cdnBaseUrl: CDN,
      fetchText: () => Promise.reject(new PackageFetchError(404, 'pkg-cdn: no such file')),
    });
    expect(missing.diagnostics[0]?.text).toBe(
      'Package server error (HTTP 404) for animate.css@4.1.1/animate.min.css: pkg-cdn: no such file',
    );
    expect(down.packages).toBeUndefined();
  });

  it('warns when react and react-dom versions differ', async () => {
    const r = await bundle(
      esbuild,
      input({ 'src/main.tsx': '' }, { react: '19.3.0', 'react-dom': '19.2.0' }),
      { cdnBaseUrl: CDN, fetchText },
    );
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([expect.objectContaining({ severity: 'warning' })]);
  });

  it('warns (and still builds without deps pins) above the CDN deps limit', async () => {
    const deps: Record<string, string> = { react: '19.3.0', 'react-dom': '19.3.0' };
    for (let i = 0; i <= 32; i++) deps[`pkg-${String(i)}`] = '1.0.0';
    const r = await bundle(esbuild, input({ 'src/main.tsx': `import 'pkg-1';` }, deps), {
      cdnBaseUrl: CDN,
      fetchText,
    });
    expect(r.ok).toBe(true);
    expect(r.js).toContain(`"${CDN}/pkg-1@1.0.0?external=react,react-dom"`);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.severity).toBe('warning');
    expect(r.diagnostics[0]?.text).toContain('More than 32 packages');
  });
});

describe('cachedFetchText', () => {
  it('fetches each URL once and retries after a failure', async () => {
    let calls = 0;
    const f = cachedFetchText((url) => {
      calls++;
      return url === 'bad' && calls < 3
        ? Promise.reject(new Error('x'))
        : Promise.resolve(`body:${url}`);
    });
    expect(await f('a')).toBe('body:a');
    expect(await f('a')).toBe('body:a');
    expect(calls).toBe(1);
    await expect(f('bad')).rejects.toThrow('x');
    await Promise.resolve();
    expect(await f('bad')).toBe('body:bad');
  });
});

describe('fetchTextFromNetwork (T-032)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const url = `${CDN}/animate.css@4.1.1/animate.min.css`;

  it('returns the text and lets the HTTP cache answer (no cache override)', async () => {
    const f = vi.fn<(u: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response('.a{}')),
    );
    vi.stubGlobal('fetch', f);
    expect(await fetchTextFromNetwork(url)).toBe('.a{}');
    expect(f).toHaveBeenCalledWith(url, { credentials: 'omit' });
  });

  it('turns no answer into PackageFetchError(null)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const e = await fetchTextFromNetwork(url).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PackageFetchError);
    expect(e).toMatchObject({ status: null });
  });

  it('turns an HTTP error into PackageFetchError(status, first line of the body)', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('pkg-cdn: overloaded\nretry later', { status: 503 })),
    );
    const e = await fetchTextFromNetwork(url).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 503, detail: 'pkg-cdn: overloaded' });
  });
});
