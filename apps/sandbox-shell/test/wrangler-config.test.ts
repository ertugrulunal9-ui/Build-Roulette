/**
 * The shell's Worker config (wrangler.jsonc, T-043) against the code it deploys: the Worker
 * file the build writes, the capture path the gate answers, and the rules that keep every
 * other path a static asset.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ASSETS_IGNORE, WORKER_FILE } from '../src/build-shell';
import { CAPTURE_PATH } from '../src/capture-gate';

interface WranglerConfig {
  name?: string;
  main?: string;
  no_bundle?: boolean;
  find_additional_modules?: boolean;
  compatibility_date?: string;
  assets?: {
    directory?: string;
    binding?: string;
    run_worker_first?: string[] | boolean;
    not_found_handling?: string;
    html_handling?: string;
  };
  workers_dev?: boolean;
  preview_urls?: boolean;
  secrets?: { required?: string[] };
  account_id?: string;
}

function readConfig(): WranglerConfig {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  // JSONC (comments, trailing commas), as wrangler reads it.
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config as WranglerConfig;
}

describe('wrangler.jsonc of the shell Worker', () => {
  const config = readConfig();

  it('deploys the Worker the build writes, with the static shell as its assets', () => {
    expect(config.name).toBe('build-roulette-sandbox');
    expect(config.main).toBe(`./dist/${WORKER_FILE}`);
    expect(config.no_bundle).toBe(true);
    // Only the Worker's file is its code (no .html of dist/ attached as modules).
    expect(config.find_additional_modules).toBe(false);
    expect(config.assets?.directory).toBe('./dist');
    expect(config.assets?.binding).toBe('ASSETS');
    // The Worker's file is not uploaded as an asset.
    expect(ASSETS_IGNORE.split('\n')).toContain(`/${WORKER_FILE}`);
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('runs the Worker only for the capture path of the current protocol version', () => {
    expect(config.assets?.run_worker_first).toEqual([CAPTURE_PATH]);
    // An unknown path gets dist/404.html from the assets, without invoking the Worker.
    expect(config.assets?.not_found_handling).toBe('404-page');
  });

  it('is served on workers.dev only (no preview URLs), needs its secret, names no account', () => {
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.secrets?.required).toEqual(['CAPTURE_HMAC_SECRET']);
    expect(config.account_id).toBeUndefined();
  });
});
