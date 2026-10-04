/**
 * Bundles one package entry (`name@version/subpath`) from an installed dependency tree into a
 * single ES module with esbuild. No package code ever runs on the server: esbuild only parses.
 *
 * Import handling, in order:
 * 1. `external` packages (and their subpaths) stay bare imports, for the page's import map
 *    (`react`, `react-dom`: one React instance, docs/03 §3.4).
 * 2. Peer dependencies of the requested package, and peers of a dependency that the tree does
 *    not provide, become CDN URLs (`/three@0.180.0?external=react,react-dom`), so they are
 *    a separate, shared module instead of a second copy inside this bundle.
 * 3. Bare imports of the requested package itself from inside it (`three/examples/...`
 *    importing `three`) become CDN URLs of that entry, so subpaths share one instance.
 * 4. Everything else is resolved by esbuild inside the tree (`exports` with the `browser`,
 *    `module`, `production`/`development` conditions, `browser`/`module`/`main` fields) and
 *    bundled. Node built-ins that the tree cannot provide become empty stubs (with a warning).
 *
 * A CommonJS `require()` of something external cannot stay a `require` in an ES module, so it
 * is routed through a tiny ES module shim that re-exports the external module. CommonJS
 * entries get real named exports, computed statically with cjs-module-lexer (no evaluation).
 *
 * Every file esbuild loads must be inside the tree (or the shim directory); anything else is
 * refused, so a malicious `browser` map or `tsconfig` cannot read server files.
 */
import { realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { init as initCjsLexer, parse as parseCjs } from 'cjs-module-lexer';
import { init as initEsmLexer, parse as parseEsm } from 'es-module-lexer';
import { CdnError, errorMessage } from './errors';
import { abortReason, throwIfAborted } from './limiter';
import { isNodeBuiltin, packageNameOf, splitSpecifier } from './names';
import type { InstalledTree, TreeNode } from './tree';
import { packageLocationOf } from './tree';
import { formatQuery, packagePath, type BuildTarget } from './url';

/** Bump to invalidate every cached bundle when the output format changes. */
export const BUILD_FORMAT = 'b3';

export interface BuildRequest {
  name: string;
  version: string;
  subpath: string;
  external: string[];
  deps: Record<string, string>;
  target: BuildTarget;
  dev: boolean;
}

export interface BuildOutput {
  code: string;
  /** Module format of the entry file before bundling. */
  format: 'esm' | 'cjs' | 'json';
  warnings: string[];
  /** Node built-ins replaced by empty stubs. */
  stubbedBuiltins: string[];
  /** CDN URLs this module imports (peers, self subpaths). */
  externalUrls: string[];
}

export interface BundleContext {
  tree: InstalledTree;
  /** Directory holding the injected `process` shim. */
  shimDir: string;
  /** Exact version to use for an externalized peer dependency. */
  resolvePeerVersion(name: string, range: string): Promise<string>;
  maxOutputBytes: number;
  timeoutMs: number;
  /** Cancels the build (every request that wanted it went away). */
  signal?: AbortSignal | undefined;
}

const ENTRY_NS = 'pkg-cdn-entry';
const EXTERNAL_CJS_NS = 'pkg-cdn-external-cjs';
const STUB_NS = 'pkg-cdn-node-stub';
/** Modules disabled by a package's `"browser": { "x": false }` map. */
const EMPTY_NS = 'pkg-cdn-empty';

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval'.split(
    ' ',
  ),
);
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

const lexersReady = Promise.all([initCjsLexer(), initEsmLexer()]);

export const PROCESS_SHIM = `export const process = {
  env: { NODE_ENV: __PKG_CDN_NODE_ENV__ },
  browser: true,
  version: '',
  versions: {},
  platform: 'browser',
  argv: [],
  cwd: () => '/',
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};
`;

function isInside(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir + path.sep);
}

interface EntryWrapper {
  /** Wrapper module source, or null when the entry file can be the esbuild entry itself. */
  code: string | null;
  format: BuildOutput['format'];
}

/** Named exports of a CommonJS file, following `module.exports = require(...)` re-exports. */
async function cjsExportNames(
  file: string,
  resolveRequire: (spec: string, fromDir: string) => Promise<string | null>,
  seen = new Set<string>(),
): Promise<Set<string>> {
  const names = new Set<string>();
  if (seen.has(file) || seen.size > 64) return names;
  seen.add(file);
  let parsed: { exports: string[]; reexports: string[] };
  try {
    parsed = parseCjs(await readFile(file, 'utf8'));
  } catch {
    return names;
  }
  for (const n of parsed.exports) names.add(n);
  for (const r of parsed.reexports) {
    const target = await resolveRequire(r, path.dirname(file));
    if (target) for (const n of await cjsExportNames(target, resolveRequire, seen)) names.add(n);
  }
  return names;
}

async function makeEntryWrapper(
  file: string,
  resolveRequire: (spec: string, fromDir: string) => Promise<string | null>,
): Promise<EntryWrapper> {
  await lexersReady;
  const s = JSON.stringify(file);
  if (file.toLowerCase().endsWith('.json')) {
    return { code: `export { default } from ${s};\n`, format: 'json' };
  }
  const source = await readFile(file, 'utf8');
  let esm: boolean;
  try {
    esm = parseEsm(source)[3];
  } catch {
    // The lexer could not parse it (unusual syntax). Fall back to a keyword sniff.
    esm = /^\s*(?:import|export)\s/m.test(source);
  }
  // An ES module is the esbuild entry itself: its exports (including `export * from` an
  // external URL) then stay static in the output. A wrapper module would hide them.
  if (esm) return { code: null, format: 'esm' };
  const names = [...(await cjsExportNames(file, resolveRequire))]
    .filter(
      (n) =>
        IDENT_RE.test(n) && !RESERVED.has(n) && n !== '__esModule' && !n.startsWith('__pkgcdn'),
    )
    .sort();
  // `import * as` + esbuild's interop: `default` is module.exports, or exports.default when
  // the module sets __esModule (the same convention as esm.sh and bundlers).
  const named = names.length > 0 ? `export const { ${names.join(', ')} } = __pkgcdn_ns;\n` : '';
  return {
    code: `import * as __pkgcdn_ns from ${s};\nexport default __pkgcdn_ns.default;\n${named}`,
    format: 'cjs',
  };
}

function nodeForFile(tree: InstalledTree, treeDir: string, file: string): TreeNode | undefined {
  const rel = path.relative(treeDir, file);
  const loc = packageLocationOf(rel);
  return loc === null ? undefined : tree.nodeByLocation.get(loc);
}

/** Bundles `req` from `ctx.tree`. Throws CdnError on failure. */
export async function bundlePackage(req: BuildRequest, ctx: BundleContext): Promise<BuildOutput> {
  const treeDir = realpathSync(ctx.tree.dir);
  const shimDir = realpathSync(ctx.shimDir);
  const rootLocation = ctx.tree.rootLocation;
  const rootNode = ctx.tree.nodeByLocation.get(rootLocation);
  if (!rootNode) throw new CdnError(500, 'build-failed', 'dependency tree has no root package');
  const rootDir = path.join(treeDir, rootLocation);
  const externals = new Set(req.external);
  const spec = req.name + req.subpath;
  const query = formatQuery(req);
  const warnings: string[] = [];
  const stubbed = new Set<string>();
  const externalUrls = new Set<string>();
  let entryFile: string | null = null;
  let entryFormat: BuildOutput['format'] = 'esm';

  const cdnUrl = (name: string, version: string, subpath: string): string => {
    const url = packagePath(name, version, subpath) + query;
    externalUrls.add(url);
    return url;
  };

  const externalRef = (kind: esbuild.ImportKind, target: string): esbuild.OnResolveResult =>
    kind === 'require-call'
      ? { path: target, namespace: EXTERNAL_CJS_NS }
      : { path: target, external: true };

  const plugin: esbuild.Plugin = {
    name: 'pkg-cdn',
    setup(build) {
      const resolveInside = async (
        specifier: string,
        opts: { kind: esbuild.ImportKind; resolveDir: string; importer?: string },
      ): Promise<esbuild.ResolveResult | null> => {
        const r = await build.resolve(specifier, {
          kind: opts.kind,
          resolveDir: opts.resolveDir,
          ...(opts.importer !== undefined ? { importer: opts.importer } : {}),
          pluginData: { inner: true },
        });
        if (r.errors.length > 0 || r.external) return null;
        const namespace = r.namespace === '' ? 'file' : r.namespace;
        // esbuild reports a module disabled by the `browser` field as a non-absolute path.
        if (namespace === 'file' && !path.isAbsolute(r.path)) return { ...r, namespace: EMPTY_NS };
        if (namespace === 'file' && !isInside(r.path, treeDir)) return null;
        return { ...r, namespace };
      };

      let wrapperCode = '';
      build.onResolve({ filter: /.*/ }, async (args) => {
        // `inject` files are resolved with kind 'entry-point' too: only take our entry.
        if (args.kind !== 'entry-point' || args.path !== spec) return undefined;
        const r = await resolveInside(spec, { kind: 'import-statement', resolveDir: treeDir });
        if (r?.namespace !== 'file' || r.path === '') {
          const what = req.subpath === '' ? 'an entry point' : `the subpath ".${req.subpath}"`;
          throw new CdnError(
            404,
            'not-found',
            `${req.name}@${req.version} has no browser-loadable ${what} (check its "exports")`,
          );
        }
        entryFile = r.path;
        const wrapper = await makeEntryWrapper(r.path, async (s, fromDir) => {
          const t = await resolveInside(s, { kind: 'require-call', resolveDir: fromDir });
          return t?.namespace === 'file' ? t.path : null;
        });
        entryFormat = wrapper.format;
        if (wrapper.code === null) return { path: r.path };
        wrapperCode = wrapper.code;
        return { path: spec, namespace: ENTRY_NS };
      });

      build.onLoad({ filter: /.*/, namespace: ENTRY_NS }, () => ({
        contents: wrapperCode,
        loader: 'js',
        resolveDir: treeDir,
      }));

      // The require() shim imports its target, which is external by construction (a bare
      // import-map specifier or a root-relative CDN URL).
      build.onResolve({ filter: /.*/, namespace: EXTERNAL_CJS_NS }, (args) => ({
        path: args.path,
        external: true,
      }));

      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if ((args.pluginData as { inner?: boolean } | undefined)?.inner) return undefined;
        if (args.kind === 'entry-point') return undefined;
        if (/^(?:https?|data):/i.test(args.path)) return { path: args.path, external: true };
        const name = packageNameOf(args.path);
        if (externals.has(name)) return externalRef(args.kind, args.path);

        const importerNode =
          args.namespace === 'file' ? nodeForFile(ctx.tree, treeDir, args.importer) : undefined;
        const { subpath } = splitSpecifier(args.path);

        // Peers of the requested package are provided by the page, never bundled.
        const rootPeerRange = name === req.name ? undefined : rootNode.peers[name];
        if (rootPeerRange !== undefined) {
          const range = importerNode?.peers[name] ?? rootPeerRange;
          return externalRef(
            args.kind,
            cdnUrl(name, await ctx.resolvePeerVersion(name, range), subpath),
          );
        }

        const r = await resolveInside(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
        });
        if (r?.namespace === EMPTY_NS) return { path: args.path, namespace: EMPTY_NS };
        if (r) {
          if (
            name === req.name &&
            r.namespace === 'file' &&
            isInside(r.path, rootDir) &&
            r.path !== entryFile
          ) {
            // Self-reference from inside the package: share the other entry's module.
            return externalRef(args.kind, cdnUrl(req.name, req.version, subpath));
          }
          return {
            path: r.path,
            namespace: r.namespace,
            sideEffects: r.sideEffects,
            ...(r.suffix ? { suffix: r.suffix } : {}),
          };
        }

        // Not in the tree: a peer of the importing dependency becomes a CDN URL.
        const peerRange = importerNode?.peers[name];
        if (peerRange !== undefined) {
          return externalRef(
            args.kind,
            cdnUrl(name, await ctx.resolvePeerVersion(name, peerRange), subpath),
          );
        }
        if (isNodeBuiltin(args.path)) {
          const builtin = args.path.replace(/^node:/, '');
          stubbed.add(builtin);
          return { path: builtin, namespace: STUB_NS };
        }
        const from = path.relative(treeDir, args.importer) || args.importer;
        return {
          errors: [
            {
              text: `Could not resolve "${args.path}" (imported by ${from}); it is not a dependency of the importing package`,
            },
          ],
        };
      });

      build.onLoad({ filter: /.*/, namespace: EXTERNAL_CJS_NS }, (args) => {
        const s = JSON.stringify(args.path);
        return {
          contents: `import * as ns from ${s};\nexport * from ${s};\nexport default ('default' in ns ? ns.default : ns);\n`,
          loader: 'js',
          resolveDir: treeDir,
        };
      });

      build.onLoad({ filter: /.*/, namespace: EMPTY_NS }, () => ({
        contents: 'module.exports = {};\n',
        loader: 'js',
      }));

      build.onLoad({ filter: /.*/, namespace: STUB_NS }, (args) => {
        warnings.push(
          `Node built-in "${args.path}" is not available in the browser; it was replaced by an empty module`,
        );
        return { contents: 'module.exports = {};\n', loader: 'js' };
      });

      // Load guard: only files inside the tree (or our shim directory) may be read.
      build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        let real: string;
        try {
          real = await realpath(args.path);
        } catch {
          return { errors: [{ text: `Cannot read ${path.basename(args.path)}` }] };
        }
        if (!isInside(real, treeDir) && !isInside(real, shimDir)) {
          return { errors: [{ text: 'Refusing to load a file outside the package tree' }] };
        }
        return undefined;
      });
    },
  };

  const nodeEnv = req.dev ? 'development' : 'production';
  // Mutated from callbacks (timer, finally), so kept in an object rather than `let`s.
  const run: {
    ctx: esbuild.BuildContext | null;
    timer: ReturnType<typeof setTimeout> | null;
    timedOut: boolean;
    onAbort: (() => void) | null;
  } = { ctx: null, timer: null, timedOut: false, onAbort: null };
  try {
    const ctxBuild = await esbuild.context({
      entryPoints: [spec],
      absWorkingDir: treeDir,
      bundle: true,
      write: false,
      metafile: false,
      format: 'esm',
      platform: 'browser',
      target: req.target,
      conditions: [nodeEnv, 'module'],
      outdir: path.join(treeDir, '.out'),
      minify: !req.dev,
      legalComments: 'eof',
      charset: 'utf8',
      logLevel: 'silent',
      // Never pick up a tsconfig.json from the server's filesystem (or the package's paths).
      tsconfigRaw: '{}',
      define: {
        'process.env.NODE_ENV': JSON.stringify(nodeEnv),
        __PKG_CDN_NODE_ENV__: JSON.stringify(nodeEnv),
        global: 'globalThis',
      },
      inject: [path.join(shimDir, 'process.js')],
      loader: {
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.webp': 'dataurl',
        '.svg': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.ttf': 'dataurl',
        '.eot': 'dataurl',
      },
      plugins: [plugin],
    });
    run.ctx = ctxBuild;
    throwIfAborted(ctx.signal);
    const building = ctxBuild.rebuild();
    const timeout = new Promise<never>((_, reject) => {
      run.timer = setTimeout(() => {
        run.timedOut = true;
        void ctxBuild.cancel();
        reject(
          new CdnError(504, 'timeout', `bundling took longer than ${ctx.timeoutMs.toString()} ms`),
        );
      }, ctx.timeoutMs);
      run.onAbort = () => {
        void ctxBuild.cancel();
        reject(abortReason(ctx.signal));
      };
      ctx.signal?.addEventListener('abort', run.onAbort, { once: true });
    });
    const result = await Promise.race([building, timeout]);
    for (const w of result.warnings) warnings.push(w.text);
    let js = '';
    let css = '';
    for (const f of result.outputFiles) {
      if (f.path.endsWith('.js')) js = f.text;
      else if (f.path.endsWith('.css')) css = f.text;
    }
    if (css !== '') {
      // CSS imported by package JS: inject it when the module runs (esm.sh does the same).
      js = `(()=>{if(typeof document!=="undefined"){const s=document.createElement("style");s.dataset.pkg=${JSON.stringify(`${req.name}@${req.version}`)};s.textContent=${JSON.stringify(css)};document.head.appendChild(s)}})();\n${js}`;
    }
    const ext = req.external.length > 0 ? `, external: ${req.external.join(',')}` : '';
    const header = `/* @br/pkg-cdn ${req.name}@${req.version}${req.subpath} (${entryFormat}${ext}, ${req.target}${req.dev ? ', dev' : ''}) */\n`;
    const code = header + js;
    if (Buffer.byteLength(code) > ctx.maxOutputBytes) {
      throw new CdnError(
        413,
        'too-large',
        `bundle of ${spec} is ${Math.round(Buffer.byteLength(code) / 1024).toString()} KB; the limit is ${Math.round(ctx.maxOutputBytes / 1024).toString()} KB`,
      );
    }
    return {
      code,
      format: entryFormat,
      warnings,
      stubbedBuiltins: [...stubbed].sort(),
      externalUrls: [...externalUrls].sort(),
    };
  } catch (e) {
    if (e instanceof CdnError) throw e;
    if (ctx.signal?.aborted) throw abortReason(ctx.signal);
    if (run.timedOut)
      throw new CdnError(
        504,
        'timeout',
        `bundling took longer than ${ctx.timeoutMs.toString()} ms`,
      );
    const failure = e as Partial<esbuild.BuildFailure>;
    if (Array.isArray(failure.errors) && failure.errors.length > 0) {
      // A CdnError thrown inside a plugin callback arrives as an esbuild error with `detail`.
      for (const m of failure.errors) {
        if (m.detail instanceof CdnError) throw m.detail;
      }
      const lines = failure.errors.slice(0, 5).map((m) => {
        const loc = m.location
          ? ` (${m.location.file.replace(/^.*?node_modules\//, 'node_modules/')}:${m.location.line.toString()})`
          : '';
        return `${m.text}${loc}`;
      });
      throw new CdnError(422, 'build-failed', `failed to bundle ${spec}: ${lines.join('; ')}`);
    }
    throw new CdnError(500, 'build-failed', `failed to bundle ${spec}: ${errorMessage(e)}`);
  } finally {
    if (run.timer !== null) clearTimeout(run.timer);
    if (run.onAbort) ctx.signal?.removeEventListener('abort', run.onAbort);
    if (run.ctx) await run.ctx.dispose();
  }
}
