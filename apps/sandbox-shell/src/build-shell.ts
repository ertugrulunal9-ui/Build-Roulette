/**
 * Builds the shell (Node only): bundles src/shell.ts into one classic script with the
 * allowed app origins baked in, src/capture.ts into the capture page's script, and src/sw.ts
 * into the site worker (`sw.js`) with the sites' response headers baked in. Used by
 * scripts/build.ts and by the dev server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { PROTOCOL_VERSION } from '@br/protocol';
import { CAPTURE_PATH } from './capture-gate';
import { siteHeaders, type ShellHeaderOptions } from './headers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Shell files are served from `/v{PROTOCOL_VERSION}/` (immutable, versioned). */
export const SHELL_BASE_PATH = `/v${PROTOCOL_VERSION}/`;

/** The Worker's file in `dist/` (`main` in wrangler.jsonc), never uploaded as an asset. */
export const WORKER_FILE = 'worker.js';

/**
 * `dist/.assetsignore`: what wrangler leaves out of the uploaded assets (gitignore syntax;
 * `_headers`, `_redirects` and the file itself are left out anyway). The Worker's bundle holds
 * no secret, but it is code, not a page.
 */
export const ASSETS_IGNORE = `/${WORKER_FILE}\n`;

/** `dist/404.html`: the answer to an unknown path (404, with the `/*` security headers). */
export const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Not found</title>
  </head>
  <body>
    Not found
  </body>
</html>
`;

export interface BuiltShell {
  html: string;
  js: string;
  /** `capture.js`, the script of the capture page (the page itself comes from the capture gate). */
  captureJs: string;
  /** `sw.js`, the site worker (docs/09 §9.3). */
  swJs: string;
}

async function bundleEntry(
  entry: string,
  minify: boolean,
  define: Record<string, string>,
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    legalComments: 'none',
    logLevel: 'silent',
    define,
  });
  const js = result.outputFiles[0]?.text;
  if (js === undefined) throw new Error(`shell build produced no output for ${entry}`);
  return js;
}

/**
 * `opts` are the header options of the host (`ShellHeaderOptions`): the app origins go into
 * the shell (postMessage targets) and, with `extraConnectSrc`, into the site worker's
 * `siteHeaders` (the sites' CSP).
 */
export async function buildShell(
  opts: ShellHeaderOptions & { minify?: boolean },
): Promise<BuiltShell> {
  for (const o of opts.appOrigins) {
    if (new URL(o).origin !== o)
      throw new Error(`invalid app origin "${o}" (expected scheme://host[:port])`);
  }
  const minify = opts.minify ?? true;
  const headers = {
    preview: siteHeaders(opts, 'preview'),
    capture: siteHeaders(opts, 'capture'),
  };
  const [js, captureJs, swJs] = await Promise.all([
    bundleEntry('src/shell.ts', minify, { __BR_APP_ORIGINS__: JSON.stringify(opts.appOrigins) }),
    bundleEntry('src/capture.ts', minify, {}),
    bundleEntry('src/sw.ts', minify, {
      __BR_SITE_HEADERS__: JSON.stringify(headers),
      __BR_CAPTURE_PATH__: JSON.stringify(CAPTURE_PATH),
    }),
  ]);
  return { html: readFileSync(path.join(ROOT, 'index.html'), 'utf8'), js, captureJs, swJs };
}

/**
 * Bundles the shell's Worker (`dist/worker.js`, src/worker.ts): the capture gate in front of
 * the static shell, with the capture page's headers baked in. An ES module, deployed as is
 * (`no_bundle` in wrangler.jsonc).
 */
export async function buildWorker(
  captureHeaders: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/worker.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: false,
    legalComments: 'none',
    logLevel: 'silent',
    define: { __BR_CAPTURE_HEADERS__: JSON.stringify(captureHeaders) },
  });
  const js = result.outputFiles[0]?.text;
  if (js === undefined) throw new Error('shell worker build produced no output');
  return js;
}
