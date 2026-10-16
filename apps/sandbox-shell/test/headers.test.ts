import { describe, expect, it } from 'vitest';
import {
  CAPTURE_SANDBOX_FLAGS,
  FORM_ACTION,
  PERMISSIONS_POLICY,
  RESET_HEADERS,
  SITE_WORKER_HEADERS,
  captureCsp,
  captureHeaders,
  renderHeadersFile,
  securityHeaders,
  shellCsp,
  shellHeaders,
  siteCsp,
  siteHeaders,
  staticHeaderRules,
} from '../src/headers';

const PROD = { appOrigins: ['https://buildroulette.app'] };

describe('shell headers', () => {
  it('the shell document runs its own script only, registers the site worker and frames the site', () => {
    expect(shellCsp(PROD)).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        'img-src data: blob:',
        "connect-src 'self' https: wss:",
        "frame-src 'self'",
        "worker-src 'self'",
        'frame-ancestors https://buildroulette.app',
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    // No package CDN any more (protocol v2), and no inline or eval code in the shell.
    expect(shellCsp(PROD)).not.toContain('unsafe-eval');
    expect(shellCsp(PROD)).not.toContain('esm.sh');
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

  it('adds extra connect-src origins only when asked (local dev)', () => {
    const local = shellCsp({
      appOrigins: ['http://localhost:4310'],
      extraConnectSrc: ['http://127.0.0.1:54321'],
    });
    expect(local).toContain("connect-src 'self' https: wss: http://127.0.0.1:54321;");
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

  it('the site worker script may control the whole origin and is never cached', () => {
    expect(SITE_WORKER_HEADERS).toEqual({
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store',
    });
  });

  it('static rules: security headers on /*, Cache-Control only on non-overlapping rules', () => {
    const rules = staticHeaderRules(PROD, '/v2/');
    expect(rules.map((r) => r.pattern)).toEqual([
      '/*',
      '/v2/',
      '/v2/index.html',
      '/v2/shell.js',
      '/v2/capture.js',
      '/v2/sw.js',
      '/v2/reset',
    ]);
    expect(rules[0]?.headers).toEqual(securityHeaders(PROD));
    // Cloudflare joins repeated header names from overlapping rules: /* must not set Cache-Control.
    const withCache = rules.filter((r) => 'Cache-Control' in r.headers).map((r) => r.pattern);
    expect(withCache).not.toContain('/*');
    expect(rules.find((r) => r.pattern === '/v2/reset')?.headers).toEqual(RESET_HEADERS);
    expect(rules.find((r) => r.pattern === '/v2/sw.js')?.headers).toEqual(SITE_WORKER_HEADERS);
    expect(rules.find((r) => r.pattern === '/v2/shell.js')?.headers['Cache-Control']).toContain(
      'immutable',
    );
  });

  it('capture page: shell CSP family, top-level only, sandboxed, never cached', () => {
    const csp = captureCsp(PROD);
    expect(csp).toContain(
      shellCsp(PROD).replace('frame-ancestors https://buildroulette.app', "frame-ancestors 'none'"),
    );
    expect(csp).not.toContain('https://buildroulette.app');
    expect(
      csp.endsWith('; sandbox allow-scripts allow-same-origin allow-forms allow-pointer-lock'),
    ).toBe(true);
    // The site worker needs a real origin: allow-same-origin stays.
    expect(CAPTURE_SANDBOX_FLAGS).toContain('allow-same-origin');
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
      { pattern: '/v2/reset', headers: { C: '3' } },
    ]);
    expect(file).toBe('/*\n  A: 1\n  B: two\n\n/v2/reset\n  C: 3\n');
  });
});

describe('site headers (docs/09 §9.3)', () => {
  const APPS = { appOrigins: ['https://buildroulette.app', 'https://br.pages.dev'] };

  it('preview: scripts from the site and any https host, framed by the shell and the app', () => {
    expect(siteCsp(APPS, 'preview')).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
        "style-src 'self' 'unsafe-inline' blob: https:",
        'img-src * data: blob:',
        'font-src * data:',
        'media-src * data: blob:',
        "connect-src 'self' https: wss:",
        "worker-src 'self' blob:",
        "frame-ancestors 'self' https://buildroulette.app https://br.pages.dev",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
  });

  it('capture: framed by the capture page only, with its sandbox flags', () => {
    const csp = siteCsp(APPS, 'capture');
    expect(csp).toContain("; frame-ancestors 'self'; ");
    expect(csp).not.toContain('https://buildroulette.app');
    expect(csp.endsWith(`; sandbox ${CAPTURE_SANDBOX_FLAGS.join(' ')}`)).toBe(true);
    // Otherwise the same policy as the preview.
    expect(csp.split('; ').slice(0, 8)).toEqual(siteCsp(APPS, 'preview').split('; ').slice(0, 8));
  });

  it('local dev: extra connect-src origins reach the sites too', () => {
    expect(siteCsp({ ...APPS, extraConnectSrc: ['http://localhost:4312'] }, 'preview')).toContain(
      "connect-src 'self' https: wss: http://localhost:4312;",
    );
  });

  it("every site response: the site CSP, the host's other security headers, never cached", () => {
    for (const context of ['preview', 'capture'] as const) {
      const h = siteHeaders(APPS, context);
      const { 'Content-Security-Policy': csp, 'Cache-Control': cache, ...rest } = h;
      expect(csp).toBe(siteCsp(APPS, context));
      expect(cache).toBe('no-store');
      const { 'Content-Security-Policy': _shellCsp, ...hostRest } = securityHeaders(APPS);
      expect(_shellCsp).not.toBe(csp);
      expect(rest).toEqual(hostRest);
    }
  });
});
