import { describe, expect, it } from 'vitest';
import {
  CAPTURE_SANDBOX_FLAGS,
  FORM_ACTION,
  captureCsp,
  captureHeaders,
  PERMISSIONS_POLICY,
  PUBLIC_ESM_SH_URL,
  RESET_HEADERS,
  cdnOriginOf,
  renderHeadersFile,
  securityHeaders,
  shellCsp,
  shellHeaders,
  staticHeaderRules,
} from '../src/headers';

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
        "connect-src 'self' https: wss:",
        'worker-src blob:',
        'frame-ancestors https://buildroulette.app',
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    expect(FORM_ACTION).toBe("'none'");
    const h = shellHeaders(PROD);
    expect(h['Permissions-Policy']).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), ' +
        'display-capture=(), screen-wake-lock=(), idle-detection=(), midi=(), ' +
        'publickey-credentials-get=(), publickey-credentials-create=(), xr-spatial-tracking=()',
    );
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-site');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Origin-Agent-Cluster']).toBe('?1');
    expect(h['Cache-Control']).toContain('immutable');
  });

  it('keeps worker-src blob-only (no service worker scripts from the origin)', () => {
    expect(shellCsp(PROD)).toContain('; worker-src blob:;');
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
    expect(local).toContain("connect-src 'self' https: wss: http://localhost:4312");
    expect(local).toContain('frame-ancestors http://localhost:4310');
  });

  it('securityHeaders has no caching header (it applies to every path)', () => {
    const s = securityHeaders(PROD);
    expect(s['Cache-Control']).toBeUndefined();
    expect(Object.keys(s).sort()).toEqual([
      'Content-Security-Policy',
      'Cross-Origin-Resource-Policy',
      'Origin-Agent-Cluster',
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
    ]);
  });

  it('the reset endpoint clears cache, cookies and storage and is never cached', () => {
    expect(RESET_HEADERS).toEqual({
      'Clear-Site-Data': '"cache", "cookies", "storage"',
      'Cache-Control': 'no-store',
    });
  });

  it('static rules: security headers on /*, Cache-Control only on non-overlapping rules', () => {
    const rules = staticHeaderRules(PROD, '/v1/');
    expect(rules.map((r) => r.pattern)).toEqual([
      '/*',
      '/v1/',
      '/v1/index.html',
      '/v1/shell.js',
      '/v1/capture.js',
      '/v1/reset',
    ]);
    expect(rules[0]?.headers).toEqual(securityHeaders(PROD));
    // Pages joins repeated header names from overlapping rules: /* must not set Cache-Control.
    const withCache = rules.filter((r) => 'Cache-Control' in r.headers).map((r) => r.pattern);
    expect(withCache).not.toContain('/*');
    expect(rules.find((r) => r.pattern === '/v1/reset')?.headers).toEqual(RESET_HEADERS);
    expect(rules.find((r) => r.pattern === '/v1/shell.js')?.headers['Cache-Control']).toContain(
      'immutable',
    );
  });

  it('capture page: shell CSP family, top-level only, sandboxed, never cached', () => {
    const csp = captureCsp(PROD);
    // Same sources as the preview shell, so a build behaves the same in a capture.
    expect(csp).toContain(
      shellCsp(PROD).replace('frame-ancestors https://buildroulette.app', "frame-ancestors 'none'"),
    );
    expect(csp).not.toContain('https://buildroulette.app');
    expect(
      csp.endsWith('; sandbox allow-scripts allow-same-origin allow-forms allow-pointer-lock'),
    ).toBe(true);
    expect(CAPTURE_SANDBOX_FLAGS).not.toContain('allow-popups');
    expect(CAPTURE_SANDBOX_FLAGS).not.toContain('allow-modals');
    expect(CAPTURE_SANDBOX_FLAGS).not.toContain('allow-top-navigation');
    const h = captureHeaders(PROD);
    expect(h['Content-Security-Policy']).toBe(csp);
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(h['Permissions-Policy']).toBe(PERMISSIONS_POLICY);
    expect(h['Origin-Agent-Cluster']).toBe('?1');
  });

  it('renders a _headers file', () => {
    const file = renderHeadersFile([
      { pattern: '/*', headers: { A: '1', B: 'two' } },
      { pattern: '/v1/reset', headers: { C: '3' } },
    ]);
    expect(file).toBe('/*\n  A: 1\n  B: two\n\n/v1/reset\n  C: 3\n');
  });
});

describe('the package CDN setting (T-035)', () => {
  it('turns a base URL into the origin the CSP allows', () => {
    expect(PUBLIC_ESM_SH_URL).toBe('https://esm.sh');
    expect(cdnOriginOf('https://esm.sh')).toBe('https://esm.sh');
    expect(cdnOriginOf(' https://esm.sh/ ')).toBe('https://esm.sh');
    expect(cdnOriginOf('https://pkg.example.net/esm/')).toBe('https://pkg.example.net');
    expect(cdnOriginOf('http://localhost:4322')).toBe('http://localhost:4322');
    expect(() => cdnOriginOf('esm.sh')).toThrow(/not a URL/);
    expect(() => cdnOriginOf('ftp://esm.sh')).toThrow(/http\(s\)/);
    expect(() => cdnOriginOf('https://u:p@esm.sh')).toThrow(/credentials/);
  });

  it('with esm.sh, every module it serves (entry URLs and /x@v/es2022/… paths) is allowed', () => {
    const esm = { appOrigins: ['https://build-roulette-web.pages.dev'], cdnOrigin: 'https://esm.sh' };
    for (const csp of [shellCsp(esm), captureCsp(esm)]) {
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://esm.sh;");
      // Package CSS is inlined by the bundler; its url()s and fonts load from the CDN.
      expect(csp).toContain("style-src 'self' 'unsafe-inline' blob: https:;");
      expect(csp).toContain('img-src * data: blob:');
      expect(csp).toContain('font-src * data:');
      // WebAssembly and data files that packages fetch from the CDN.
      expect(csp).toContain("connect-src 'self' https: wss:;");
    }
    expect(shellCsp(esm)).toContain('frame-ancestors https://build-roulette-web.pages.dev');
  });
});
