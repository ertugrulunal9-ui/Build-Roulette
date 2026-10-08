/**
 * Reading the ISR cache from the outside (T-026), the same way on `next start` and on the
 * Workers preview (`E2E_APP_SERVER=workers`). No test-only code in the app: only the headers
 * both servers already send.
 */
import { createHash } from 'node:crypto';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

/**
 * `HIT`, `STALE` or `MISS` for an ISR page or route, null for a dynamic one. `next start`
 * sends `x-nextjs-cache`. On Workers, OpenNext's cache interceptor answers cached copies
 * itself (`x-opennext-cache`), and a miss reaches Next (`x-nextjs-cache: MISS`).
 */
export function cacheStatus(res: APIResponse): string | null {
  const h = res.headers();
  return h['x-opennext-cache'] ?? h['x-nextjs-cache'] ?? null;
}

/**
 * The `s-maxage` of the response, in seconds: how long the cached copy is fresh (on Workers,
 * the time it has left), or null without one.
 */
export function sMaxAge(res: APIResponse): number | null {
  const m = /s-maxage=(\d+)/.exec(res.headers()['cache-control'] ?? '');
  return m?.[1] ? Number(m[1]) : null;
}

/** A short hash of the response body (to compare two renders of an image). */
export async function bodyHash(res: APIResponse): Promise<string> {
  return createHash('sha256')
    .update(await res.body())
    .digest('hex')
    .slice(0, 16);
}

/** The runtime under test, for messages. */
export const APP_SERVER = process.env['E2E_APP_SERVER'] === 'workers' ? 'workers' : 'next start';

/**
 * Requests `path` until the answer comes from the cache, and returns that answer. The first
 * request of a page renders it; the copy is stored right after the response (on Workers in
 * `waitUntil`), and a copy past its `revalidate` time is served once more while it
 * regenerates, so the hit may take a request or two.
 */
export async function cachedCopy(request: APIRequestContext, path: string): Promise<APIResponse> {
  const seen: { last?: APIResponse } = {};
  await expect
    .poll(
      async () => {
        seen.last = await request.get(path);
        return cacheStatus(seen.last);
      },
      { message: `${path} served from the cache`, timeout: 15_000, intervals: [250] },
    )
    .toBe('HIT');
  if (!seen.last) throw new Error(`${path}: no response`);
  return seen.last;
}
