/**
 * supabase/functions/jobs/core.js is generated from src/edge (T-034) and committed, so that
 * `supabase functions deploy jobs` needs no build step. This fails when it is stale: run
 * `pnpm --filter @br/capture-worker build:function` and commit the result.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FUNCTION_BUNDLE, bundleFunction } from '../scripts/function-bundle';

describe('the jobs Edge Function bundle', () => {
  it('is up to date with src/edge', async () => {
    const fresh = await bundleFunction();
    const committed = readFileSync(FUNCTION_BUNDLE, 'utf8');
    expect(
      committed === fresh,
      'supabase/functions/jobs/core.js is stale: run `pnpm --filter @br/capture-worker build:function`',
    ).toBe(true);
  }, 30_000);

  it('runs outside Node: no Node built-ins, no Playwright, no sharp, no absolute paths', async () => {
    const text = await bundleFunction();
    expect(text).not.toMatch(/from ['"]node:/);
    expect(text).not.toMatch(/\brequire\(/);
    expect(text).not.toContain('playwright');
    expect(text).not.toContain('sharp');
    expect(text).not.toContain('/home/');
    expect(text).toContain('export {');
    expect(text).toContain('createJobsHandler');
  }, 30_000);
});
