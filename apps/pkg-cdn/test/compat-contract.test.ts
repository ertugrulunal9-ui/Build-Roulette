import { describe, expect, it } from 'vitest';
import {
  caseFindings,
  contractFindings,
  probeTree,
  probeUrl,
  splitImports,
  treeProblems,
  urlPackage,
  type FetchFn,
} from '../compat/contract';

const ORIGIN = 'http://localhost:5000';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const OPTS = { origin: ORIGIN, userAgent: UA };
const IMMUTABLE = 'public, max-age=31536000, immutable';
const JS = 'application/javascript; charset=utf-8';

interface Fake {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A CDN answering from a table; records each request's init. */
function cdn(table: Record<string, Fake>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = (url, init) => {
    requests.push({ url, init });
    const f = table[url];
    if (!f) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(f.body ?? '', {
        status: f.status ?? 200,
        headers: {
          'Cache-Control': IMMUTABLE,
          'Access-Control-Allow-Origin': '*',
          'Content-Type': JS,
          ...f.headers,
        },
      }),
    );
  };
  return { fetchFn, requests };
}

describe('CDN contract (T-032, T-035)', () => {
  it('follows esm.sh entry modules to their internal build paths, and finds them sound', async () => {
    const { fetchFn, requests } = cdn({
      'https://esm.sh/react-dom@19.3.0/client?external=react,react-dom': {
        body: '/* esm.sh - react-dom@19.3.0/client */\nexport * from "/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs";\n',
        headers: { Vary: 'User-Agent' },
      },
      'https://esm.sh/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs': {
        body: 'import*as e from"react";import"/scheduler@0.27.0/es2022/scheduler.mjs";var x=1;',
      },
      'https://esm.sh/scheduler@0.27.0/es2022/scheduler.mjs': { body: 'export var a=1;' },
    });
    const records = await probeTree(
      [{ url: 'https://esm.sh/react-dom@19.3.0/client?external=react,react-dom', kind: 'module' }],
      fetchFn,
      OPTS,
    );
    expect(records.map((r) => [r.depth, r.url, r.problems])).toEqual([
      [0, 'https://esm.sh/react-dom@19.3.0/client?external=react,react-dom', []],
      [1, 'https://esm.sh/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs', []],
      [2, 'https://esm.sh/scheduler@0.27.0/es2022/scheduler.mjs', []],
    ]);
    expect(records[0]?.notes).toEqual(['Vary: User-Agent']);
    // As the browser asks: its User-Agent, a CORS Origin, no redirects followed.
    expect(requests[0]?.init).toMatchObject({
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'User-Agent': UA },
    });
  });

  it('reports what would break the sandbox, with the URL', async () => {
    const base = 'https://cdn.example';
    const { fetchFn } = cdn({
      [`${base}/a@1.0.0`]: { status: 302, headers: { Location: '/a@1.0.0/x' } },
      [`${base}/b@1.0.0`]: { headers: { 'Cache-Control': 'public, max-age=600' } },
      [`${base}/c@1.0.0`]: { headers: { 'Access-Control-Allow-Origin': 'https://other.example' } },
      [`${base}/d@1.0.0`]: { body: 'import "https://elsewhere.example/x.mjs";' },
      [`${base}/e@1.0.0/x.css`]: { headers: { 'Content-Type': JS } },
      [`${base}/f@1.0.0`]: { status: 500, body: '/* esm.sh - error */\nthrow new Error("x")' },
      [`${base}/g@1.0.0`]: { headers: { 'Cache-Control': 'public, max-age=31536000' } },
    });
    const records = await probeTree(
      [
        ...['a', 'b', 'c', 'd', 'f', 'g', 'h'].map((n) => ({
          url: `${base}/${n}@1.0.0`,
          kind: 'module' as const,
        })),
        { url: `${base}/e@1.0.0/x.css`, kind: 'css' },
      ],
      fetchFn,
      OPTS,
    );
    expect(treeProblems(records, (u) => u.slice(base.length))).toEqual([
      '/a@1.0.0: redirects (HTTP 302) to /a@1.0.0/x: an exact URL must answer itself',
      '/b@1.0.0: Cache-Control "public, max-age=600": needs max-age ≥ 30 days to outlast a CDN outage',
      `/c@1.0.0: no CORS for ${ORIGIN} (Access-Control-Allow-Origin: https://other.example)`,
      '/d@1.0.0: imports from another origin, which the shell CSP blocks: https://elsewhere.example/x.mjs',
      '/f@1.0.0: HTTP 500',
      '/h@1.0.0: no answer (fetch failed)',
      '/e@1.0.0/x.css: Content-Type "application/javascript; charset=utf-8" is not CSS',
    ]);
    expect(records.find((r) => r.url.endsWith('/g@1.0.0'))?.notes).toEqual([
      'Cache-Control without immutable (public, max-age=31536000)',
    ]);
    expect(records.find((r) => r.url.endsWith('/f@1.0.0'))?.error).toBe('/* esm.sh - error */');
  });

  it('follows @br/pkg-cdn peer URLs, and probes a URL once across calls', async () => {
    const fiber =
      'http://localhost:4400/@react-three/fiber@9.8.1?external=react,react-dom&deps=x@1.0.0';
    const three = 'http://localhost:4400/three@0.186.1?external=react,react-dom&deps=x@1.0.0';
    const { fetchFn, requests } = cdn({
      [fiber]: { body: 'import*as t from"/three@0.186.1?external=react,react-dom&deps=x@1.0.0";' },
      [three]: { body: 'export const a=1;' },
    });
    const seen = new Set<string>();
    const first = await probeTree([{ url: fiber, kind: 'module' }], fetchFn, OPTS, seen);
    expect(first.map((r) => r.url)).toEqual([fiber, three]);
    const second = await probeTree([{ url: three, kind: 'module' }], fetchFn, OPTS, seen);
    expect(second).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('caps how far it follows', async () => {
    const fetchFn: FetchFn = (url) =>
      Promise.resolve(
        new Response(`import "${new URL(url).pathname}x";`, {
          headers: {
            'Cache-Control': IMMUTABLE,
            'Access-Control-Allow-Origin': '*',
            'Content-Type': JS,
          },
        }),
      );
    const records = await probeTree([{ url: 'https://esm.sh/a', kind: 'module' }], fetchFn, {
      ...OPTS,
      maxFollowed: 5,
    });
    expect(records).toHaveLength(6);
  });

  it('splits imports by origin and leaves bare specifiers to the import map', async () => {
    expect(
      await splitImports(
        'import "react";import "/x.mjs";import "./y.mjs";import "https://esm.sh/z";import "https://other.example/w";',
        'https://esm.sh/a@1.0.0/es2022/a.mjs',
      ),
    ).toEqual({
      imports: ['https://esm.sh/x.mjs', 'https://esm.sh/a@1.0.0/es2022/y.mjs', 'https://esm.sh/z'],
      foreignImports: ['https://other.example/w'],
      shellFinds: 3,
    });
    // Imports after other code, a dynamic import on another origin, and one the shell's scan
    // misses (right after a comment), which becomes a note.
    expect(
      await splitImports(
        'var a=1;import "/x.mjs";var s=\'import "/no.mjs"\';import("https://other.example/lazy.mjs");/* c */import "/y.mjs";',
        'https://esm.sh/a@1.0.0',
      ),
    ).toEqual({
      imports: ['https://esm.sh/x.mjs', 'https://esm.sh/y.mjs'],
      foreignImports: ['https://other.example/lazy.mjs'],
      shellFinds: 1,
    });
    expect(
      contractFindings(
        {
          kind: 'module',
          status: 200,
          error: null,
          location: null,
          cacheControl: 'no-cache, max-age=31536000',
          allowOrigin: ORIGIN,
          vary: null,
          contentType: 'text/javascript',
          foreignImports: [],
        },
        ORIGIN,
      ).problems,
    ).toEqual([
      'Cache-Control "no-cache, max-age=31536000": needs max-age ≥ 30 days to outlast a CDN outage',
    ]);
  });

  it('times a request and keeps the body size', async () => {
    const { fetchFn } = cdn({ 'https://esm.sh/a@1.0.0': { body: 'export const a = 1;' } });
    const r = await probeUrl('https://esm.sh/a@1.0.0', 'module', 0, fetchFn, OPTS);
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(19);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('reads the package and version of a CDN URL (T-040)', () => {
    expect(urlPackage('https://esm.sh/scheduler@%5E0.28.0?target=es2022')).toEqual({
      name: 'scheduler',
      version: '^0.28.0',
      exact: false,
    });
    expect(urlPackage('https://esm.sh/@react-spring/core@~10.1.2?target=es2022')).toEqual({
      name: '@react-spring/core',
      version: '~10.1.2',
      exact: false,
    });
    expect(urlPackage('https://esm.sh/three@0.186.1/X-ZXh0/es2022/three.mjs')).toEqual({
      name: 'three',
      version: '0.186.1',
      exact: true,
    });
    expect(urlPackage('https://esm.sh/three@0.186.1&external=react/examples/x.js')).toEqual({
      name: 'three',
      version: '0.186.1',
      exact: true,
    });
    expect(urlPackage('https://esm.sh/*swr@2.2.5')).toMatchObject({ name: 'swr', exact: true });
    expect(urlPackage('https://esm.sh/node/process.mjs')).toBe('polyfill');
    expect(urlPackage('https://esm.sh/')).toBeNull();
  });
});

/**
 * T-040: esm.sh imports a package's own dependencies by range (CI run 60). For a dependency the
 * case's manifest does not list, the short cache is a note with its outage window; a package
 * the manifest lists reached by range is a problem (a second copy).
 */
describe('CDN contract for a case (T-040)', () => {
  const SHORT = 'public, max-age=600';
  const table = {
    'https://esm.sh/react-chartjs-2@5.3.1?external=chart.js,react,react-dom': {
      body: 'export * from "/react-chartjs-2@5.3.1/X-YQ/es2022/react-chartjs-2.mjs";',
    },
    'https://esm.sh/react-chartjs-2@5.3.1/X-YQ/es2022/react-chartjs-2.mjs': {
      body: 'import "chart.js";import "/immer@^11.0.0?target=es2022";import "/node/process.mjs";',
    },
    'https://esm.sh/immer@^11.0.0?target=es2022': {
      body: 'export * from "/immer@11.0.1/es2022/immer.mjs";',
      headers: { 'Cache-Control': SHORT },
    },
    'https://esm.sh/immer@11.0.1/es2022/immer.mjs': { body: 'export const a = 1;' },
    'https://esm.sh/node/process.mjs': {
      body: 'export default {};',
      headers: { 'Cache-Control': 'public, max-age=86400' },
    },
    'https://esm.sh/chart.js@^4.1.1?target=es2022': {
      body: 'export * from "/chart.js@4.5.1/es2022/chart.mjs";',
      headers: { 'Cache-Control': SHORT },
    },
    'https://esm.sh/chart.js@4.5.1/es2022/chart.mjs': { body: 'export const c = 1;' },
  };
  const short = (u: string) => u.slice('https://esm.sh'.length);

  it('notes the short cache of an unlisted dependency or polyfill, with its outage window', async () => {
    const { fetchFn } = cdn(table);
    const records = await probeTree(
      [
        {
          url: 'https://esm.sh/react-chartjs-2@5.3.1?external=chart.js,react,react-dom',
          kind: 'module',
        },
      ],
      fetchFn,
      OPTS,
    );
    expect(records).toHaveLength(5);
    // The record itself still has the problem (the React template's rule).
    expect(treeProblems(records, short)).toHaveLength(2);
    const f = caseFindings(
      records,
      new Set(['react', 'react-dom', 'chart.js', 'react-chartjs-2']),
      short,
    );
    expect(f.problems).toEqual([]);
    expect(f.notes).toEqual([
      '/immer@^11.0.0?target=es2022: immer by range, not in the manifest; cached 600 s, so it outlasts a CDN outage by that long only',
      '/node/process.mjs: a Node polyfill; cached 86400 s, so it outlasts a CDN outage by that long only',
    ]);
  });

  it('keeps a manifest package reached by range a problem: a second copy (CI run 60)', async () => {
    const { fetchFn } = cdn(table);
    const records = await probeTree(
      [{ url: 'https://esm.sh/chart.js@^4.1.1?target=es2022', kind: 'module' }],
      fetchFn,
      OPTS,
    );
    const f = caseFindings(
      records,
      new Set(['react', 'react-dom', 'chart.js', 'react-chartjs-2']),
      short,
    );
    expect(f.problems).toEqual([
      "/chart.js@^4.1.1?target=es2022: chart.js is in the manifest but imported by range (^4.1.1): a second copy, not the import map's",
      '/chart.js@^4.1.1?target=es2022: Cache-Control "public, max-age=600": needs max-age ≥ 30 days to outlast a CDN outage',
    ]);
  });
});
