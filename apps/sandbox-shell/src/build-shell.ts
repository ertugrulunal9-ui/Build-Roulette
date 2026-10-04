/**
 * Builds the shell (Node only): bundles src/shell.ts into one classic script with the
 * allowed app origins baked in, and src/capture.ts into the capture page's script. Used by
 * scripts/build.ts and by the dev server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { PROTOCOL_VERSION } from '@br/protocol';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Shell files are served from `/v{PROTOCOL_VERSION}/` (immutable, versioned). */
export const SHELL_BASE_PATH = `/v${PROTOCOL_VERSION}/`;

export interface BuiltShell {
  html: string;
  js: string;
  /** `capture.js`, the script of the capture page (the page itself comes from the capture gate). */
  captureJs: string;
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

export async function buildShell(opts: {
  appOrigins: readonly string[];
  minify?: boolean;
}): Promise<BuiltShell> {
  for (const o of opts.appOrigins) {
    if (new URL(o).origin !== o)
      throw new Error(`invalid app origin "${o}" (expected scheme://host[:port])`);
  }
  const minify = opts.minify ?? true;
  const [js, captureJs] = await Promise.all([
    bundleEntry('src/shell.ts', minify, { __BR_APP_ORIGINS__: JSON.stringify(opts.appOrigins) }),
    bundleEntry('src/capture.ts', minify, {}),
  ]);
  return { html: readFileSync(path.join(ROOT, 'index.html'), 'utf8'), js, captureJs };
}

/**
 * Bundles the Cloudflare Pages advanced-mode worker (`dist/_worker.js`): the capture gate in
 * front of the static shell, with the capture page's headers baked in.
 */
export async function buildPagesWorker(
  captureHeaders: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/pages-worker.ts')],
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
  if (js === undefined) throw new Error('pages worker build produced no output');
  return js;
}
