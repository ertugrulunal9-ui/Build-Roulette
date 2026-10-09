/**
 * esm.sh-compatible request URLs:
 *
 *   /<name>[@<version|range|tag>][/<subpath>][?external=a,b][&deps=x@1.2.3][&target=es2022][&dev]
 *
 * - `name` may be scoped (`/@scope/name@1.2.3/sub`).
 * - A missing version means `latest`. Anything that is not an exact version is resolved and
 *   redirected to the exact-version URL.
 * - `external`: packages (and their subpaths) left as bare imports so the page's import map
 *   resolves them (React single instance, docs/03 §3.4).
 * - `deps`: pins the version of peer dependencies that are emitted as CDN URLs.
 * - `target`: esbuild target, from a fixed set. `dev`: development build (unminified,
 *   `process.env.NODE_ENV = "development"`).
 * Other query parameters are ignored (and preserved on redirects).
 *
 * The query may also be written in the path, after the version (`/three@0.186.1&external=a,b/
 * examples/x.js`), the form esm.sh documents for import-map prefixes ("change the query prefix
 * `?` to `&` and put it after the package version"): an import map appends a specifier's rest
 * to its prefix, so a `?query` there would end up in front of the subpath (T-040). Like
 * esm.sh, it is read as a query string after the path is decoded once (a scoped name's `/` is
 * sent as `%252F`), and comes before the URL's own query.
 */
import semver from 'semver';
import { CdnError } from './errors';
import { validatePackageName } from './names';

export const BUILD_TARGETS = ['es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'esnext'] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];
export const DEFAULT_TARGET: BuildTarget = 'es2022';

/** The bridge's URL limit (`@br/protocol` `LIMITS.importMapValueMaxChars`). */
const MAX_PATH_LENGTH = 2048;
const MAX_VERSION_SPEC_LENGTH = 128;
/**
 * The runtime sends at most 32 (`MAX_CDN_EXTERNALS`); a peer URL this CDN emits adds the
 * requesting package (bundler.ts).
 */
const MAX_EXTERNALS = 33;
const MAX_DEPS = 32;
const DIST_TAG_RE = /^[a-z][a-z0-9._-]*$/i;
const SUBPATH_SEGMENT_RE = /^[\w@~+=,.!$&'()-]+$/;

export type VersionSpec =
  | { kind: 'exact'; version: string }
  | { kind: 'range'; range: string }
  | { kind: 'tag'; tag: string };

export interface PackageRef {
  name: string;
  /** The raw version text from the URL ('' when absent). */
  versionText: string;
  version: VersionSpec;
  /** '' or '/sub/path' */
  subpath: string;
  /**
   * The query written in the path after the version (`&external=a,b`, without the `&`),
   * decoded once like the rest of the path: a raw query string. '' when there is none.
   */
  pathQuery: string;
}

export interface CdnQuery {
  /** Sorted, de-duplicated package names. */
  external: string[];
  /** Sorted `name@version` pins (exact versions only). */
  deps: Record<string, string>;
  target: BuildTarget;
  dev: boolean;
  /** `?module`: serve `.json` subpaths as an ES module instead of raw JSON. */
  module: boolean;
}

export interface CdnRequest extends PackageRef {
  query: CdnQuery;
}

function bad(message: string): CdnError {
  return new CdnError(400, 'bad-request', message);
}

/** Classifies the version part of a URL. `''` is the `latest` tag. */
export function parseVersionSpec(text: string): VersionSpec {
  if (text === '') return { kind: 'tag', tag: 'latest' };
  if (text.length > MAX_VERSION_SPEC_LENGTH) {
    throw new CdnError(400, 'invalid-version', 'version is too long');
  }
  if (semver.valid(text) === text) return { kind: 'exact', version: text };
  if (DIST_TAG_RE.test(text) && semver.validRange(text) === null) return { kind: 'tag', tag: text };
  if (semver.validRange(text) !== null) return { kind: 'range', range: text };
  throw new CdnError(400, 'invalid-version', `"${text}" is not a version, range or dist-tag`);
}

/** Parses the path part (`/name@version/sub`). Throws CdnError(400) on anything else. */
export function parsePackagePath(pathname: string): PackageRef {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    throw bad('URL is not valid percent-encoding');
  }
  if (p.length > MAX_PATH_LENGTH) throw bad('URL path is too long');
  if (!p.startsWith('/')) throw bad('URL path must start with "/"');
  if (p.includes('\0') || p.includes('\\')) throw bad('URL path contains forbidden characters');
  p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  const segments = p.split('/');
  const nameSegments = p.startsWith('@') ? 2 : 1;
  if (segments.length < nameSegments || segments.slice(0, nameSegments).some((s) => s === '')) {
    throw bad('expected /<name>@<version>[/<subpath>]');
  }
  const head = segments.slice(0, nameSegments).join('/');
  const at = head.indexOf('@', 1);
  const name = at === -1 ? head : head.slice(0, at);
  const versionAndQuery = at === -1 ? '' : head.slice(at + 1);
  // `&` is never part of a package name or version: what follows it is the in-path query.
  const amp = versionAndQuery.indexOf('&');
  const versionText = amp === -1 ? versionAndQuery : versionAndQuery.slice(0, amp);
  const pathQuery = amp === -1 ? '' : versionAndQuery.slice(amp + 1);
  const nameError = validatePackageName(name);
  if (nameError !== null)
    throw new CdnError(400, 'invalid-name', `invalid package name: ${nameError}`);
  const version = parseVersionSpec(versionText);
  const rest = segments.slice(nameSegments);
  for (const seg of rest) {
    if (seg === '' || seg === '.' || seg === '..' || !SUBPATH_SEGMENT_RE.test(seg)) {
      throw bad(`invalid subpath segment "${seg}"`);
    }
  }
  return {
    name,
    versionText,
    version,
    subpath: rest.length > 0 ? `/${rest.join('/')}` : '',
    pathQuery,
  };
}

function listParam(params: URLSearchParams, key: string): string[] {
  const out: string[] = [];
  for (const value of params.getAll(key)) {
    for (const item of value.split(',')) {
      const trimmed = item.trim();
      if (trimmed !== '') out.push(trimmed);
    }
  }
  return out;
}

/** Parses the query string. Throws CdnError(400) for invalid values. */
export function parseQuery(params: URLSearchParams): CdnQuery {
  const external = [...new Set(listParam(params, 'external'))].sort();
  if (external.length > MAX_EXTERNALS) throw bad(`at most ${MAX_EXTERNALS} externals`);
  for (const name of external) {
    if (name === '*') throw bad('external=* is not supported; list the packages');
    const err = validatePackageName(name);
    if (err !== null) throw bad(`invalid external "${name}": ${err}`);
  }

  const depsList = listParam(params, 'deps');
  if (depsList.length > MAX_DEPS) throw bad(`at most ${MAX_DEPS} deps`);
  const deps: Record<string, string> = {};
  for (const item of depsList) {
    const at = item.indexOf('@', 1);
    const name = at === -1 ? item : item.slice(0, at);
    const version = at === -1 ? '' : item.slice(at + 1);
    const err = validatePackageName(name);
    if (err !== null) throw bad(`invalid deps entry "${item}": ${err}`);
    if (semver.valid(version) !== version) {
      throw bad(`deps entry "${item}" must pin an exact version (name@1.2.3)`);
    }
    deps[name] = version;
  }
  const sortedDeps: Record<string, string> = {};
  for (const k of Object.keys(deps).sort()) sortedDeps[k] = deps[k] ?? '';

  const targetText = params.get('target') ?? DEFAULT_TARGET;
  if (!(BUILD_TARGETS as readonly string[]).includes(targetText)) {
    throw bad(`target must be one of ${BUILD_TARGETS.join(', ')}`);
  }
  return {
    external,
    deps: sortedDeps,
    target: targetText as BuildTarget,
    dev: params.has('dev'),
    module: params.has('module'),
  };
}

/** The query string a request is read with: the in-path query, then the URL's own (`?…`). */
export function effectiveSearch(ref: Pick<PackageRef, 'pathQuery'>, search: string): string {
  const own = search.startsWith('?') ? search.slice(1) : search;
  const parts = [ref.pathQuery, own].filter((p) => p !== '');
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function parseCdnUrl(pathname: string, search: string): CdnRequest {
  const ref = parsePackagePath(pathname);
  return { ...ref, query: parseQuery(new URLSearchParams(effectiveSearch(ref, search))) };
}

/** Root-relative URL path for a package module: `/name@1.2.3/sub`. */
export function packagePath(name: string, version: string, subpath = ''): string {
  return `/${name}@${version}${subpath}`;
}

/** Query string carried by the URLs this CDN emits for externalized dependencies. */
export function formatQuery(q: Pick<CdnQuery, 'external' | 'deps' | 'target' | 'dev'>): string {
  const parts: string[] = [];
  if (q.external.length > 0) parts.push(`external=${q.external.join(',')}`);
  const deps = Object.entries(q.deps).map(([n, v]) => `${n}@${v}`);
  if (deps.length > 0) parts.push(`deps=${deps.join(',')}`);
  if (q.target !== DEFAULT_TARGET) parts.push(`target=${q.target}`);
  if (q.dev) parts.push('dev');
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
