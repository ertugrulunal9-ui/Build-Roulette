/**
 * Pure module-resolution logic for the bundler plugins. No esbuild, no I/O, so it is unit
 * tested directly in Node.
 */
import { LIMITS, type ImportMap } from '@br/protocol';
import type { FileMap } from '../types';

/** Extensions tried, in order, for extensionless relative imports. */
export const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'] as const;

/**
 * Specifiers that stay bare in the bundle and are resolved by the shell's import map: the
 * React set's entry points (the template's fixed URLs, T-032). Every other package import
 * becomes a full CDN URL in the bundle (the same URL the import map gives it).
 */
export const IMPORT_MAP_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'scheduler',
] as const;

/** React and React DOM: external in every CDN module, so React is a single instance. */
export const SHARED_EXTERNALS = ['react', 'react-dom'] as const;

/**
 * The React set (T-040): React, React DOM and React DOM's `scheduler`. Their URLs never
 * depend on the rest of the manifest, so the template's packages stay cached across
 * dependency changes (T-032), and they import nothing but each other.
 */
export const REACT_SET = ['react', 'react-dom', 'scheduler'] as const;

/**
 * The `scheduler` each React DOM minor depends on (`^0.x.0` in its package.json), pinned to
 * the exact version (T-040). On esm.sh, React DOM would otherwise import
 * `/scheduler@^0.28.0?target=es2022`, a range URL cached for 10 minutes only, so the
 * template's packages would not outlast a longer CDN outage. A manifest that lists
 * `scheduler` itself uses that pin instead. Add a row when the template moves to a new React
 * minor (`npm view react-dom@<version> dependencies.scheduler`, then the newest exact match).
 */
export const REACT_DOM_SCHEDULER: Readonly<Record<string, string>> = {
  '19.0': '0.25.0',
  '19.1': '0.26.0',
  '19.2': '0.27.0',
  '19.3': '0.28.0',
};

/**
 * Most externals the package CDN accepts in one URL (apps/pkg-cdn `MAX_EXTERNALS`). A build
 * externalizes every manifest package in every other package's URL, so this bounds the
 * manifest: React and React DOM plus 32 packages.
 */
export const MAX_CDN_EXTERNALS = 32;

/**
 * Longest external list, as written in a prefix URL (`&external=…/`). Keeps every import map
 * URL under the bridge's 2,048-character limit (`LIMITS.importMapValueMaxChars`).
 */
export const MAX_EXTERNALS_CHARS = 1200;
/** Max size of an image asset file (docs/03 §3.3). */
export const MAX_ASSET_BYTES = 200 * 1024;

const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(
    ' ',
  ),
);

const PINNED_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Names the package CDN accepts as externals (new-style npm names, as in apps/pkg-cdn). */
const CDN_NAME_RE = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;
const CDN_RESERVED_NAMES = new Set(['node_modules', 'favicon.ico']);
/**
 * Exact versions the package CDN serves as themselves: strict SemVer 2.0 without build
 * metadata (`semver.valid(v) === v`). Build metadata would be dropped by the CDN, and `+` in
 * a URL reads as a space.
 */
const CDN_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;
/** apps/pkg-cdn `MAX_VERSION_SPEC_LENGTH`. */
const CDN_MAX_VERSION_CHARS = 128;

/** Normalizes a workspace path: no leading `/` or `./`, `.`/`..` segments collapsed. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function extname(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function isRelativeOrAbsolute(spec: string): boolean {
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('/') ||
    spec === '.' ||
    spec === '..'
  );
}

/**
 * Resolves a relative (`./x`, `../x`) or workspace-absolute (`/src/x`) import against the
 * file map, trying the exact path, then each extension, then `index.*`.
 * Returns the normalized path, or null when nothing matches.
 */
export function resolveWorkspaceImport(
  files: FileMap,
  importer: string,
  spec: string,
): string | null {
  const base = spec.startsWith('/')
    ? normalizePath(spec)
    : normalizePath(`${dirname(importer)}/${spec}`);
  const has = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  if (base !== '' && has(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) if (has(base + ext)) return base + ext;
  const prefix = base === '' ? '' : `${base}/`;
  for (const ext of RESOLVE_EXTENSIONS)
    if (has(`${prefix}index${ext}`)) return `${prefix}index${ext}`;
  return null;
}

export interface BareSpecifier {
  name: string;
  /** '' or '/sub/path' */
  subpath: string;
}

/**
 * Encoded path separators (`%2f`, `%5c`), an encoded percent sign (`%25`, i.e. double
 * encoding) or a backslash. A server or URL parser may decode or normalize these into a
 * separator after we checked the segments, so a subpath containing one is rejected outright.
 */
const UNSAFE_SEGMENT_RE = /%2f|%5c|%25|\\/i;

/**
 * True for a path segment that is, or decodes to, `.` or `..`. URL parsers (WHATWG URL,
 * most HTTP servers) treat `%2e` (any case) as a dot when they normalize dot segments, so
 * `%2e%2e`, `.%2E` and `%2e.` are `..` as far as the CDN is concerned.
 */
function isDotSegment(seg: string): boolean {
  const decoded = seg.replace(/%2e/gi, '.');
  return decoded === '.' || decoded === '..';
}

/**
 * Splits `@scope/pkg/sub/path` into name and subpath. Returns null for invalid names and for
 * subpaths with empty, dot (`.`/`..`, literal or percent-encoded) or otherwise unsafe
 * segments, so a CDN URL built from the result can never climb out of the package.
 */
export function parseBareSpecifier(spec: string): BareSpecifier | null {
  const parts = spec.split('/');
  const nameParts = spec.startsWith('@') ? 2 : 1;
  if (parts.length < nameParts) return null;
  const name = parts.slice(0, nameParts).join('/');
  if (!PACKAGE_NAME_RE.test(name)) return null;
  const rest = parts.slice(nameParts);
  if (rest.some((s) => s === '' || isDotSegment(s) || UNSAFE_SEGMENT_RE.test(s))) return null;
  return { name, subpath: rest.length > 0 ? `/${rest.join('/')}` : '' };
}

export function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec.split('/')[0] ?? spec);
}

export function isPinnedVersion(v: string): boolean {
  return PINNED_VERSION_RE.test(v);
}

function trimBase(cdnBaseUrl: string): string {
  return cdnBaseUrl.replace(/\/+$/, '');
}

function ownVersion(dependencies: Record<string, string>, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : undefined;
}

/** A manifest entry the package CDN takes as an external and serves at its exact version. */
function isCdnPackage(name: string, version: string | undefined): version is string {
  return (
    version !== undefined &&
    name.length <= 214 &&
    CDN_NAME_RE.test(name) &&
    !CDN_RESERVED_NAMES.has(name) &&
    version.length <= CDN_MAX_VERSION_CHARS &&
    CDN_VERSION_RE.test(version)
  );
}

/**
 * The exact `scheduler` of the React set: the manifest's own pin when it lists `scheduler`,
 * else the one that goes with the manifest's React DOM (`REACT_DOM_SCHEDULER`). Null when
 * neither is known (React DOM missing, unpinned, a prerelease or a minor not in the table):
 * React DOM's URLs then leave `scheduler` to the CDN, as before T-040.
 */
export function schedulerPin(dependencies: Record<string, string>): string | null {
  const own = ownVersion(dependencies, 'scheduler');
  if (own !== undefined) return isCdnPackage('scheduler', own) ? own : null;
  const reactDom = ownVersion(dependencies, 'react-dom');
  const minor = reactDom === undefined ? null : /^(\d+)\.(\d+)\.\d+$/.exec(reactDom);
  if (!minor) return null;
  return REACT_DOM_SCHEDULER[`${minor[1] ?? ''}.${minor[2] ?? ''}`] ?? null;
}

/**
 * A package name as it is written inside a prefix URL's path segment (`cdnPrefixUrl`). The
 * `/` of a scoped name would end the segment, so it is percent-encoded twice: the CDN decodes
 * the path once (`%2F` stays inside the segment) and then reads the part after `&` as a query
 * string, which decodes it to `/`. esm.sh does exactly that (`parseEsmPath` → `extraQuery`),
 * and @br/pkg-cdn and the mock CDN do the same.
 */
export function inPathName(name: string): string {
  return name.replace('/', '%252F');
}

/**
 * The build's externals (T-040): every package of the manifest the CDN accepts, plus React and
 * React DOM, sorted (the order the CDN writes them in, so URLs are deterministic). Every CDN
 * module of the build leaves these as bare imports, and the import map sends each one to its
 * single pinned URL, so a package another package imports (`three` inside
 * `@react-three/fiber`, `chart.js` inside `react-chartjs-2`) is one instance and never a copy
 * the CDN resolves by range.
 *
 * Null when the CDN could not take the list in one URL (more than `MAX_CDN_EXTERNALS`
 * besides the package itself, or longer than `MAX_EXTERNALS_CHARS`): CDN modules then only
 * externalize React and React DOM, and the import map holds the React set only
 * (`validateManifest` warns).
 */
export function cdnExternals(dependencies: Record<string, string>): string[] | null {
  const names = new Set<string>(SHARED_EXTERNALS);
  for (const name of Object.keys(dependencies)) {
    if (isCdnPackage(name, dependencies[name])) names.add(name);
  }
  const list = [...names].sort();
  if (list.length - 1 > MAX_CDN_EXTERNALS) return null;
  if (list.map(inPathName).join(',').length > MAX_EXTERNALS_CHARS) return null;
  return list;
}

/**
 * The `external` list of one CDN URL. The React set has fixed lists, whatever else the
 * manifest holds (`react` and `scheduler` themselves import nothing, so their main URLs have
 * none). Any other package externalizes every other package of the build (`externals`), but
 * not itself: the CDN keeps the package's own modules, and a subpath's import of its own
 * package goes to the main URL with the same list (esm.sh: the same build arguments;
 * @br/pkg-cdn: the same query).
 */
export function urlExternals(
  name: string,
  subpath: string,
  dependencies: Record<string, string>,
  externals: readonly string[] | null,
): string[] {
  if (subpath === '' && (name === 'react' || name === 'scheduler')) return [];
  if (name === 'react') return [...SHARED_EXTERNALS];
  if (name === 'react-dom' || name === 'scheduler') {
    return schedulerPin(dependencies) === null
      ? [...SHARED_EXTERNALS]
      : [...SHARED_EXTERNALS, 'scheduler'];
  }
  if (externals === null) return [...SHARED_EXTERNALS];
  return externals.filter((n) => n !== name);
}

/**
 * esm.sh-shaped URL: `${base}/${name}@${version}${subpath}`, plus `?external=a,b` when the
 * list is not empty. Package CSS and other raw files get no query.
 */
export function cdnModuleUrl(
  cdnBaseUrl: string,
  name: string,
  version: string,
  subpath: string,
  externals: readonly string[] = [],
): string {
  const url = `${trimBase(cdnBaseUrl)}/${name}@${version}${subpath}`;
  return externals.length > 0 ? `${url}?external=${externals.join(',')}` : url;
}

/**
 * The import map's prefix URL for a package's subpaths (`"three/": …`): the same build
 * arguments as its other URLs, written in the path (`/three@0.186.1&external=a,b/`), because
 * an import map appends the rest of the specifier to the prefix, and a `?query` would end up
 * in front of it. esm.sh documents this form for import maps ("change the query prefix `?` to
 * `&` and put it after the package version"); @br/pkg-cdn and the mock CDN accept it too.
 * A module reached through it (`konva/lib/Core.js` imported by `react-konva`) has the same
 * build arguments as the package's main URL, so its import of the package itself is the one
 * instance.
 */
export function cdnPrefixUrl(
  cdnBaseUrl: string,
  name: string,
  version: string,
  externals: readonly string[],
): string {
  const query = externals.length > 0 ? `&external=${externals.map(inPathName).join(',')}` : '';
  return `${trimBase(cdnBaseUrl)}/${name}@${version}${query}/`;
}

export type BareImportResolution =
  /** Leave bare; the shell's import map resolves it. */
  | { kind: 'import-map' }
  /** External ES module URL on the package CDN. */
  | { kind: 'cdn'; url: string }
  /** Package CSS: fetched by the worker and inlined into the CSS bundle. */
  | { kind: 'cdn-css'; url: string }
  | { kind: 'error'; message: string };

/**
 * Decides what a bare import (`zustand`, `three/examples/jsm/x`, `pkg/dist/x.css`) becomes.
 * `externals` defaults to `cdnExternals(dependencies)`; callers resolving many imports of one
 * build pass it in once.
 */
export function resolveBareImport(
  spec: string,
  dependencies: Record<string, string>,
  cdnBaseUrl: string,
  externals: readonly string[] | null = cdnExternals(dependencies),
): BareImportResolution {
  if (isNodeBuiltin(spec)) {
    return {
      kind: 'error',
      message: `"${spec}" is a Node.js built-in module. Node built-ins are not available in the browser sandbox.`,
    };
  }
  const parsed = parseBareSpecifier(spec);
  if (!parsed) return { kind: 'error', message: `"${spec}" is not a valid package import.` };
  const version = ownVersion(dependencies, parsed.name);
  if (version === undefined) {
    return {
      kind: 'error',
      message: `Package "${parsed.name}" is not in dependencies. Add it to the manifest with an exact version (for example "${parsed.name}": "1.2.3").`,
    };
  }
  if (!isPinnedVersion(version)) {
    return {
      kind: 'error',
      message: `Dependency "${parsed.name}" must be pinned to an exact version, got "${version}".`,
    };
  }
  if ((IMPORT_MAP_SPECIFIERS as readonly string[]).includes(spec)) return { kind: 'import-map' };
  if (parsed.subpath.toLowerCase().endsWith('.css')) {
    return {
      kind: 'cdn-css',
      url: cdnModuleUrl(cdnBaseUrl, parsed.name, version, parsed.subpath),
    };
  }
  return {
    kind: 'cdn',
    url: cdnModuleUrl(
      cdnBaseUrl,
      parsed.name,
      version,
      parsed.subpath,
      urlExternals(parsed.name, parsed.subpath, dependencies, externals),
    ),
  };
}

/**
 * The import map the shell installs before any module runs. A pure function of the manifest:
 * REVEAL, the solo last look and the capture renderer rebuild it from a stored build's
 * manifest, so it must not depend on what the bundle imports.
 *
 * - **The React set** (fixed URLs, T-032): `react`, `react/jsx-runtime`,
 *   `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`, and `scheduler` at the exact
 *   version React DOM needs (T-040: on esm.sh, React DOM would import it by range).
 * - **Every other package of the manifest** (T-040): its main URL, the same one the bundle
 *   imports, so a CDN module's bare import of it (it is external everywhere) is the one
 *   instance; and a prefix entry (`"three/"`, `cdnPrefixUrl`) for the subpaths CDN modules
 *   import (`konva/lib/Core.js` inside `react-konva`). `react/` and `react-dom/` get one too
 *   (`react/compiler-runtime`).
 *
 * Every URL is an exact version (no redirect hop that expires). Entries that would break the
 * bridge's limits (URL length) are left out.
 */
export function buildImportMap(
  dependencies: Record<string, string>,
  cdnBaseUrl: string,
): ImportMap {
  const imports: Record<string, string> = {};
  const externals = cdnExternals(dependencies);
  const set = (specifier: string, url: string) => {
    if (url.length <= LIMITS.importMapValueMaxChars) imports[specifier] = url;
  };
  const url = (name: string, version: string, subpath: string) =>
    cdnModuleUrl(
      cdnBaseUrl,
      name,
      version,
      subpath,
      urlExternals(name, subpath, dependencies, externals),
    );
  const prefix = (name: string, version: string) =>
    cdnPrefixUrl(cdnBaseUrl, name, version, urlExternals(name, '/', dependencies, externals));
  const react = ownVersion(dependencies, 'react');
  const reactDom = ownVersion(dependencies, 'react-dom');
  if (react && isPinnedVersion(react)) {
    set('react', url('react', react, ''));
    set('react/jsx-runtime', url('react', react, '/jsx-runtime'));
    set('react/jsx-dev-runtime', url('react', react, '/jsx-dev-runtime'));
    set('react/', prefix('react', react));
  }
  if (reactDom && isPinnedVersion(reactDom)) {
    set('react-dom', url('react-dom', reactDom, ''));
    set('react-dom/client', url('react-dom', reactDom, '/client'));
    set('react-dom/', prefix('react-dom', reactDom));
  }
  const scheduler = schedulerPin(dependencies);
  if (scheduler !== null) set('scheduler', url('scheduler', scheduler, ''));
  for (const name of externals ?? []) {
    if ((REACT_SET as readonly string[]).includes(name)) continue;
    const version = ownVersion(dependencies, name);
    if (version === undefined) continue;
    set(name, url(name, version, ''));
    set(`${name}/`, prefix(name, version));
  }
  return { imports };
}

export type FileLoader = 'tsx' | 'ts' | 'jsx' | 'css' | 'local-css' | 'json' | 'text' | 'asset';

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
]);

/** How a workspace file is loaded. `.js` uses the JSX loader because vibe coders put JSX in .js files. */
export function loaderForPath(p: string): FileLoader | null {
  const ext = extname(p);
  if (p.toLowerCase().endsWith('.module.css')) return 'local-css';
  switch (ext) {
    case '.tsx':
      return 'tsx';
    case '.ts':
    case '.mts':
      return 'ts';
    case '.jsx':
    case '.js':
    case '.mjs':
      return 'jsx';
    case '.css':
      return 'css';
    case '.json':
      return 'json';
    case '.txt':
    case '.md':
      return 'text';
    default:
      return ASSET_EXTENSIONS.has(ext) ? 'asset' : null;
  }
}

/**
 * Decodes an asset file's stored contents to bytes. Binary images are stored in the file map
 * as `data:` URLs (the file map is text only); SVG may also be stored as raw markup.
 */
export function decodeAsset(contents: string): Uint8Array | null {
  if (contents.startsWith('data:')) {
    const comma = contents.indexOf(',');
    if (comma === -1) return null;
    const meta = contents.slice(5, comma);
    const payload = contents.slice(comma + 1);
    if (meta.endsWith(';base64')) {
      try {
        const bin = atob(payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      } catch {
        return null;
      }
    }
    try {
      return new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
      return null;
    }
  }
  if (contents.trimStart().startsWith('<')) return new TextEncoder().encode(contents);
  return null;
}
