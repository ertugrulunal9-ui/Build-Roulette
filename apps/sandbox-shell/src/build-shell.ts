/**
 * Builds the shell (Node only): bundles src/shell.ts into one classic script with the
 * allowed app origins baked in. Used by scripts/build.ts and by the dev server.
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
}

export async function buildShell(opts: {
  appOrigins: readonly string[];
  minify?: boolean;
}): Promise<BuiltShell> {
  for (const o of opts.appOrigins) {
    if (new URL(o).origin !== o)
      throw new Error(`invalid app origin "${o}" (expected scheme://host[:port])`);
  }
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/shell.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: opts.minify ?? true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { __BR_APP_ORIGINS__: JSON.stringify(opts.appOrigins) },
  });
  const js = result.outputFiles[0]?.text;
  if (js === undefined) throw new Error('shell build produced no output');
  return { html: readFileSync(path.join(ROOT, 'index.html'), 'utf8'), js };
}
