import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
  MAX_FOLLOWED,
  checkPackage,
  explainLoadFailure,
  explainStall,
  packageCandidates,
  warmPackages,
  type FetchLike,
} from '../src/packages';

const CDN = 'https://pkg.example';
const REACT = `${CDN}/react@19.3.0`;
const CLIENT = `${CDN}/react-dom@19.3.0/client?external=react,react-dom`;
const ZUSTAND = `${CDN}/zustand@5.0.15?external=react,react-dom`;
const IMPORT_MAP = { imports: { react: REACT, 'react-dom/client': CLIENT } };

/**
 * A fake `fetch` over an HTTP cache: cached URLs answer 200, others go to "the network",
 * which is down (`refuse`), answers an error, or never answers (`hang`, aborted by the signal).
 */
function fakeFetch(
  cached: ReadonlySet<string>,
  network: 'up' | 'refuse' | 'hang' | { status: number; body: string },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, init });
    if (cached.has(url) || network === 'up') return Promise.resolve(new Response('code'));
    if (network === 'refuse') return Promise.reject(new TypeError('Failed to fetch'));
    if (network === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return Promise.resolve(new Response(network.body, { status: network.status }));
  };
  return { fn, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('packageCandidates', () => {
  it('puts the build packages first and the rest of the import map second', () => {
    expect(packageCandidates(IMPORT_MAP, [ZUSTAND, REACT, 'blob:x', 'javascript:1'])).toEqual({
      primary: [ZUSTAND, REACT],
      secondary: [CLIENT],
    });
    expect(packageCandidates(IMPORT_MAP, undefined)).toEqual({
      primary: [REACT, CLIENT],
      secondary: [],
    });
    expect(packageCandidates(IMPORT_MAP, [ZUSTAND], 2)).toEqual({
      primary: [ZUSTAND],
      secondary: [REACT],
    });
  });
});

describe('checkPackage', () => {
  it('asks the HTTP cache first, with the module loader’s credentials mode', async () => {
    const { fn, calls } = fakeFetch(new Set([REACT]), 'refuse');
    expect(await checkPackage(REACT, fn)).toBeNull();
    expect(calls[0]?.init).toMatchObject({ cache: 'force-cache', credentials: 'same-origin' });
  });

  it('tells no answer, a late answer and an HTTP error apart', async () => {
    expect(await checkPackage(ZUSTAND, fakeFetch(new Set(), 'refuse').fn)).toEqual({
      url: ZUSTAND,
      kind: 'unreachable',
    });
    const pending = checkPackage(ZUSTAND, fakeFetch(new Set(), 'hang').fn);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await pending).toEqual({ url: ZUSTAND, kind: 'timeout' });
    expect(
      await checkPackage(
        ZUSTAND,
        fakeFetch(new Set(), { status: 404, body: 'mock-cdn: not available\nx' }).fn,
      ),
    ).toEqual({ url: ZUSTAND, kind: 'http', status: 404, detail: 'mock-cdn: not available' });
  });
});

describe('explainLoadFailure', () => {
  it('names the package that is not cached while the CDN is down', async () => {
    const { fn } = fakeFetch(new Set([REACT, CLIENT]), 'refuse');
    const text = await explainLoadFailure(packageCandidates(IMPORT_MAP, [ZUSTAND, CLIENT]), fn);
    expect(text?.split('\n')[0]).toBe('Package server unreachable: zustand@5.0.15');
  });

  it('blames an import map entry the bundle does not import only when nothing else failed', async () => {
    // react@19.3.0 itself is not cached (the build imports react-dom/client, which imports it).
    const { fn, calls } = fakeFetch(new Set([CLIENT, ZUSTAND]), 'refuse');
    const c = packageCandidates(IMPORT_MAP, [ZUSTAND, CLIENT]);
    expect((await explainLoadFailure(c, fn))?.split('\n')[0]).toBe(
      'Package server unreachable: react@19.3.0',
    );
    expect(calls.map((x) => x.url)).toEqual([ZUSTAND, CLIENT, REACT]);
  });

  it('is null when every package is available (the failure is something else)', async () => {
    const { fn } = fakeFetch(new Set([REACT, CLIENT, ZUSTAND]), 'refuse');
    expect(await explainLoadFailure(packageCandidates(IMPORT_MAP, [ZUSTAND]), fn)).toBeNull();
  });

  it('gives up on a check after the timeout, so it never hangs', async () => {
    const { fn } = fakeFetch(new Set([REACT]), 'hang');
    const pending = explainLoadFailure({ primary: [ZUSTAND, REACT], secondary: [] }, fn);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect((await pending)?.split('\n')[0]).toBe('Package server not responding: zustand@5.0.15');
  });
});

describe('explainStall', () => {
  it('names what is still pending, and nothing when nothing is', async () => {
    const hanging = explainStall(
      packageCandidates(IMPORT_MAP, [ZUSTAND, REACT]),
      8000,
      fakeFetch(new Set([REACT, CLIENT]), 'hang').fn,
    );
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await hanging).toBe(
      'Still waiting for the package server after 8 s: zustand@5.0.15\nThe preview starts as soon as it answers.',
    );
    const none = explainStall(
      packageCandidates(IMPORT_MAP, [REACT]),
      8000,
      fakeFetch(new Set([REACT, CLIENT]), 'hang').fn,
    );
    expect(await none).toBeNull();
  });
});

describe('warmPackages', () => {
  it('fetches each URL once per realm and retries the ones that failed', async () => {
    const warmed = new Set<string>();
    const down = fakeFetch(new Set([REACT]), 'refuse');
    expect(await warmPackages([REACT, CLIENT, 'blob:x'], down.fn, warmed)).toBe(1);
    expect(down.calls.map((c) => c.url)).toEqual([REACT, CLIENT]);
    expect(down.calls[0]?.init.cache).toBe('force-cache');
    expect([...warmed]).toEqual([REACT]);
    const up = fakeFetch(new Set(), 'up');
    expect(await warmPackages([REACT, CLIENT], up.fn, warmed)).toBe(1);
    expect(up.calls.map((c) => c.url)).toEqual([CLIENT]);
    expect(await warmPackages([REACT, CLIENT], up.fn, warmed)).toBe(0);
  });
});

/**
 * esm.sh's shape (T-035): an entry URL answers with a few lines that re-export internal build
 * paths on the same origin, and those are the modules that really run.
 */
describe('modules behind an entry URL (esm.sh)', () => {
  const ESM = 'https://esm.sh';
  const E_REACT = `${ESM}/react@19.3.0`;
  const E_REACT_MJS = `${ESM}/react@19.3.0/es2022/react.mjs`;
  const E_CLIENT = `${ESM}/react-dom@19.3.0/client?external=react,react-dom`;
  const E_CLIENT_MJS = `${ESM}/react-dom@19.3.0/X-ZXJlYWN0LHJlYWN0LWRvbQ/es2022/client.mjs`;
  const E_SCHEDULER = `${ESM}/scheduler@0.27.0/es2022/scheduler.mjs`;
  const BODIES: Record<string, string> = {
    [E_REACT]: `/* esm.sh - react@19.3.0 */\nexport * from "/react@19.3.0/es2022/react.mjs";\nexport { default } from "/react@19.3.0/es2022/react.mjs";\n`,
    [E_REACT_MJS]: 'var e={};export{e as default};',
    [E_CLIENT]: `/* esm.sh - react-dom@19.3.0/client */\nexport * from "/react-dom@19.3.0/X-ZXJlYWN0LHJlYWN0LWRvbQ/es2022/client.mjs";\n`,
    // Bare `react` is the import map's; another origin is not followed.
    [E_CLIENT_MJS]:
      'import*as r from"react";import"/scheduler@0.27.0/es2022/scheduler.mjs";import"https://other.example/x.mjs";var a=1;',
    [E_SCHEDULER]: 'export var x=1;',
  };
  const MAP = { imports: { react: E_REACT, 'react-dom/client': E_CLIENT } };

  /** Like `fakeFetch`, with module bodies. `network`: what an uncached URL gets. */
  function esmFetch(
    cached: readonly string[],
    network: 'up' | 'refuse' | 'hang' | { status: number; body: string },
  ) {
    const calls: string[] = [];
    const fn: FetchLike = (url, init) => {
      calls.push(url);
      if (cached.includes(url) || network === 'up') {
        return Promise.resolve(new Response(BODIES[url] ?? 'export {};'));
      }
      if (network === 'refuse') return Promise.reject(new TypeError('Failed to fetch'));
      if (network === 'hang') {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(new Response(network.body, { status: network.status }));
    };
    return { fn, calls };
  }

  it('checks the internal modules too, and names the entry the build imports', async () => {
    const { fn, calls } = esmFetch(Object.keys(BODIES), 'refuse');
    expect(await checkPackage(E_CLIENT, fn)).toBeNull();
    expect(calls).toEqual([E_CLIENT, E_CLIENT_MJS, E_SCHEDULER]);

    // The entry is cached (warmed), the module behind it is not, and the CDN is down.
    const missing = esmFetch([E_CLIENT], 'refuse');
    expect(await checkPackage(E_CLIENT, missing.fn)).toEqual({
      url: E_CLIENT,
      kind: 'unreachable',
    });
    const http = esmFetch([E_CLIENT, E_CLIENT_MJS], {
      status: 500,
      body: '/* esm.sh - error */\nthrow new Error("[esm.sh] build failed");',
    });
    expect(await checkPackage(E_CLIENT, http.fn)).toEqual({
      url: E_CLIENT,
      kind: 'http',
      status: 500,
      detail: '[esm.sh] build failed',
    });
  });

  it('gives the whole chain one timeout', async () => {
    const { fn } = esmFetch([E_CLIENT], 'hang');
    const pending = checkPackage(E_CLIENT, fn);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await pending).toEqual({ url: E_CLIENT, kind: 'timeout' });
  });

  it('explains a load failure and a stall behind a cached entry URL', async () => {
    const c = packageCandidates(MAP, [E_CLIENT]);
    const down = esmFetch([E_REACT, E_REACT_MJS, E_CLIENT, E_CLIENT_MJS], 'refuse');
    expect((await explainLoadFailure(c, down.fn))?.split('\n')[0]).toBe(
      'Package server unreachable: react-dom@19.3.0/client',
    );
    const stalled = explainStall(c, 8000, esmFetch([E_CLIENT], 'hang').fn);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect((await stalled)?.split('\n')[0]).toBe(
      'Still waiting for the package server after 8 s: react-dom@19.3.0/client',
    );
  });

  it('checks a module shared by two entries once', async () => {
    const twin = `${ESM}/react@19.3.0/jsx-runtime?external=react,react-dom`;
    BODIES[twin] = 'export * from "/react@19.3.0/es2022/react.mjs";';
    try {
      const { fn, calls } = esmFetch(Object.keys(BODIES), 'refuse');
      expect(await explainLoadFailure({ primary: [E_REACT, twin], secondary: [] }, fn)).toBeNull();
      expect(calls.filter((u) => u === E_REACT_MJS)).toHaveLength(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete BODIES[twin];
    }
  });

  it('follows at most MAX_FOLLOWED imports per check', async () => {
    const chain = (i: number) => `/deep@1.0.0/es2022/m${String(i)}.mjs`;
    const fn = vi.fn<FetchLike>((url) => {
      const i = url === E_REACT ? -1 : Number(/m(\d+)\.mjs$/.exec(url)?.[1]);
      return Promise.resolve(new Response(`import "${chain(i + 1)}";`));
    });
    expect(await checkPackage(E_REACT, fn)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(MAX_FOLLOWED + 1);
  });

  it('warms the internal modules with the entry URLs, and retries a tree that failed', async () => {
    const warmed = new Set<string>();
    const down = esmFetch([E_REACT, E_REACT_MJS, E_CLIENT], 'refuse');
    // react and its module are fetched; client's module fails, so client is retried later.
    expect(await warmPackages([E_REACT, E_CLIENT], down.fn, warmed)).toBe(3);
    expect(down.calls).toEqual([E_REACT, E_REACT_MJS, E_CLIENT, E_CLIENT_MJS]);
    expect([...warmed].sort()).toEqual([E_REACT, E_REACT_MJS].sort());

    const up = esmFetch([], 'up');
    expect(await warmPackages([E_REACT, E_CLIENT], up.fn, warmed)).toBe(3);
    expect(up.calls).toEqual([E_CLIENT, E_CLIENT_MJS, E_SCHEDULER]);
    expect(warmed.has('https://other.example/x.mjs')).toBe(false);
    expect(await warmPackages([E_REACT, E_CLIENT], up.fn, warmed)).toBe(0);
  });
});
