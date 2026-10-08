import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
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
