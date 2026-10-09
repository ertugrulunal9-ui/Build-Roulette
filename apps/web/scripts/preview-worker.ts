/**
 * Bundles T-038's link-preview Function (src/lib/hosting/preview-worker.ts) into a Cloudflare
 * Pages advanced-mode worker (`out/_worker.js`), and the `_routes.json` that limits it to
 * `/battles/*`. scripts/pages-config.ts runs it on every build; the CPU measurement and the
 * outage e2e build variants of it (a Supabase that is slow or down).
 *
 * Like Next's bundles, the worker gets the build's `NEXT_PUBLIC_*` values inlined (`process.env`
 * does not exist in a Worker): the Supabase URL and anon key it calls `get_public_battle`
 * with, and the site's public origin. The security headers of `_headers`' `/*` rule are baked
 * in too, so the Function's answers carry the same CSP as every other page.
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

/** Paths that invoke the worker; every other path is a static file (no invocation). */
export const PREVIEW_ROUTES = { version: 1, include: ['/battles/*'], exclude: [] };

/** `out/_routes.json`. */
export function previewRoutesJson(): string {
  return `${JSON.stringify(PREVIEW_ROUTES, null, 2)}\n`;
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
    // Readable in a stack trace or `wrangler pages deployment tail`; it is 13 KiB. Minified
    // (8 KiB) it costs the same CPU (measured: docs/08-free-tier.md §3.3).
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
