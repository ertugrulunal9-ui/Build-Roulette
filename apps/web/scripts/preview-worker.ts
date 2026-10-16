/**
 * Bundles T-038's link-preview Worker (src/lib/hosting/preview-worker.ts) into the app's
 * Worker module, `dist/worker.js` (T-043: `main` of apps/web/wrangler.jsonc, whose
 * `run_worker_first: ["/battles/*"]` limits it to `/battles/*`). scripts/pages-config.ts runs
 * it on every build; the CPU measurement and the outage e2e build variants of it (a Supabase
 * that is slow or down).
 *
 * Like Next's bundles, the worker gets the build's `NEXT_PUBLIC_*` values inlined (`process.env`
 * does not exist in a Worker): the Supabase URL and anon key it calls `get_public_battle`
 * with, and the site's public origin. The security headers of `_headers`' `/*` rule are baked
 * in too, so the Worker's answers carry the same CSP as every other page.
 */
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const entry = fileURLToPath(new URL('../src/lib/hosting/preview-worker.ts', import.meta.url));

/** The `NEXT_PUBLIC_*` values the worker's code reads (lib/supabase/config.ts, the site URL). */
export const PREVIEW_ENV_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SITE_URL',
] as const;

export interface PreviewWorkerOptions {
  /** The build's environment (its `NEXT_PUBLIC_*` values; unset ones stay unset). */
  env: Readonly<Record<string, string | undefined>>;
  /** The headers every answer carries (`_headers`' `/*` rule). */
  headers: Readonly<Record<string, string>>;
}

/**
 * The paths that invoke the Worker (`assets.run_worker_first` in wrangler.jsonc); every other
 * path is a static asset (no invocation, nothing counted against Workers Free's 100,000
 * requests a day).
 */
export const PREVIEW_ROUTES: readonly string[] = ['/battles/*'];

/** Where the build writes the Worker (`main` in wrangler.jsonc), outside the assets in `out/`. */
export const WORKER_FILE = 'dist/worker.js';

/** wrangler.jsonc's compatibility date (the unit test keeps them equal). */
export const COMPATIBILITY_DATE = '2026-10-01';

/**
 * A wrangler config for a directory laid out like the app (the outage variant of
 * scripts/preview-variant.ts): `main` the Worker, `assets` the static files, the same routing
 * and 404 handling as apps/web/wrangler.jsonc.
 */
export function siteWranglerConfig(opts: { name: string; main: string; assets: string }): object {
  return {
    name: opts.name,
    main: opts.main,
    no_bundle: true,
    find_additional_modules: false,
    compatibility_date: COMPATIBILITY_DATE,
    assets: {
      directory: opts.assets,
      binding: 'ASSETS',
      run_worker_first: [...PREVIEW_ROUTES],
      not_found_handling: '404-page',
      html_handling: 'auto-trailing-slash',
    },
    workers_dev: true,
    preview_urls: false,
  };
}

/** The worker's source (an ES module). */
export async function bundlePreviewWorker(opts: PreviewWorkerOptions): Promise<string> {
  const define: Record<string, string> = {};
  for (const key of PREVIEW_ENV_KEYS) {
    const value = opts.env[key];
    define[`process.env.${key}`] = value === undefined ? 'undefined' : JSON.stringify(value);
  }
  const siteUrl = opts.env['NEXT_PUBLIC_SITE_URL']?.trim().replace(/\/+$/, '') ?? '';
  define['__BR_PREVIEW__'] = JSON.stringify({
    headers: opts.headers,
    siteUrl: siteUrl === '' ? null : new URL(siteUrl).origin,
  });
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    // Readable in a stack trace or `wrangler tail`; it is 13 KiB. Minified (8 KiB) it costs
    // the same CPU (measured: docs/08-free-tier.md §3.3).
    minify: false,
    legalComments: 'none',
    logLevel: 'silent',
    define,
  });
  const js = result.outputFiles[0]?.text;
  if (js === undefined) throw new Error('preview worker: esbuild produced no output');
  // A Worker has no `process`: any reference left would throw on the first request.
  if (/\bprocess\s*\.\s*env\b/.test(js)) {
    throw new Error('preview worker: the bundle still reads process.env (add it to the defines)');
  }
  return js;
}
