import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildShell, SHELL_BASE_PATH } from '../src/build-shell';
import { PERMISSIONS_POLICY, renderHeadersFile, shellCsp, shellHeaders } from '../src/headers';

const PROD = { appOrigins: ['https://buildroulette.app'], cdnOrigin: 'https://pkg.example.net' };

describe('shell headers', () => {
  it('matches the docs/03 §3.5 policy (plus the documented inline/eval exceptions)', () => {
    expect(shellCsp(PROD)).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://pkg.example.net",
        "style-src 'self' 'unsafe-inline' blob: https:",
        'img-src * data: blob:',
        'font-src * data:',
        'media-src * data: blob:',
        'connect-src https: wss:',
        'worker-src blob:',
        'frame-ancestors https://buildroulette.app',
      ].join('; '),
    );
    const h = shellHeaders(PROD);
    expect(h['Permissions-Policy']).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()',
    );
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-site');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Cache-Control']).toContain('immutable');
  });

  it('adds the http CDN origin to style-src and connect-src only when asked (local dev)', () => {
    const local = shellCsp({
      appOrigins: ['http://localhost:4310'],
      cdnOrigin: 'http://localhost:4312',
      extraConnectSrc: ['http://localhost:4312'],
    });
    expect(local).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http://localhost:4312",
    );
    expect(local).toContain("style-src 'self' 'unsafe-inline' blob: https: http://localhost:4312");
    expect(local).toContain('connect-src https: wss: http://localhost:4312');
    expect(local).toContain('frame-ancestors http://localhost:4310');
  });

  it('renders a _headers file', () => {
    const file = renderHeadersFile('/v1/*', { A: '1', B: 'two' });
    expect(file).toBe('/v1/*\n  A: 1\n  B: two\n');
  });
});

describe('buildShell', () => {
  it('bakes the app origins in and stays small', async () => {
    const built = await buildShell({
      appOrigins: ['https://buildroulette.app', 'http://localhost:3000'],
    });
    expect(built.js).toContain('https://buildroulette.app');
    expect(built.js).toContain('http://localhost:3000');
    expect(built.js).not.toContain('__BR_APP_ORIGINS__');
    expect(built.html).toContain('<script src="./shell.js"></script>');
    expect(SHELL_BASE_PATH).toBe('/v1/');
    // Budget guard: ~36 KB raw / ~12 KB gzip today, most of it zod (see README).
    expect(gzipSync(built.js).byteLength).toBeLessThan(16 * 1024);
  });

  it('rejects malformed origins', async () => {
    await expect(buildShell({ appOrigins: ['https://buildroulette.app/path'] })).rejects.toThrow(
      'invalid app origin',
    );
  });
});
