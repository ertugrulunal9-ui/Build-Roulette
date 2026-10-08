/**
 * Mock ESM package CDN that emulates the esm.sh URL shape for packages installed locally.
 *
 *   GET /<name>@<version>[/<subpath>][?external=a,b][&deps=x@1.2.3][&dev]
 *
 * - JS entries are bundled on demand from local node_modules into a single ES module with
 *   esbuild and cached in memory. CommonJS entries (React 18/19 ship CJS) get an ESM wrapper
 *   with real named exports, computed statically with cjs-module-lexer (no package code runs
 *   on the server).
 * - `external` keeps the listed packages (and their subpaths) as bare imports, so the page's
 *   import map resolves them to one shared instance. A CommonJS `require('react')` of an
 *   external package is rewritten to an ESM import of it, which is what esm.sh does too.
 * - `deps` (peer version pins, sent by the runtime's cdn-rewrite) and other unknown
 *   parameters are ignored: the mock bundles every dependency into the module, so it never
 *   emits peer URLs that pins would apply to.
 * - Non-JS subpaths (`.css`, fonts, images, `.json`) are served raw from the package.
 * - Only allowlisted packages are served, and only at the exact installed version (a real
 *   CDN would hold many versions; the mock answers 404 with a clear reason instead).
 *
 * This is also the seed of a self-hosted CDN: URL parsing, the CJS->ESM wrapper and the
 * external handling are the parts that carry over.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { init as initCjsLexer, parse as parseCjs } from 'cjs-module-lexer';
import { init as initEsmLexer, parse as parseEsm } from 'es-module-lexer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESOLVE_FROM = path.resolve(HERE, '..');

export const DEFAULT_ALLOWED_PACKAGES = ['react', 'react-dom', 'zustand', 'animate.css'] as const;

export interface CdnRequest {
  name: string;
  version: string;
  /** '' or '/sub/path' */
  subpath: string;
}

const NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

/** Parses `/<name>@<version>[/<subpath>]`. Returns null for anything else. Pure. */
export function parseCdnPath(pathname: string): CdnRequest | null {
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
  const at = head.lastIndexOf('@');
  if (at <= 0) return null;
  const name = head.slice(0, at);
  const version = head.slice(at + 1);
  if (!NAME_RE.test(name) || !VERSION_RE.test(version)) return null;
  if (subpath.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (subpath === '/') return { name, version, subpath: '' };
  return { name, version, subpath };
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

export interface MockCdnOptions {
  port?: number;
  host?: string;
  /** Directory whose node_modules hold the served packages. Defaults to packages/runtime. */
  resolveFrom?: string;
  allowedPackages?: readonly string[];
  log?: (line: string) => void;
}

/**
 * A simulated outage of the package CDN (T-032 e2e):
 * - `refuse`: the listener is closed and open connections are dropped, so the browser gets
 *   "connection refused" at once (the container is down and nothing answers for it);
 * - `error`: every request gets a `502` without CORS headers, like an error page from the
 *   edge in front of a dead origin (the browser sees a CORS failure, i.e. a network error);
 * - `hang`: requests are accepted and never answered (a black hole, or an edge waiting for
 *   an origin that does not answer).
 * `null` ends the outage.
 */
export type CdnOutage = 'refuse' | 'error' | 'hang';

export const CDN_OUTAGES: readonly CdnOutage[] = ['refuse', 'error', 'hang'];

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

interface PackageInfo {
  dir: string;
  version: string;
}

function noLog(): void {
  // Logging is opt-in.
}

export function createMockCdnHandler(opts: MockCdnOptions = {}) {
  const resolveFrom = opts.resolveFrom ?? DEFAULT_RESOLVE_FROM;
  const allowed = new Set(opts.allowedPackages ?? DEFAULT_ALLOWED_PACKAGES);
  const log = opts.log ?? noLog;
  const cache = new Map<string, Promise<string>>();
  const stats = { builds: 0, requests: 0 };
  const lexersReady = Promise.all([initCjsLexer(), initEsmLexer()]);

  function findPackage(name: string): PackageInfo | null {
    const req = createRequire(path.join(resolveFrom, 'noop.js'));
    for (const base of req.resolve.paths(name) ?? []) {
      const pj = path.join(base, name, 'package.json');
      if (existsSync(pj)) {
        const json = JSON.parse(readFileSync(pj, 'utf8')) as { version?: string };
        return { dir: realpathSync(path.dirname(pj)), version: json.version ?? '0.0.0' };
      }
    }
    return null;
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

  async function wrapperFor(
    spec: string,
    resolveDir: string,
  ): Promise<{ code: string; format: 'esm' | 'cjs' }> {
    await lexersReady;
    const file = await resolveEntry(spec, resolveDir);
    const source = readFileSync(file, 'utf8');
    const s = JSON.stringify(spec);
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

  async function bundle(
    req: CdnRequest,
    pkg: PackageInfo,
    externals: Set<string>,
    dev: boolean,
  ): Promise<string> {
    const spec = req.name + req.subpath;
    const resolveDir = resolveFrom;
    const wrapper = await wrapperFor(spec, resolveDir);
    const sourcefile = `mock-cdn-entry:${spec}`;
    // esbuild reports the stdin importer as resolveDir + sourcefile.
    const entryImporter = path.join(resolveDir, sourcefile);
    stats.builds++;
    const result = await esbuild.build({
      stdin: { contents: wrapper.code, resolveDir, loader: 'js', sourcefile },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: !dev,
      legalComments: 'none',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
      plugins: [
        {
          name: 'cdn-externals',
          setup(build) {
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              // The wrapper's import of the target itself is never external.
              if (args.importer === entryImporter) return undefined;
              // Imports inside the CJS shim always point at the external package.
              if (args.namespace === 'external-cjs') return { path: args.path, external: true };
              if (!externals.has(packageNameOf(args.path))) return undefined;
              if (args.kind === 'require-call') {
                // CJS `require('react')` cannot stay a require in an ES module: route it
                // through an ESM shim that re-exports the external module's namespace.
                return { path: args.path, namespace: 'external-cjs' };
              }
              return { path: args.path, external: true };
            });
            build.onLoad({ filter: /.*/, namespace: 'external-cjs' }, (args) => {
              const s = JSON.stringify(args.path);
              return {
                contents: `export * from ${s};\nexport { default } from ${s};\n`,
                loader: 'js',
                resolveDir,
              };
            });
          },
        },
      ],
    });
    const text = result.outputFiles[0]?.text ?? '';
    const ext = [...externals].sort().join(',');
    return `/* mock-cdn ${req.name}@${pkg.version}${req.subpath} (${wrapper.format}${ext ? `, external: ${ext}` : ''}${dev ? ', dev' : ''}) */\n${text}`;
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

    const parsed = parseCdnPath(url.pathname);
    if (!parsed) {
      send(
        res,
        400,
        'text/plain',
        `mock-cdn: unsupported URL ${url.pathname} (expected /<name>@<x.y.z>[/subpath])`,
      );
      return;
    }
    if (!allowed.has(parsed.name)) {
      send(
        res,
        404,
        'text/plain',
        `mock-cdn: package "${parsed.name}" is not served by the mock CDN`,
      );
      return;
    }
    const pkg = findPackage(parsed.name);
    if (!pkg) {
      send(res, 404, 'text/plain', `mock-cdn: package "${parsed.name}" is not installed`);
      return;
    }
    if (pkg.version !== parsed.version) {
      send(
        res,
        404,
        'text/plain',
        `mock-cdn: ${parsed.name}@${parsed.version} not available (installed: ${pkg.version})`,
      );
      return;
    }

    const ext = path.extname(parsed.subpath).toLowerCase();
    const rawType = RAW_TYPES[ext];
    if (rawType) {
      const file = path.join(pkg.dir, parsed.subpath);
      const real = existsSync(file) ? realpathSync(file) : '';
      if (!real || !real.startsWith(pkg.dir + path.sep) || !statSync(real).isFile()) {
        send(
          res,
          404,
          'text/plain',
          `mock-cdn: ${parsed.name}@${parsed.version}${parsed.subpath} not found`,
        );
        return;
      }
      send(res, 200, rawType, await readFile(real), {
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return;
    }

    const externals = new Set(
      (url.searchParams.get('external') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const dev = url.searchParams.has('dev');
    const key = `${parsed.name}@${parsed.version}${parsed.subpath}|${[...externals].sort().join(',')}|${dev ? 'dev' : 'prod'}`;
    let job = cache.get(key);
    if (!job) {
      const started = performance.now();
      job = bundle(parsed, pkg, externals, dev);
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
    try {
      const code = await job;
      send(res, 200, 'application/javascript; charset=utf-8', code, {
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      send(
        res,
        500,
        'text/plain',
        `mock-cdn: failed to build ${parsed.name}@${parsed.version}${parsed.subpath}: ${msg}`,
      );
    }
  }

  return { handle, stats };
}

export async function startMockCdn(opts: MockCdnOptions = {}): Promise<MockCdn> {
  const { handle, stats } = createMockCdnHandler(opts);
  const host = opts.host ?? 'localhost';
  let outage: CdnOutage | null = null;
  /** Requests held open by a `hang` outage, released when it ends. */
  const held = new Set<ServerResponse>();
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
      held.add(res);
      res.on('close', () => held.delete(res));
      return;
    }
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
      if (outage === 'hang') {
        for (const res of held) res.destroy();
        held.clear();
      }
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
    },
    close: async () => {
      for (const res of held) res.destroy();
      held.clear();
      if (server) await stop(server);
      server = null;
    },
  };
}
