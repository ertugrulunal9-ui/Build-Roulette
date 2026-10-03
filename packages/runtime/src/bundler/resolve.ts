/**
 * Pure module-resolution logic for the bundler plugins. No esbuild, no I/O, so it is unit
 * tested directly in Node.
 */
import type { ImportMap } from '@br/protocol';
import type { FileMap } from '../types';

/** Extensions tried, in order, for extensionless relative imports. */
export const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'] as const;

/** Specifiers that stay bare in the bundle and are resolved by the shell's import map. */
export const IMPORT_MAP_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
] as const;

/** Packages every CDN module is built against as externals, so React is a single instance. */
export const SHARED_EXTERNALS = ['react', 'react-dom'] as const;

/** Most `deps=` pins the package CDN accepts in one URL (apps/pkg-cdn `MAX_DEPS`). */
export const MAX_CDN_DEPS = 32;

/** Max size of an image asset file (docs/03 §3.3). */
export const MAX_ASSET_BYTES = 200 * 1024;

const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(
    ' ',
  ),
);

const PINNED_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Names the package CDN accepts in `deps=` (new-style npm names, as in apps/pkg-cdn). */
const CDN_DEPS_NAME_RE = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;
const CDN_RESERVED_NAMES = new Set(['node_modules', 'favicon.ico']);
/**
 * Versions the package CDN accepts in `deps=`: strict SemVer 2.0 without build metadata
 * (`semver.valid(v) === v`). Build metadata would be dropped by the CDN, and `+` in a query
 * string reads as a space.
 */
const CDN_DEPS_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

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

/** Splits `@scope/pkg/sub/path` into name and subpath. Returns null for invalid names. */
export function parseBareSpecifier(spec: string): BareSpecifier | null {
  const parts = spec.split('/');
  const nameParts = spec.startsWith('@') ? 2 : 1;
  if (parts.length < nameParts) return null;
  const name = parts.slice(0, nameParts).join('/');
  if (!PACKAGE_NAME_RE.test(name)) return null;
  const rest = parts.slice(nameParts);
  if (rest.some((s) => s === '' || s === '.' || s === '..')) return null;
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

/**
 * The `deps=` pins for CDN module URLs: every manifest dependency except the shared
 * externals (React stays bare), as `name@version`, sorted by package name. The package CDN
 * uses them as the versions of peer dependencies it emits as CDN URLs, so a peer like `three`
 * inside `@react-three/fiber` is the manifest's `three`, not npm's newest match.
 *
 * Every CDN URL of a build carries the same list, the package itself included. The CDN
 * emits peer URLs with the query of the request (`/three@0.186.1?external=…&deps=…`), so
 * this keeps the user's own `import 'three'` and fiber's peer import byte-identical: one
 * module instance. The order matches the CDN's (by name, then `name@version`), so the URLs
 * are deterministic.
 *
 * Entries the CDN would reject (non-npm names, versions with build metadata or that are not
 * exact) are left out. With more than `MAX_CDN_DEPS` entries the CDN would reject every
 * URL, so this returns null: callers send no `deps=` and peers fall back to the CDN's own
 * version pick (`validateManifest` warns).
 */
export function cdnDepsPins(dependencies: Record<string, string>): string[] | null {
  const names = Object.keys(dependencies)
    .filter((name) => {
      const version = dependencies[name];
      return (
        !(SHARED_EXTERNALS as readonly string[]).includes(name) &&
        name.length <= 214 &&
        CDN_DEPS_NAME_RE.test(name) &&
        !CDN_RESERVED_NAMES.has(name) &&
        version !== undefined &&
        CDN_DEPS_VERSION_RE.test(version)
      );
    })
    .sort();
  if (names.length > MAX_CDN_DEPS) return null;
  return names.map((name) => `${name}@${dependencies[name] ?? ''}`);
}

/**
 * esm.sh-shaped URL: `${base}/${name}@${version}${subpath}`, plus
 * `?external=react,react-dom[&deps=…]` for JS modules.
 */
export function cdnModuleUrl(
  cdnBaseUrl: string,
  name: string,
  version: string,
  subpath: string,
  withExternals = true,
  deps: readonly string[] = [],
): string {
  const url = `${trimBase(cdnBaseUrl)}/${name}@${version}${subpath}`;
  if (!withExternals) return url;
  const query = `?external=${SHARED_EXTERNALS.join(',')}`;
  return deps.length > 0 ? `${url}${query}&deps=${deps.join(',')}` : `${url}${query}`;
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
 * `deps` defaults to `cdnDepsPins(dependencies)`; callers resolving many imports of one
 * build pass it in once.
 */
export function resolveBareImport(
  spec: string,
  dependencies: Record<string, string>,
  cdnBaseUrl: string,
  deps: readonly string[] = cdnDepsPins(dependencies) ?? [],
): BareImportResolution {
  if (isNodeBuiltin(spec)) {
    return {
      kind: 'error',
      message: `"${spec}" is a Node.js built-in module. Node built-ins are not available in the browser sandbox.`,
    };
  }
  const parsed = parseBareSpecifier(spec);
  if (!parsed) return { kind: 'error', message: `"${spec}" is not a valid package import.` };
  const version = Object.prototype.hasOwnProperty.call(dependencies, parsed.name)
    ? dependencies[parsed.name]
    : undefined;
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
      url: cdnModuleUrl(cdnBaseUrl, parsed.name, version, parsed.subpath, false),
    };
  }
  return {
    kind: 'cdn',
    url: cdnModuleUrl(cdnBaseUrl, parsed.name, version, parsed.subpath, true, deps),
  };
}

/**
 * The import map the shell installs before any module runs. Only React's own entry points
 * are mapped; every other package is a full CDN URL in the bundle.
 */
export function buildImportMap(
  dependencies: Record<string, string>,
  cdnBaseUrl: string,
): ImportMap {
  const imports: Record<string, string> = {};
  const react = dependencies['react'];
  const reactDom = dependencies['react-dom'];
  if (react && isPinnedVersion(react)) {
    imports['react'] = cdnModuleUrl(cdnBaseUrl, 'react', react, '', false);
    imports['react/jsx-runtime'] = cdnModuleUrl(cdnBaseUrl, 'react', react, '/jsx-runtime');
    imports['react/jsx-dev-runtime'] = cdnModuleUrl(cdnBaseUrl, 'react', react, '/jsx-dev-runtime');
  }
  if (reactDom && isPinnedVersion(reactDom)) {
    imports['react-dom'] = cdnModuleUrl(cdnBaseUrl, 'react-dom', reactDom, '');
    imports['react-dom/client'] = cdnModuleUrl(cdnBaseUrl, 'react-dom', reactDom, '/client');
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
