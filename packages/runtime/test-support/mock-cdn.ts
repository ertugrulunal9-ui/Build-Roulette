/**
 * Mock ESM package CDN that emulates the esm.sh URL shape for packages installed locally.
 *
 *   GET /<name>@<version>[/<subpath>][?external=a,b][&deps=x@1.2.3][&dev]
 *   GET /<name>@<version>&external=a,b[/<subpath>]    (the query in the path, T-040)
 *
 * - JS entries are bundled on demand from local node_modules into a single ES module with
 *   esbuild and cached in memory. CommonJS entries (React 18/19 ship CJS) get an ESM wrapper
 *   with real named exports, computed statically with cjs-module-lexer (no package code runs
 *   on the server).
 * - `external` keeps the listed packages (and their subpaths) as bare imports, so the page's
 *   import map resolves them to one shared instance. A CommonJS `require('react')` of an
 *   external package is rewritten to an ESM import of it, which is what esm.sh does too.
 * - A subpath's import of its own package (`three/examples/…` importing `three`) is the main
 *   module with the same query, like @br/pkg-cdn and esm.sh, never a second copy.
 * - The query may also come after the version in the path (`/three@0.186.1&external=a,b/x.js`,
 *   an import-map prefix, T-040): read after one decoding of the path, like esm.sh. In the
 *   `bundle` layout the answer re-exports the `?query` URL (as @br/pkg-cdn does); in the
 *   `esm.sh` layout it is the same internal build path anyway.
 * - Non-JS subpaths (`.css`, fonts, images, `.json`) are served raw from the package.
 * - Only allowlisted packages are served, and only at the exact installed version (a real
 *   CDN would hold many versions; the mock answers 404 with a clear reason instead). The
 *   fixture packages (`test-support/fixture-packages/<name>/<version>/`, T-040) are served at
 *   every version they have, so a range can resolve to a newer one than a manifest pins.
 *
 * The two layouts (`MockCdnLayout`) differ in what a package's own dependencies become:
 * - `bundle` (like @br/pkg-cdn): bundled into the module; `deps` is ignored.
 * - `esm.sh`: separate modules, like the public esm.sh (T-040, from its source and CI run 60):
 *   a dependency the request pins with `deps=` is an internal build path at that version;
 *   any other one is imported by the range in the package's package.json,
 *   `/<dep>@<range>?[external=…&]target=es2022`, which answers `Cache-Control:
 *   public, max-age=600` and resolves to the newest version available, a second instance if
 *   the page has the package at another URL. That reproduces CI run 60's failures (two
 *   chart.js, two three, React DOM's scheduler cached 10 minutes) and lets the tests show
 *   the externals that fix them.
 *
 * This is also the seed of a self-hosted CDN: URL parsing, the CJS->ESM wrapper and the
 * external handling are the parts that carry over.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { init as initCjsLexer, parse as parseCjs } from 'cjs-module-lexer';
import { init as initEsmLexer, parse as parseEsm } from 'es-module-lexer';
import semver from 'semver';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESOLVE_FROM = path.resolve(HERE, '..');
/** Test packages with several versions each (T-040). Always served, at every version. */
export const DEFAULT_FIXTURES_DIR = path.join(HERE, 'fixture-packages');

export const DEFAULT_ALLOWED_PACKAGES = [
  'react',
  'react-dom',
  'scheduler',
  'zustand',
  'animate.css',
] as const;

/** esm.sh's cache lifetime for a range URL (`ccTenMinutes` in its router). */
export const RANGE_CACHE_CONTROL = 'public, max-age=600';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface CdnRequest {
  name: string;
  version: string;
  /** '' or '/sub/path' */
  subpath: string;
}

/** A request target: the version may be a range, the query may be in the path. */
export interface CdnTarget {
  name: string;
  /** An exact version, or a range (`^1.0.0`) as written. */
  versionText: string;
  exact: boolean;
  /** '' or '/sub/path' */
  subpath: string;
  /** The query written after the version in the path (`external=a,b`), '' when none. */
  pathQuery: string;
}

const NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

/**
 * Parses `/<name>@<version|range>[&<query>][/<subpath>]` (the path decoded once). Returns null
 * for anything else. Pure.
 */
export function parseCdnTarget(pathname: string): CdnTarget | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!p.startsWith('/')) return null;
  p = p.slice(1);
  const scoped = p.startsWith('@');
  const firstSlash = p.indexOf('/');
  const nameEnd = scoped ? p.indexOf('/', firstSlash + 1) : firstSlash;
  const head = nameEnd === -1 ? p : p.slice(0, nameEnd);
  const subpath = nameEnd === -1 ? '' : p.slice(nameEnd);
  const at = head.indexOf('@', 1);
  if (at <= 0) return null;
  const name = head.slice(0, at);
  const rest = head.slice(at + 1);
  const amp = rest.indexOf('&');
  const versionText = amp === -1 ? rest : rest.slice(0, amp);
  const pathQuery = amp === -1 ? '' : rest.slice(amp + 1);
  if (!NAME_RE.test(name)) return null;
  const exact = VERSION_RE.test(versionText);
  if (!exact && semver.validRange(versionText) === null) return null;
  if (subpath.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return { name, versionText, exact, subpath: subpath === '/' ? '' : subpath, pathQuery };
}

/** Parses `/<name>@<x.y.z>[/<subpath>]` (exact versions only). Returns null otherwise. Pure. */
export function parseCdnPath(pathname: string): CdnRequest | null {
  const t = parseCdnTarget(pathname);
  if (!t?.exact || t.pathQuery !== '') return null;
  return { name: t.name, version: t.versionText, subpath: t.subpath };
}

/** Package name of a bare specifier (`@a/b/c` -> `@a/b`, `x/y` -> `x`). Pure. */
export function packageNameOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

const RAW_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval'.split(
    ' ',
  ),
);
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * How module URLs are answered:
 * - `bundle` (default, like @br/pkg-cdn): the URL's response is the whole module;
 * - `esm.sh` (T-035, T-040): like the public esm.sh, the URL answers with a few lines that
 *   re-export an internal build path on the same origin (`/react@19.3.0/X-…/es2022/react.mjs`),
 *   which holds the module, and a package's own dependencies are separate modules, imported
 *   by range unless pinned (see the file comment). Lets the e2e suites run the T-032 cache
 *   behaviour and the one-instance checks against esm.sh's shape without reaching esm.sh.
 */
export type MockCdnLayout = 'bundle' | 'esm.sh';

export const MOCK_CDN_LAYOUTS: readonly MockCdnLayout[] = ['bundle', 'esm.sh'];

/** `bundle` | `esm.sh`, the default for empty or undefined, and an error for anything else. */
export function parseLayout(value: string | undefined): MockCdnLayout {
  if (value === undefined || value === '') return 'bundle';
  const layout = MOCK_CDN_LAYOUTS.find((l) => l === value);
  if (!layout) throw new Error(`CDN_LAYOUT must be ${MOCK_CDN_LAYOUTS.join(' or ')}, not ${value}`);
  return layout;
}

/** `deps=a@1.0.0,@s/b@2.0.0` as a sorted map. Pure. */
export function parseDeps(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of (text ?? '').split(',')) {
    const s = item.trim();
    const at = s.lastIndexOf('@');
    if (at > 0) out.set(s.slice(0, at), s.slice(at + 1));
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The internal build path esm.sh-style entry modules re-export (pure): the build options in
 * an `X-<base64url>` segment (only when there are externals or deps), the target, then the
 * subpath (or the package's own name) as `.mjs`.
 */
export function esmShInternalPath(
  req: CdnRequest,
  externals: ReadonlySet<string>,
  dev: boolean,
  deps: ReadonlyMap<string, string> = new Map(),
): string {
  const ext = [...externals].sort().join(',');
  const pins = [...deps].map(([n, v]) => `${n}@${v}`).join(',');
  const text = [ext ? `external=${ext}` : '', pins ? `deps=${pins}` : ''].filter(Boolean).join('&');
  const args = text ? `X-${Buffer.from(text).toString('base64url')}/` : '';
  const file = req.subpath
    ? req.subpath.replace(/\.(?:m?js|cjs)$/, '')
    : `/${req.name.slice(req.name.lastIndexOf('/') + 1)}`;
  return `/${req.name}@${req.version}/${args}es2022${file}${dev ? '.development' : ''}.mjs`;
}

export interface MockCdnOptions {
  port?: number;
  host?: string;
  /** Directory whose node_modules hold the served packages. Defaults to packages/runtime. */
  resolveFrom?: string;
  allowedPackages?: readonly string[];
  /** Fixture packages, `<dir>/<name>/<version>/` (T-040). Default `DEFAULT_FIXTURES_DIR`. */
  fixturesDir?: string;
  /** See `MockCdnLayout`. Default `bundle`. */
  layout?: MockCdnLayout;
  log?: (line: string) => void;
}

/**
 * A simulated outage of the package CDN (T-032 e2e):
 * - `refuse`: the listener is closed and open connections are dropped, so the browser gets
 *   "connection refused" at once (the container is down and nothing answers for it);
 * - `error`: every request gets a `502` without CORS headers, like an error page from the
 *   edge in front of a dead origin (the browser sees a CORS failure, i.e. a network error);
 * - `hang`: requests are accepted and not answered while the outage lasts (a black hole, or
 *   an edge waiting for an origin that does not answer); when it ends they are answered
 *   normally, like an origin that finally comes back.
 * `null` ends the outage.
 */
export type CdnOutage = 'refuse' | 'error' | 'hang';

export const CDN_OUTAGES: readonly CdnOutage[] = ['refuse', 'error', 'hang'];

/** `refuse` | `error` | `hang`, `off` (null), or undefined for anything else. */
export function parseOutage(mode: string | null): CdnOutage | null | undefined {
  if (mode === 'off') return null;
  return CDN_OUTAGES.find((o) => o === mode);
}

/**
 * Answers `POST /cdn-outage?mode=refuse|error|hang|off` (`setOutage`) for e2e suites whose
 * services run in another process (apps/web scripts). Listens on 127.0.0.1 only. Test
 * support: never part of anything deployed.
 */
export async function startOutageControl(
  cdn: Pick<MockCdn, 'setOutage'>,
  port: number,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://control.local');
    const outage = parseOutage(url.searchParams.get('mode'));
    if (req.method !== 'POST' || url.pathname !== '/cdn-outage' || outage === undefined) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('POST /cdn-outage?mode=refuse|error|hang|off\n');
      return;
    }
    void cdn.setOutage(outage).then(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(`cdn outage: ${outage ?? 'off'}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${String(bound)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface MockCdn {
  url: string;
  /** The current listener (a new one after an outage of kind `refuse` ends). */
  readonly server: Server;
  /** Number of esbuild bundles produced (cache misses) and requests seen. */
  stats: { builds: number; requests: number };
  /** The current outage, or null while the CDN serves normally. */
  outage(): CdnOutage | null;
  /** Starts or ends a simulated outage (see `CdnOutage`). Resolves once it is in effect. */
  setOutage(outage: CdnOutage | null): Promise<void>;
  close(): Promise<void>;
}

interface PackageJson {
  main?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackageInfo {
  name: string;
  dir: string;
  version: string;
  json: PackageJson;
  /** A fixture package (`fixturesDir`), not an installed one. */
  fixture: boolean;
}

/** One module the mock builds: a package entry and its build arguments. */
interface Build {
  req: CdnRequest;
  externals: Set<string>;
  /** `deps=` pins. Used by the `esm.sh` layout; the `bundle` layout only keeps them in URLs. */
  deps: Map<string, string>;
  dev: boolean;
}

function noLog(): void {
  // Logging is opt-in.
}

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
}

function listParam(value: string | null): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** The query a module URL carries in the `bundle` layout (@br/pkg-cdn's `formatQuery`). */
function canonicalQuery(b: Build): string {
  const parts: string[] = [];
  if (b.externals.size > 0) parts.push(`external=${[...b.externals].sort().join(',')}`);
  if (b.deps.size > 0) parts.push(`deps=${[...b.deps].map(([n, v]) => `${n}@${v}`).join(',')}`);
  if (b.dev) parts.push('dev');
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

let esmLexer: Promise<void> | null = null;

async function hasDefaultExport(code: string): Promise<boolean> {
  esmLexer ??= Promise.resolve(initEsmLexer());
  await esmLexer;
  try {
    return parseEsm(code)[1].some((e) => e.type !== 'reexport-all' && e.name === 'default');
  } catch {
    return false;
  }
}

/** A module that re-exports `target` (an esm.sh entry module, or a query-in-path answer). */
async function reexport(comment: string, target: string, code: string): Promise<string> {
  const s = JSON.stringify(target);
  const def = (await hasDefaultExport(code)) ? `export { default } from ${s};\n` : '';
  return `/* ${comment} */\nexport * from ${s};\n${def}`;
}

export function createMockCdnHandler(opts: MockCdnOptions = {}) {
  const resolveFrom = opts.resolveFrom ?? DEFAULT_RESOLVE_FROM;
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const allowed = new Set(opts.allowedPackages ?? DEFAULT_ALLOWED_PACKAGES);
  const layout = opts.layout ?? 'bundle';
  const log = opts.log ?? noLog;
  const cache = new Map<string, Promise<string>>();
  /** `esm.sh` layout: internal build path → the module it holds. */
  const internals = new Map<string, Build>();
  const installed = new Map<string, PackageInfo | null>();
  const stats = { builds: 0, requests: 0 };
  const lexersReady = Promise.all([initCjsLexer(), initEsmLexer()]);

  function fixtureVersions(name: string): string[] {
    if (!NAME_RE.test(name)) return [];
    try {
      return readdirSync(path.join(fixturesDir, name))
        .filter((v) => semver.valid(v) === v)
        .sort(semver.compare);
    } catch {
      return [];
    }
  }

  function installedPackage(name: string): PackageInfo | null {
    const known = installed.get(name);
    if (known !== undefined) return known;
    let found: PackageInfo | null = null;
    const req = createRequire(path.join(resolveFrom, 'noop.js'));
    for (const base of req.resolve.paths(name) ?? []) {
      const pj = path.join(base, name, 'package.json');
      if (existsSync(pj)) {
        const json = readJson(pj);
        found = {
          name,
          dir: realpathSync(path.dirname(pj)),
          version: json.version ?? '0.0.0',
          json,
          fixture: false,
        };
        break;
      }
    }
    installed.set(name, found);
    return found;
  }

  function isServed(name: string): boolean {
    return fixtureVersions(name).length > 0 || allowed.has(name);
  }

  /** The versions a range can resolve to: a fixture's, or an allowed package's installed one. */
  function availableVersions(name: string): string[] {
    const fixtures = fixtureVersions(name);
    if (fixtures.length > 0) return fixtures;
    const pkg = allowed.has(name) ? installedPackage(name) : null;
    return pkg ? [pkg.version] : [];
  }

  function findPackage(name: string, version: string): PackageInfo | null {
    if (fixtureVersions(name).includes(version)) {
      const dir = realpathSync(path.join(fixturesDir, name, version));
      return { name, dir, version, json: readJson(path.join(dir, 'package.json')), fixture: true };
    }
    const pkg = installedPackage(name);
    return pkg?.version === version ? pkg : null;
  }

  /** The fixture package a file belongs to (`<fixturesDir>/<name>/<version>/…`), if any. */
  function fixtureOf(file: string): PackageInfo | null {
    const rel = path.relative(fixturesDir, file).split(path.sep);
    if (rel[0] === '..' || rel.length < 3) return null;
    const scoped = rel[0]?.startsWith('@') ?? false;
    const name = scoped ? `${rel[0] ?? ''}/${rel[1] ?? ''}` : (rel[0] ?? '');
    return findPackage(name, rel[scoped ? 2 : 1] ?? '');
  }

  /** Static named exports of a CommonJS file, following `module.exports = require(...)` re-exports. */
  function cjsExportNames(file: string, seen = new Set<string>()): Set<string> {
    const names = new Set<string>();
    if (seen.has(file)) return names;
    seen.add(file);
    const { exports, reexports } = parseCjs(readFileSync(file, 'utf8'));
    for (const n of exports) names.add(n);
    const req = createRequire(file);
    for (const r of reexports) {
      try {
        for (const n of cjsExportNames(req.resolve(r), seen)) names.add(n);
      } catch {
        // Unresolvable re-export (optional dependency): skip, like esm.sh does.
      }
    }
    return names;
  }

  /** Resolves a bare specifier the way the browser bundle will (browser conditions). */
  async function resolveEntry(spec: string, resolveDir: string): Promise<string> {
    let resolved: string | undefined;
    await esbuild.build({
      stdin: { contents: `import ${JSON.stringify(spec)}`, resolveDir, loader: 'js' },
      bundle: true,
      write: false,
      platform: 'browser',
      logLevel: 'silent',
      plugins: [
        {
          name: 'capture-entry',
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (
                args.importer !== '<stdin>' ||
                (args.pluginData as { inner?: boolean } | undefined)?.inner
              )
                return undefined;
              const r = await build.resolve(args.path, {
                kind: args.kind,
                resolveDir: args.resolveDir,
                pluginData: { inner: true },
              });
              if (r.errors.length > 0)
                throw new Error(r.errors[0]?.text ?? `cannot resolve ${spec}`);
              resolved = r.path;
              return { path: r.path, external: true };
            });
          },
        },
      ],
    });
    if (!resolved) throw new Error(`cannot resolve ${spec}`);
    return resolved;
  }

  /** The file a package entry (`''` or `/sub/path`) starts from. */
  async function entryFile(pkg: PackageInfo, subpath: string): Promise<string> {
    if (!pkg.fixture) return resolveEntry(pkg.name + subpath, resolveFrom);
    const file = path.resolve(pkg.dir, subpath ? subpath.slice(1) : (pkg.json.main ?? 'index.js'));
    if (!file.startsWith(pkg.dir + path.sep) || !existsSync(file)) {
      throw new Error(`${pkg.name}@${pkg.version}${subpath} does not exist`);
    }
    return file;
  }

  async function wrapperFor(file: string): Promise<{ code: string; format: 'esm' | 'cjs' }> {
    await lexersReady;
    const source = readFileSync(file, 'utf8');
    const s = JSON.stringify(file);
    let hasModuleSyntax = false;
    let hasDefault = false;
    try {
      const [, exports, , moduleSyntax] = parseEsm(source);
      hasModuleSyntax = moduleSyntax;
      hasDefault = exports.some((e) => e.type !== 'reexport-all' && e.name === 'default');
    } catch {
      hasModuleSyntax = false;
    }
    if (hasModuleSyntax) {
      return {
        code: `export * from ${s};\n${hasDefault ? `export { default } from ${s};\n` : ''}`,
        format: 'esm',
      };
    }
    const names = [...cjsExportNames(file)].filter(
      (n) => IDENT_RE.test(n) && !RESERVED.has(n) && n !== '__esModule' && n !== '__m',
    );
    const named = names.length > 0 ? `export const { ${names.join(', ')} } = __m;\n` : '';
    return { code: `import __m from ${s};\nexport default __m;\n${named}`, format: 'cjs' };
  }

  /** `esm.sh` layout: the internal build path of `b`, now servable. */
  function register(b: Build): string {
    const p = esmShInternalPath(b.req, b.externals, b.dev, b.deps);
    internals.set(p, b);
    return p;
  }

  /**
   * esm.sh's `resolveBuildArgs` for a dependency it imports: only the externals and pins that
   * are the dependency's own dependencies or peers carry over.
   */
  function argsFor(name: string, version: string | null, from: Build): Omit<Build, 'req'> {
    const json = version === null ? {} : (findPackage(name, version)?.json ?? {});
    const direct = new Set([
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
    ]);
    return {
      externals: new Set([...from.externals].filter((e) => direct.has(e))),
      deps: new Map([...from.deps].filter(([n]) => n !== name && direct.has(n))),
      dev: from.dev,
    };
  }

  /** `esm.sh` layout: the range URL esm.sh emits for a dependency it does not pin. */
  function rangeUrl(name: string, range: string, subpath: string, from: Build): string {
    const newest = semver.maxSatisfying(availableVersions(name), range);
    const args = argsFor(name, newest, from);
    const params: string[] = [];
    if (args.deps.size > 0)
      params.push(`deps=${[...args.deps].map(([n, v]) => `${n}@${v}`).join(',')}`);
    if (args.externals.size > 0) params.push(`external=${[...args.externals].sort().join(',')}`);
    params.push('target=es2022');
    if (args.dev) params.push('dev');
    return `/${name}@${range.replace(/ /g, '%20')}${subpath}?${params.join('&')}`;
  }

  /**
   * What a bare import inside the module `b` (of package `pkg`) becomes: a bare import or URL
   * the browser loads (`url`), a file to bundle (`file`), or null for esbuild's own
   * resolution (bundled).
   */
  async function importTarget(
    b: Build,
    pkg: PackageInfo,
    spec: string,
    importer: string,
  ): Promise<{ url: string } | { file: string } | null> {
    const name = packageNameOf(spec);
    const subpath = spec.slice(name.length);
    if (b.externals.has(name)) return { url: spec };
    if (name === b.req.name) {
      // A subpath importing its own package: the main module with the same arguments.
      if (b.req.subpath === '') return null;
      const self: Build = { ...b, req: { name, version: b.req.version, subpath } };
      return {
        url:
          layout === 'esm.sh'
            ? register(self)
            : `/${name}@${b.req.version}${subpath}${canonicalQuery(self)}`,
      };
    }
    if (layout === 'esm.sh') {
      if (!isServed(name)) return null;
      const pin = b.deps.get(name);
      if (pin !== undefined && findPackage(name, pin)) {
        return {
          url: register({ req: { name, version: pin, subpath }, ...argsFor(name, pin, b) }),
        };
      }
      const range = pkg.json.dependencies?.[name] ?? pkg.json.peerDependencies?.[name];
      if (range !== undefined && semver.validRange(range) !== null) {
        return { url: rangeUrl(name, range, subpath, b) };
      }
      return null;
    }
    // `bundle` layout: a fixture's own dependencies are bundled from the fixture packages.
    const versions = fixtureVersions(name);
    if (versions.length === 0) return null;
    const owner = fixtureOf(importer) ?? pkg;
    const range = owner.json.dependencies?.[name] ?? owner.json.peerDependencies?.[name] ?? '*';
    const version = semver.maxSatisfying(versions, range);
    const dep = version === null ? null : findPackage(name, version);
    return dep ? { file: await entryFile(dep, subpath) } : null;
  }

  async function bundle(b: Build, pkg: PackageInfo): Promise<string> {
    const file = await entryFile(pkg, b.req.subpath);
    const wrapper = await wrapperFor(file);
    stats.builds++;
    const result = await esbuild.build({
      stdin: { contents: wrapper.code, resolveDir: path.dirname(file), loader: 'js' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: !b.dev,
      legalComments: 'none',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify(b.dev ? 'development' : 'production') },
      plugins: [
        {
          name: 'cdn-externals',
          setup(build) {
            // Imports inside the CJS shim always point at the external module.
            build.onResolve({ filter: /.*/, namespace: 'external-cjs' }, (args) => ({
              path: args.path,
              external: true,
            }));
            build.onResolve({ filter: /^[^./]/ }, async (args) => {
              const target = await importTarget(b, pkg, args.path, args.importer);
              if (target === null) return undefined;
              if ('file' in target) return { path: target.file };
              if (args.kind === 'require-call') {
                // CJS `require('react')` cannot stay a require in an ES module: route it
                // through an ESM shim that re-exports the external module's namespace.
                return { path: target.url, namespace: 'external-cjs' };
              }
              return { path: target.url, external: true };
            });
            build.onLoad({ filter: /.*/, namespace: 'external-cjs' }, (args) => {
              const s = JSON.stringify(args.path);
              return {
                contents: `export * from ${s};\nexport { default } from ${s};\n`,
                loader: 'js',
                resolveDir: path.dirname(file),
              };
            });
          },
        },
      ],
    });
    const text = result.outputFiles[0]?.text ?? '';
    const ext = [...b.externals].sort().join(',');
    return `/* mock-cdn ${b.req.name}@${pkg.version}${b.req.subpath} (${wrapper.format}${ext ? `, external: ${ext}` : ''}${b.dev ? ', dev' : ''}) */\n${text}`;
  }

  /** The module of `b`, built once (the `bundle` layout ignores `deps`, like the old mock). */
  function moduleFor(b: Build): Promise<string> {
    const deps = layout === 'esm.sh' ? [...b.deps].map(([n, v]) => `${n}@${v}`).join(',') : '';
    const key = `${b.req.name}@${b.req.version}${b.req.subpath}|${[...b.externals].sort().join(',')}|${deps}|${b.dev ? 'dev' : 'prod'}`;
    let job = cache.get(key);
    if (!job) {
      const pkg = findPackage(b.req.name, b.req.version);
      if (!pkg) return Promise.reject(new Error(`${b.req.name}@${b.req.version} is not available`));
      const started = performance.now();
      job = bundle(b, pkg);
      cache.set(key, job);
      job.then(
        () => {
          log(`mock-cdn built ${key} in ${(performance.now() - started).toFixed(0)}ms`);
        },
        () => {
          cache.delete(key);
        },
      );
    }
    return job;
  }

  function send(
    res: ServerResponse,
    status: number,
    type: string,
    body: string | Buffer,
    extra: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(body);
  }

  const JS = 'application/javascript; charset=utf-8';

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    stats.requests++;
    const url = new URL(req.url ?? '/', 'http://mock-cdn.local');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain', 'method not allowed');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      send(res, 200, 'text/plain', 'mock-cdn ok');
      return;
    }
    const internal = internals.get(url.pathname);
    if (internal !== undefined) {
      try {
        send(res, 200, JS, await moduleFor(internal), { 'Cache-Control': IMMUTABLE_CACHE_CONTROL });
      } catch (e) {
        send(res, 500, 'text/plain', `mock-cdn: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    const target = parseCdnTarget(url.pathname);
    if (!target) {
      send(
        res,
        400,
        'text/plain',
        `mock-cdn: unsupported URL ${url.pathname} (expected /<name>@<x.y.z>[/subpath])`,
      );
      return;
    }
    if (!isServed(target.name)) {
      send(
        res,
        404,
        'text/plain',
        `mock-cdn: package "${target.name}" is not served by the mock CDN`,
      );
      return;
    }
    let version = target.versionText;
    if (!target.exact) {
      // esm.sh answers a range itself, cached for 10 minutes (no redirect).
      if (layout !== 'esm.sh') {
        send(res, 400, 'text/plain', `mock-cdn: ranges are answered in the esm.sh layout only`);
        return;
      }
      const newest = semver.maxSatisfying(availableVersions(target.name), target.versionText);
      if (newest === null) {
        send(res, 404, 'text/plain', `mock-cdn: no version of ${target.name} matches ${version}`);
        return;
      }
      version = newest;
    }
    const pkg = findPackage(target.name, version);
    if (!pkg) {
      const fixtures = fixtureVersions(target.name);
      const have =
        fixtures.length > 0 ? fixtures.join(', ') : installedPackage(target.name)?.version;
      send(
        res,
        404,
        'text/plain',
        have === undefined
          ? `mock-cdn: package "${target.name}" is not installed`
          : `mock-cdn: ${target.name}@${version} not available (installed: ${have})`,
      );
      return;
    }
    const cacheControl = target.exact ? IMMUTABLE_CACHE_CONTROL : RANGE_CACHE_CONTROL;

    const ext = path.extname(target.subpath).toLowerCase();
    const rawType = RAW_TYPES[ext];
    if (rawType) {
      const file = path.join(pkg.dir, target.subpath);
      const real = existsSync(file) ? realpathSync(file) : '';
      if (!real || !real.startsWith(pkg.dir + path.sep) || !statSync(real).isFile()) {
        send(
          res,
          404,
          'text/plain',
          `mock-cdn: ${target.name}@${version}${target.subpath} not found`,
        );
        return;
      }
      send(res, 200, rawType, await readFile(real), { 'Cache-Control': cacheControl });
      return;
    }

    // The query in the path comes first, like esm.sh's `extraQuery`.
    const query = new URLSearchParams(
      [target.pathQuery, url.search.slice(1)].filter((s) => s !== '').join('&'),
    );
    const deps = parseDeps(query.get('deps'));
    // esm.sh drops a pin of the package itself (its router: `esm.PkgName != esmPath.PkgName`).
    deps.delete(target.name);
    const b: Build = {
      req: { name: target.name, version, subpath: target.subpath },
      externals: listParam(query.get('external')),
      deps,
      dev: query.has('dev'),
    };
    try {
      const code = await moduleFor(b);
      const what = `${target.name}@${version}${target.subpath}`;
      let body = code;
      if (layout === 'esm.sh') {
        body = await reexport(`esm.sh-shaped mock - ${what}`, register(b), code);
      } else if (target.pathQuery !== '') {
        // Like @br/pkg-cdn: the `?query` URL is the module, so both are one instance.
        const canonical = `/${what}${canonicalQuery(b)}`;
        body = await reexport(`mock-cdn ${what}: query in the path`, canonical, code);
      }
      send(res, 200, JS, body, { 'Cache-Control': cacheControl });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      send(
        res,
        500,
        'text/plain',
        `mock-cdn: failed to build ${target.name}@${version}${target.subpath}: ${msg}`,
      );
    }
  }

  return { handle, stats };
}

export async function startMockCdn(opts: MockCdnOptions = {}): Promise<MockCdn> {
  const { handle, stats } = createMockCdnHandler(opts);
  const host = opts.host ?? 'localhost';
  let outage: CdnOutage | null = null;
  /** Requests held open by a `hang` outage, answered when it ends. */
  const held = new Map<ServerResponse, IncomingMessage>();
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (outage === 'error') {
      stats.requests++;
      // No Access-Control-Allow-Origin, like an edge error page: a CORS failure in the browser.
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('502 Bad Gateway (simulated package CDN outage)');
      return;
    }
    if (outage === 'hang') {
      stats.requests++;
      held.set(res, req);
      res.on('close', () => held.delete(res));
      return;
    }
    serve(req, res);
  };
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent)
        res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(`mock-cdn internal error: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const listen = async (port: number): Promise<Server> => {
    const s = createServer(onRequest);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(port, host, () => {
        resolve();
      });
    });
    return s;
  };
  const stop = (s: Server) =>
    new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
      s.closeAllConnections();
    });
  let server: Server | null = await listen(opts.port ?? 0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
  let current: Server = server;
  return {
    url: `http://${host}:${String(port)}`,
    get server() {
      return current;
    },
    stats,
    outage: () => outage,
    async setOutage(next) {
      if (next === outage) return;
      const release = outage === 'hang' ? [...held] : [];
      held.clear();
      if (outage === 'refuse') {
        server = await listen(port);
        current = server;
      }
      if (next === 'refuse' && server) {
        const s = server;
        server = null;
        await stop(s);
      }
      outage = next;
      // Requests a `hang` held are served when it ends (an origin that finally answers).
      for (const [res, req] of release) {
        if (next === null) serve(req, res);
        else res.destroy();
      }
    },
    close: async () => {
      for (const res of held.keys()) res.destroy();
      held.clear();
      if (server) await stop(server);
      server = null;
    },
  };
}
