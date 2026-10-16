/**
 * The web app's Worker config (wrangler.jsonc, T-043) against the build: the Worker file the
 * build writes, the paths that invoke it, and the outage variant's config
 * (`siteWranglerConfig`, scripts/preview-variant.ts), which must route like production.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_DATE,
  PREVIEW_ROUTES,
  WORKER_FILE,
  siteWranglerConfig,
} from './preview-worker';

function readConfig(): Record<string, unknown> {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  // JSONC (comments, trailing commas), as wrangler reads it.
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config as Record<string, unknown>;
}

describe('apps/web/wrangler.jsonc', () => {
  const config = readConfig();

  it('deploys the Worker the build writes, with the static export as its assets', () => {
    expect(config['name']).toBe('build-roulette-web');
    expect(config['main']).toBe(`./${WORKER_FILE}`);
    expect(config['no_bundle']).toBe(true);
    expect(config['find_additional_modules']).toBe(false);
    expect(config['compatibility_date']).toBe(COMPATIBILITY_DATE);
    expect(config['assets']).toEqual({
      directory: './out',
      binding: 'ASSETS',
      run_worker_first: ['/battles/*'],
      not_found_handling: '404-page',
      html_handling: 'auto-trailing-slash',
    });
    expect(PREVIEW_ROUTES).toEqual(['/battles/*']);
  });

  it('is served on workers.dev only, and names no account', () => {
    expect(config['workers_dev']).toBe(true);
    expect(config['preview_urls']).toBe(false);
    expect(config['account_id']).toBeUndefined();
  });

  it('the outage variant routes exactly like production', () => {
    const variant = siteWranglerConfig({ name: 'v', main: 'worker.js', assets: 'assets' });
    const omit = (o: object, keys: string[]) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    const own = ['$schema', 'name', 'main', 'assets'];
    expect(omit(variant, own)).toEqual(omit(config, own));
    const assets = (variant as { assets: object }).assets;
    expect({ ...assets, directory: './out' }).toEqual(config['assets']);
  });
});
