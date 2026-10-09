/**
 * Writes supabase/functions/jobs/core.js (see function-bundle.ts). Part of `pnpm build`;
 * run it after changing anything the `jobs` Edge Function uses, and commit the result.
 *
 *   pnpm --filter @br/capture-worker build:function
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { FUNCTION_BUNDLE, bundleFunction } from './function-bundle';

const text = await bundleFunction();
let before = '';
try {
  before = readFileSync(FUNCTION_BUNDLE, 'utf8');
} catch {
  // first build
}
if (before !== text) writeFileSync(FUNCTION_BUNDLE, text);
const kib = (Buffer.byteLength(text) / 1024).toFixed(1);
console.log(
  `capture-worker: ${relative(process.cwd(), FUNCTION_BUNDLE)} ${kib} KiB${before === text ? ' (unchanged)' : ''}`,
);
