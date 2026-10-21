/**
 * supabase/functions/import-url/core.js is generated from src/import-url (T-051) and committed,
 * so that `supabase functions deploy import-url` needs no build step. This fails when it is
 * stale: run `pnpm --filter @br/site build:function` and commit the result.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FUNCTION_BUNDLE, bundleFunction } from './function-bundle';

describe('the import-url Edge Function bundle', () => {
  it('is up to date with src/import-url', async () => {
    const fresh = await bundleFunction();
    const committed = readFileSync(FUNCTION_BUNDLE, 'utf8');
    expect(
      committed === fresh,
      'supabase/functions/import-url/core.js is stale: run `pnpm --filter @br/site build:function`',
    ).toBe(true);
  }, 30_000);

  it('runs outside Node: no Node built-ins, no fflate, no absolute paths', async () => {
    const text = await bundleFunction();
    expect(text).not.toMatch(/from ['"]node:/);
    expect(text).not.toMatch(/\brequire\(/);
    expect(text).not.toContain('fflate');
    expect(text).not.toContain('/home/');
    expect(text).toContain('export {');
    expect(text).toContain('createImportUrlHandler');
    expect(text).toContain('lovable.app');
  }, 30_000);
});
