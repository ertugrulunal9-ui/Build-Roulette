/**
 * The build's packages and the browser's HTTP cache (T-032, docs/03 "Package cache and CDN
 * outages").
 *
 * The build frame is this shell's same-origin child, so the shell's `fetch` uses the same
 * HTTP-cache partition (top-level app site + shell site) as the build's module imports. The
 * shell uses that for two things, and only for those:
 *
 * - **Warm-up:** after a build ran, the template's import map entries (the React set at its
 *   pinned version: `TEMPLATE_SPECIFIERS`) and the URLs the build imports (the load's
 *   `packages` hint) are fetched once per shell realm with `cache: 'force-cache'`, with
 *   everything they import, so the whole set sits in this partition before an outage, not
 *   only the entry points the template happened to import. The URLs are exact versions served
 *   `immutable`, so a cached copy is used without asking the CDN.
 * - **Diagnosis:** when the module graph fails to load (the `<script>`'s `error` event says
 *   nothing about which URL failed) or is still waiting after `STALL_MS`, the build's own
 *   package URLs (the load's `packages` hint), then the template's entries, are checked
 *   the same way: a cached copy answers at once, anything else goes to the network and fails,
 *   errors or hangs. Those are named: "Package server unreachable: zustand@5.0.15".
 *
 * Both follow a module's own imports from the CDN's origin (T-035): esm.sh answers
 * `/react@19.3.0` with a few lines that re-export an internal build path
 * (`/react@19.3.0/es2022/react.mjs`), and that path is what really runs. @br/pkg-cdn serves
 * each package as one module. Since T-040 every package of the manifest is external in every
 * CDN module, so a module's bare imports (`three` inside `@react-three/fiber`, `scheduler`
 * inside `react-dom/client`) are followed too, through the import map, as the browser
 * resolves them. A failure behind an entry URL is reported under the entry URL: the package
 * the build imports. An import map entry nothing imports (a package of the manifest the build
 * does not use, or one that is only CSS) is neither warmed nor blamed.
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
  staticImports,
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
 * An import map value that is a module URL to warm and check: http(s), and not a prefix
 * entry's (`"three/": "…/three@0.186.1&external=…/"`, T-040), which only resolves subpaths a
 * module imports and is not a module itself.
 */
export function isModuleUrl(url: string): boolean {
  return /^https?:\/\//.test(url) && !url.endsWith('/');
}

/**
 * The template's import map entries: the runtime's React set (`IMPORT_MAP_SPECIFIERS` in
 * @br/runtime). Warmed after every build whether the build imports them or not (T-032), and
 * checked when nothing the build imports explains a failure.
 */
export const TEMPLATE_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'scheduler',
] as const;

/** The module URLs of the template's entries in an import map. */
export function templateUrls(importMap: ImportMap): string[] {
  return TEMPLATE_SPECIFIERS.flatMap((k) => {
    const url = Object.prototype.hasOwnProperty.call(importMap.imports, k)
      ? importMap.imports[k]
      : undefined;
    return url !== undefined && isModuleUrl(url) ? [url] : [];
  });
}

/**
 * A bare specifier resolved with an import map's `imports` as the browser does: its own entry,
 * else the longest prefix entry (`"three/"`) with the rest appended. Null when unmapped.
 */
export function resolveWithImportMap(specifier: string, importMap: ImportMap): string | null {
  const own = (k: string) =>
    Object.prototype.hasOwnProperty.call(importMap.imports, k) ? importMap.imports[k] : undefined;
  const exact = own(specifier);
  if (exact !== undefined) return exact;
  let best = '';
  for (const key of Object.keys(importMap.imports)) {
    if (key.endsWith('/') && specifier.startsWith(key) && key.length > best.length) best = key;
  }
  const prefix = best === '' ? undefined : own(best);
  if (prefix === undefined) return null;
  try {
    return new URL(specifier.slice(best.length), prefix).href;
  } catch {
    return null;
  }
}

/**
 * The modules a CDN module loads: its static imports on the CDN's own origin, and (with an
 * import map) its bare imports as the import map resolves them, at most `MAX_FOLLOWED`.
 */
export function moduleImports(body: string, url: string, importMap?: ImportMap): string[] {
  const out = new Set(moduleImportUrls(body, url, MAX_FOLLOWED));
  if (importMap === undefined) return [...out];
  for (const spec of staticImports(body, MAX_FOLLOWED * 4)) {
    if (out.size >= MAX_FOLLOWED) break;
    if (/^(?:\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i.test(spec)) continue;
    const resolved = resolveWithImportMap(spec, importMap);
    if (resolved !== null && isModuleUrl(resolved)) out.add(resolved);
  }
  return [...out];
}

/**
 * What to warm after a build ran: the template's entries and the URLs the build imports (the
 * `packages` hint; without one, every module URL of the import map, as before T-040).
 */
export function warmRoots(importMap: ImportMap, packages: readonly string[] | undefined): string[] {
  const roots = [
    ...templateUrls(importMap),
    ...(packages ?? Object.values(importMap.imports)),
  ].filter(isModuleUrl);
  return [...new Set(roots)];
}

/**
 * What to check for a load: `primary` are the URLs the bundle imports itself (the load's
 * `packages` hint); `secondary` the template's entries (`TEMPLATE_SPECIFIERS`). Without a
 * hint, the import map is primary. http(s) only, deduplicated, at most `max` in all. A
 * module's imports are followed through `importMap` (T-040), so a package that only another
 * package imports (`three` inside `@react-three/fiber`) is checked behind it.
 */
export interface PackageCandidates {
  primary: string[];
  secondary: string[];
  importMap?: ImportMap;
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
      if (!isModuleUrl(url) || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  };
  if (packages === undefined) {
    return { primary: take(Object.values(importMap.imports)), secondary: [], importMap };
  }
  const primary = take(packages);
  return { primary, secondary: take(templateUrls(importMap)), importMap };
}

type Fetched = { ok: true; imports: string[] } | { ok: false; failure: PackageFailure };

/** One request through the HTTP cache, read to the end; on success, the modules it imports. */
async function fetchModule(
  url: string,
  fetchFn: FetchLike,
  signal: AbortSignal,
  importMap?: ImportMap,
): Promise<Fetched> {
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
    return { ok: true, imports: moduleImports(body, res.url || url, importMap) };
  } catch {
    return { ok: false, failure: { url, kind: signal.aborted ? 'timeout' : 'unreachable' } };
  }
}

/**
 * Checks one URL through the HTTP cache, then the modules it imports (from the CDN's origin,
 * and through `importMap` for bare imports), level by level, within `timeoutMs` in all. Null
 * when every one is available, else the first failure, reported for `url`. `seen` (URLs this
 * call or a sibling check already has) and `budget` (how many more imports may be followed)
 * are shared by `checkPackages`.
 */
export async function checkPackage(
  url: string,
  fetchFn: FetchLike,
  timeoutMs = CHECK_TIMEOUT_MS,
  seen = new Set<string>([url]),
  budget = { left: MAX_FOLLOWED },
  importMap?: ImportMap,
): Promise<PackageFailure | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    let level = [url];
    while (level.length > 0) {
      const results = await Promise.all(
        level.map((u) => fetchModule(u, fetchFn, ctrl.signal, importMap)),
      );
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
  importMap?: ImportMap,
): Promise<PackageFailure[]> {
  const seen = new Set(urls);
  const budget = { left: MAX_FOLLOWED };
  const results = await Promise.all(
    urls.map((u) => checkPackage(u, fetchFn, timeoutMs, seen, budget, importMap)),
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
  const primary = (await checkPackages(c.primary, fetchFn, timeoutMs, c.importMap)).filter(counts);
  if (primary.length > 0 || c.secondary.length === 0) return primary;
  return (await checkPackages(c.secondary, fetchFn, timeoutMs, c.importMap)).filter(counts);
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
 * Fetches each URL not warmed yet into the HTTP cache, with the modules it imports (from the
 * CDN's origin, and through `importMap` for bare imports; at most `MAX_FOLLOWED` of those per
 * call), one request after another.
 * `warmed` belongs to the shell realm (a new preview iframe starts empty); a URL whose module
 * or imports failed is tried again by the next warm-up. Returns the requests that succeeded.
 */
export async function warmPackages(
  urls: readonly string[],
  fetchFn: FetchLike,
  warmed: Set<string>,
  timeoutMs = CHECK_TIMEOUT_MS * 5,
  importMap?: ImportMap,
): Promise<number> {
  let fetched = 0;
  let followed = 0;
  for (const url of urls) {
    if (warmed.has(url) || !isModuleUrl(url)) continue;
    warmed.add(url);
    const tree = [url];
    let failed = false;
    for (let i = 0; i < tree.length && !failed; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        ctrl.abort();
      }, timeoutMs);
      const r = await fetchModule(tree[i] ?? url, fetchFn, ctrl.signal, importMap);
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
