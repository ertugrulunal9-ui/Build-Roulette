/**
 * The build's packages and the browser's HTTP cache (T-032, docs/03 "Package cache and CDN
 * outages").
 *
 * The build frame is this shell's same-origin child, so the shell's `fetch` uses the same
 * HTTP-cache partition (top-level app site + shell site) as the build's module imports. The
 * shell uses that for two things, and only for those:
 *
 * - **Warm-up:** after a build ran, every URL of its import map (React's entry points at the
 *   template's pinned version) is fetched once per shell realm with `cache: 'force-cache'`,
 *   so the whole set sits in this partition before an outage, not only the entry points the
 *   template happened to import. The URLs are exact versions served `immutable`, so a cached
 *   copy is used without asking the CDN.
 * - **Diagnosis:** when the module graph fails to load (the `<script>`'s `error` event says
 *   nothing about which URL failed) or is still waiting after `STALL_MS`, the build's own
 *   package URLs (the load's `packages` hint), then the rest of the import map, are checked
 *   the same way: a cached copy answers at once, anything else goes to the network and fails,
 *   errors or hangs. Those are named: "Package server unreachable: zustand@5.0.15".
 *
 * Nothing here can put content into the cache: only the CDN's own responses are stored, as
 * for any page fetch. Cache Storage and service workers are not used (the build could write
 * to them, see docs/03), and the shell's wipe still removes them.
 */
import {
  describePackageFailures,
  describePackageStall,
  errorDetail,
  type ImportMap,
  type PackageFailure,
} from '@br/protocol';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** How long one URL check may take before it counts as `timeout`. */
export const CHECK_TIMEOUT_MS = 3000;
/** A module graph that has neither loaded nor failed after this long gets a "still waiting" note. */
export const STALL_MS = 8000;
/** Delay between a build's `load` and the warm-up, so the warm-up never competes with it. */
export const WARM_DELAY_MS = 1000;
/** Most URLs checked per load. */
export const MAX_CHECKS = 64;

/**
 * What to check for a load: `primary` are the URLs the bundle imports itself (the load's
 * `packages` hint); `secondary` the rest of the import map, which only CDN modules import
 * (`react-dom/client` imports `react-dom`). Without a hint, the import map is primary.
 * http(s) only, deduplicated, at most `max` in all.
 */
export interface PackageCandidates {
  primary: string[];
  secondary: string[];
}

export function packageCandidates(
  importMap: ImportMap,
  packages: readonly string[] | undefined,
  max = MAX_CHECKS,
): PackageCandidates {
  const seen = new Set<string>();
  const take = (urls: readonly string[]) => {
    const out: string[] = [];
    for (const url of urls) {
      if (seen.size >= max) break;
      if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  };
  const mapped = Object.values(importMap.imports);
  if (packages === undefined) return { primary: take(mapped), secondary: [] };
  const primary = take(packages);
  return { primary, secondary: take(mapped) };
}

/** Checks one URL through the HTTP cache: null when it is available, else how it failed. */
export async function checkPackage(
  url: string,
  fetchFn: FetchLike,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<PackageFailure | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    // Same request as the module loader's for a cross-origin URL: CORS, no credentials.
    const res = await fetchFn(url, {
      cache: 'force-cache',
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = errorDetail(body);
      return { url, kind: 'http', status: res.status, ...(detail ? { detail } : {}) };
    }
    // Read it to the end, so a copy that came from the network is stored whole.
    await res.arrayBuffer();
    return null;
  } catch {
    return ctrl.signal.aborted ? { url, kind: 'timeout' } : { url, kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks every URL at once and returns the failures, in the order of `urls`. */
export async function checkPackages(
  urls: readonly string[],
  fetchFn: FetchLike,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<PackageFailure[]> {
  const results = await Promise.all(urls.map((u) => checkPackage(u, fetchFn, timeoutMs)));
  return results.filter((r): r is PackageFailure => r !== null);
}

/**
 * Checks the primary URLs, then (only when none of them failed) the secondary ones, so an
 * import map entry the bundle does not use is only blamed when nothing else explains it.
 */
async function firstFailures(
  c: PackageCandidates,
  fetchFn: FetchLike,
  timeoutMs: number,
  counts: (f: PackageFailure) => boolean,
): Promise<PackageFailure[]> {
  const primary = (await checkPackages(c.primary, fetchFn, timeoutMs)).filter(counts);
  if (primary.length > 0 || c.secondary.length === 0) return primary;
  return (await checkPackages(c.secondary, fetchFn, timeoutMs)).filter(counts);
}

/** Why the module graph did not load, or null when every package is available. */
export async function explainLoadFailure(
  c: PackageCandidates,
  fetchFn: FetchLike,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<string | null> {
  return describePackageFailures(await firstFailures(c, fetchFn, timeoutMs, () => true));
}

/**
 * What a module graph that is still loading after `waitedMs` waits for: the URLs whose check
 * timed out too. Null when nothing is pending (it may be evaluating, or awaiting something
 * that is not a package).
 */
export async function explainStall(
  c: PackageCandidates,
  waitedMs: number,
  fetchFn: FetchLike,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<string | null> {
  const pending = await firstFailures(c, fetchFn, timeoutMs, (f) => f.kind === 'timeout');
  return describePackageStall(
    pending.map((f) => f.url),
    waitedMs,
  );
}

/**
 * Fetches each URL not warmed yet into the HTTP cache, one after another. `warmed` belongs to
 * the shell realm (a new preview iframe starts empty); a URL that fails is tried again by the
 * next warm-up.
 */
export async function warmPackages(
  urls: readonly string[],
  fetchFn: FetchLike,
  warmed: Set<string>,
  timeoutMs = CHECK_TIMEOUT_MS * 5,
): Promise<number> {
  let fetched = 0;
  for (const url of urls) {
    if (warmed.has(url) || !/^https?:\/\//.test(url)) continue;
    warmed.add(url);
    const failure = await checkPackage(url, fetchFn, timeoutMs);
    if (failure) warmed.delete(url);
    else fetched++;
  }
  return fetched;
}
