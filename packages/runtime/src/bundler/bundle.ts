/**
 * Platform-neutral bundle step: takes an esbuild API object (esbuild-wasm in the browser
 * worker, esbuild-wasm or native esbuild in Node tests) and produces `{js, css, importMap}`.
 */
import type {
  BuildFailure,
  BuildOptions,
  BuildResult as EsbuildResult,
  Message,
  Plugin,
} from 'esbuild-wasm';
import type { BuildResult, BundleInput, Diagnostic } from '../types';
import { errorDetail } from '@br/protocol';
import { PackageFetchError, cdnPlugin, vfsPlugin, type FetchText } from './plugins';
import {
  MAX_CDN_EXTERNALS,
  buildImportMap,
  cdnExternals,
  isPinnedVersion,
  normalizePath,
} from './resolve';

export interface EsbuildApi {
  build(
    options: BuildOptions & { write: false },
  ): Promise<EsbuildResult<BuildOptions & { write: false }>>;
}

export interface BundleOptions {
  cdnBaseUrl: string;
  fetchText: FetchText;
  /** Extra plugins appended after the built-in ones (tests, future tailwind). */
  plugins?: Plugin[];
}

function toDiagnostic(m: Message, severity: Diagnostic['severity']): Diagnostic {
  const d: Diagnostic = { severity, text: m.text };
  if (m.location) {
    d.file = m.location.file.replace(/^(vfs|cdn-css):/, '');
    d.line = m.location.line;
    d.column = m.location.column;
    d.lineText = m.location.lineText;
  }
  return d;
}

function isBuildFailure(e: unknown): e is BuildFailure {
  return typeof e === 'object' && e !== null && Array.isArray((e as { errors?: unknown }).errors);
}

/** Manifest problems that are reported even when the build itself would succeed. */
export function validateManifest(input: BundleInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const deps = input.manifest.dependencies;
  for (const [name, version] of Object.entries(deps)) {
    if (!isPinnedVersion(version)) {
      out.push({
        severity: 'error',
        text: `Dependency "${name}" must be pinned to an exact version, got "${version}".`,
      });
    }
  }
  if (cdnExternals(deps) === null) {
    out.push({
      severity: 'warning',
      text: `More than ${String(MAX_CDN_EXTERNALS)} packages besides React (or very long names): a package that imports another package of your manifest may get its own copy of it (for example two copies of three).`,
    });
  }
  const react = deps['react'];
  const reactDom = deps['react-dom'];
  if (react && reactDom && react !== reactDom) {
    out.push({
      severity: 'warning',
      text: `react (${react}) and react-dom (${reactDom}) versions differ; this usually breaks rendering.`,
    });
  }
  return out;
}

export async function bundle(
  esbuild: EsbuildApi,
  input: BundleInput,
  opts: BundleOptions,
): Promise<BuildResult> {
  const started = performance.now();
  const files: Record<string, string> = {};
  for (const [p, c] of Object.entries(input.files)) files[normalizePath(p)] = c;
  const entry = normalizePath(input.manifest.entry);
  const importMap = buildImportMap(input.manifest.dependencies, opts.cdnBaseUrl);
  const diagnostics = validateManifest(input);
  const fail = (): BuildResult => ({
    ok: false,
    js: '',
    css: '',
    importMap,
    diagnostics,
    durationMs: performance.now() - started,
  });
  if (diagnostics.some((d) => d.severity === 'error')) return fail();
  const packages = new Set<string>();

  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      outdir: '/out',
      entryNames: 'bundle',
      minify: input.mode === 'production',
      legalComments: 'none',
      logLevel: 'silent',
      charset: 'utf8',
      define: {
        'process.env.NODE_ENV': JSON.stringify(
          input.mode === 'production' ? 'production' : 'development',
        ),
      },
      plugins: [
        vfsPlugin(files, entry),
        cdnPlugin({
          dependencies: input.manifest.dependencies,
          cdnBaseUrl: opts.cdnBaseUrl,
          fetchText: opts.fetchText,
          onModule: (url) => {
            packages.add(url);
          },
          onImportMapSpecifier: (specifier) => {
            const url = importMap.imports[specifier];
            if (url !== undefined) packages.add(url);
          },
        }),
        ...(opts.plugins ?? []),
      ],
    });
    for (const w of result.warnings) diagnostics.push(toDiagnostic(w, 'warning'));
    let js = '';
    let css = '';
    for (const f of result.outputFiles) {
      if (f.path.endsWith('.js')) js = f.text;
      else if (f.path.endsWith('.css')) css = f.text;
    }
    return {
      ok: true,
      js,
      css,
      importMap,
      diagnostics,
      durationMs: performance.now() - started,
      // Sorted: esbuild resolves imports concurrently, so the insertion order varies.
      packages: [...packages].sort(),
    };
  } catch (e) {
    if (isBuildFailure(e)) {
      for (const m of e.errors) diagnostics.push(toDiagnostic(m, 'error'));
      for (const m of e.warnings) diagnostics.push(toDiagnostic(m, 'warning'));
    } else {
      diagnostics.push({
        severity: 'error',
        text: `Bundler crashed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return fail();
  }
}

/** Wraps a fetcher with an in-memory cache (package CSS is immutable per pinned version). */
export function cachedFetchText(
  fetchText: FetchText,
  cache = new Map<string, Promise<string>>(),
): FetchText {
  return (url) => {
    let p = cache.get(url);
    if (!p) {
      p = fetchText(url);
      cache.set(url, p);
      p.catch(() => cache.delete(url));
    }
    return p;
  };
}

/**
 * Default fetcher for the worker: CORS GET, non-2xx is an error. The default cache mode lets
 * the browser's HTTP cache answer (package URLs are exact versions, served `immutable`), so
 * package CSS fetched once still builds while the CDN is unreachable (T-032). Failures are
 * `PackageFetchError`s.
 */
export const fetchTextFromNetwork: FetchText = async (url) => {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit' });
  } catch {
    throw new PackageFetchError(null);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PackageFetchError(res.status, errorDetail(body) || undefined);
  }
  return res.text();
};
