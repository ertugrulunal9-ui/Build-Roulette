import { describe, expect, it } from 'vitest';
import {
  CompatUsageError,
  parseCdnBaseUrl,
  parseCompatArgs,
  resultsFileName,
} from '../compat/options';

describe('compat options (T-035)', () => {
  it('runs against our own CDN by default', () => {
    expect(parseCompatArgs([])).toEqual({
      only: null,
      cdn: null,
      keepCache: false,
      cacheDir: null,
      write: true,
      verbose: false,
    });
  });

  it('takes an external CDN from --cdn, --cdn= or COMPAT_CDN (the flag wins)', () => {
    expect(parseCompatArgs(['--cdn', 'https://esm.sh']).cdn).toBe('https://esm.sh');
    expect(parseCompatArgs(['--cdn=https://esm.sh/']).cdn).toBe('https://esm.sh');
    expect(parseCompatArgs([], { COMPAT_CDN: 'https://esm.sh' }).cdn).toBe('https://esm.sh');
    expect(
      parseCompatArgs(['--cdn', 'http://localhost:4400'], { COMPAT_CDN: 'https://esm.sh' }).cdn,
    ).toBe('http://localhost:4400');
    // The CI input's default (empty) and explicit names mean our own CDN.
    expect(parseCompatArgs([], { COMPAT_CDN: '' }).cdn).toBeNull();
    expect(parseCompatArgs(['--cdn', 'own']).cdn).toBeNull();
    expect(parseCompatArgs(['--cdn=pkg-cdn']).cdn).toBeNull();
  });

  it('keeps the other options, and the separator pnpm may pass through', () => {
    expect(
      parseCompatArgs([
        '--',
        '--only',
        'zustand, three',
        '--keep-cache',
        '--cache-dir',
        '/tmp/c',
        '--no-write',
        '--verbose',
      ]),
    ).toEqual({
      only: ['zustand', 'three'],
      cdn: null,
      keepCache: true,
      cacheDir: '/tmp/c',
      write: false,
      verbose: true,
    });
  });

  it('refuses unknown options, missing values and URLs the runtime cannot use', () => {
    expect(() => parseCompatArgs(['--cnd', 'https://esm.sh'])).toThrow(CompatUsageError);
    expect(() => parseCompatArgs(['--cdn'])).toThrow(/needs a value/);
    expect(() => parseCompatArgs(['--cdn', '--verbose'])).toThrow(/needs a value/);
    expect(() => parseCompatArgs(['--only', ','])).toThrow(/at least one/);
    expect(() => parseCdnBaseUrl('esm.sh')).toThrow(/URL such as/);
    expect(() => parseCdnBaseUrl('ftp://esm.sh')).toThrow(/http\(s\)/);
    expect(() => parseCdnBaseUrl('https://esm.sh/?target=es2022')).toThrow(/plain base URL/);
    expect(() => parseCdnBaseUrl('https://u:p@esm.sh')).toThrow(/plain base URL/);
    expect(parseCdnBaseUrl(' https://cdn.example.net/esm/ ')).toBe('https://cdn.example.net/esm');
  });

  it('writes RESULTS.md for our CDN and RESULTS-<host>.md for another', () => {
    expect(resultsFileName(null)).toBe('RESULTS.md');
    expect(resultsFileName('https://esm.sh')).toBe('RESULTS-esm.sh.md');
    expect(resultsFileName('http://localhost:4400')).toBe('RESULTS-localhost_4400.md');
  });
});
