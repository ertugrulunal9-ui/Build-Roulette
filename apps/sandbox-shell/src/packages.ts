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
 * Both follow a module's own imports from the CDN's origin (T-035): esm.sh answers
 * `/react@19.3.0` with a few lines that re-export an internal build path
 * (`/react@19.3.0/es2022/react.mjs`), and that path is what really runs. @br/pkg-cdn serves
 * React as one module, so there is nothing more to follow there. A failure behind an entry
 * URL is reported under the entry URL: the package the build imports.
 *
 * Nothing here can put content into the cache: only the CDN's own responses are stored, as
 * for any page fetch. Cache Storage and service workers are not used (the build could write
 * to them, see docs/03), and the shell's wipe still removes them.
 */
import {
  describePackageFailures,
  describePackageStall,
  errorDetail,
  moduleImportUrls,
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
 * Most module URLs followed behind the entry URLs, per check and per warm-up. esm.sh's React
 * set is a handful of modules; a package with a deeper graph is followed this far, which is
 * enough to name it.
 */
export const MAX_FOLLOWED = 64;

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

type Fetched = { ok: true; imports: string[] } | { ok: false; failure: PackageFailure };

/** One request through the HTTP cache, read to the end; on success, its same-origin imports. */
async function fetchModule(url: string, fetchFn: FetchLike, signal: AbortSignal): Promise<Fetched> {
  try {
    // Same request as the module loader's for a cross-origin URL: CORS, no credentials.
    const res = await fetchFn(url, { cache: 'force-cache', credentials: 'same-origin', signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = errorDetail(body);
      return {
        ok: false,
        failure: { url, kind: 'http', status: res.status, ...(detail ? { detail } : {}) },
      };
    }
    // Read to the end, so a copy that came from the network is stored whole.
    const body = await res.text();
    return { ok: true, imports: moduleImportUrls(body, res.url || url, MAX_FOLLOWED) };
  } catch {
    return { ok: false, failure: { url, kind: signal.aborted ? 'timeout' : 'unreachable' } };
  }
}

/**
 * Checks one URL through the HTTP cache, then the modules it imports from the CDN's origin,
 * level by level, within `timeoutMs` in all. Null when every one is available, else the
 * first failure, reported for `url`. `seen` (URLs this call or a sibling check already has)
 * and `budget` (how many more imports may be followed) are shared by `checkPackages`.
 */
export async function checkPackage(
  url: string,
  fetchFn: FetchLike,
  timeoutMs = CHECK_TIMEOUT_MS,
  seen: Set<string> = new Set([url]),
  budget = { left: MAX_FOLLOWED },
): Promise<PackageFailure | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    let level = [url];
    while (level.length > 0) {
      const results = await Promise.all(level.map((u) => fetchModule(u, fetchFn, ctrl.signal)));
      const next: string[] = [];
      for (const r of results) {
        if (!r.ok) return { ...r.failure, url };
        for (const dep of r.imports) {
          if (seen.has(dep) || budget.left <= 0) continue;
          seen.add(dep);
          budget.left--;
          next.push(dep);
        }
      }
      level = next;
    }
    return null;
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
  const seen = new Set(urls);
  const budget = { left: MAX_FOLLOWED };
  const results = await Promise.all(
    urls.map((u) => checkPackage(u, fetchFn, timeoutMs, seen, budget)),
  );
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
 * Fetches each URL not warmed yet into the HTTP cache, with the modules it imports from the
 * CDN's origin (at most `MAX_FOLLOWED` of those per call), one request after another.
 * `warmed` belongs to the shell realm (a new preview iframe starts empty); a URL whose module
 * or imports failed is tried again by the next warm-up. Returns the requests that succeeded.
 */
export async function warmPackages(
  urls: readonly string[],
  fetchFn: FetchLike,
  warmed: Set<string>,
  timeoutMs = CHECK_TIMEOUT_MS * 5,
): Promise<number> {
  let fetched = 0;
  let followed = 0;
  for (const url of urls) {
    if (warmed.has(url) || !/^https?:\/\//.test(url)) continue;
    warmed.add(url);
    const tree = [url];
    let failed = false;
    for (let i = 0; i < tree.length && !failed; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        ctrl.abort();
      }, timeoutMs);
      const r = await fetchModule(tree[i] ?? url, fetchFn, ctrl.signal);
      clearTimeout(timer);
      if (!r.ok) {
        failed = true;
        continue;
      }
      fetched++;
      for (const dep of r.imports) {
        if (warmed.has(dep) || followed >= MAX_FOLLOWED) continue;
        warmed.add(dep);
        followed++;
        tree.push(dep);
      }
    }
    if (failed) for (const u of tree) warmed.delete(u);
  }
  return fetched;
}
