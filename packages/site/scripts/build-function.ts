/**
 * Writes supabase/functions/import-url/core.js (see function-bundle.ts). Run it after changing
 * anything the `import-url` Edge Function uses (src/import-url, the copier, the pack), and
 * commit the result:
 *
 *   pnpm --filter @br/site build:function
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
  `site: ${relative(process.cwd(), FUNCTION_BUNDLE)} ${kib} KiB${before === text ? ' (unchanged)' : ''}`,
);
