import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS_POLICY, SITE_WORKER_HEADERS } from '../src/headers';
import { CAPTURE_HTML } from '../src/capture-gate';
import { signCaptureUrl } from '../src/capture-sig';
import { startShellServer, type ShellServer } from '../src/server';

let shell: ShellServer;

beforeAll(async () => {
  shell = await startShellServer({ appOrigins: ['http://localhost:4310'] });
});
afterAll(async () => {
  await shell.close();
});

function expectSecurityHeaders(res: Response, what: string): void {
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp, what).toContain("default-src 'none'");
  expect(csp, what).toContain('frame-ancestors http://localhost:4310');
  expect(csp, what).toContain("base-uri 'none'");
  expect(csp, what).toContain("form-action 'none'");
  expect(res.headers.get('permissions-policy'), what).toBe(PERMISSIONS_POLICY);
  expect(res.headers.get('origin-agent-cluster'), what).toBe('?1');
  expect(res.headers.get('x-content-type-options'), what).toBe('nosniff');
  expect(res.headers.get('referrer-policy'), what).toBe('no-referrer');
  expect(res.headers.get('cross-origin-resource-policy'), what).toBe('same-site');
}

describe('local shell server', () => {
  it('sends the security headers on the shell files', async () => {
    for (const p of ['', 'index.html', 'shell.js']) {
      const res = await fetch(`${shell.shellUrl}${p}`);
      expect(res.status, p).toBe(200);
      expectSecurityHeaders(res, p);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('serves the site worker with Service-Worker-Allowed: / and no-store, and counts requests', async () => {
    const before = shell.workerScriptRequests();
    const res = await fetch(`${shell.shellUrl}sw.js`);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res, 'sw.js');
    expect(res.headers.get('service-worker-allowed')).toBe(
      SITE_WORKER_HEADERS['Service-Worker-Allowed'],
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const js = await res.text();
    expect(js.length).toBe(shell.swJsBytes);
    // The sites' headers are baked in, with this server's app origin in frame-ancestors.
    expect(js).toContain("frame-ancestors 'self' http://localhost:4310");
    expect(shell.workerScriptRequests()).toBe(before + 1);
  });

  it('sends the security headers on 404s and unknown paths too', async () => {
    for (const p of ['/', '/nope', '/v2/nope.html', '/v1/', '/v3/', '/assets/index.js']) {
      const res = await fetch(`${shell.origin}${p}`);
      expect(res.status, p).toBe(404);
      expectSecurityHeaders(res, p);
    }
  });

  it('serves /v2/reset with Clear-Site-Data and no-store, and counts requests', async () => {
    const before = shell.resetRequests();
    const res = await fetch(`${shell.shellUrl}reset`);
    expect(res.status).toBe(200);
    expect(res.headers.get('clear-site-data')).toBe('"cache", "cookies", "storage"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectSecurityHeaders(res, 'reset');
    expect(shell.resetRequests()).toBe(before + 1);
  });
});

describe('local shell server: capture gate', () => {
  const SECRET = 'server-secret-0123456789abcdef0123456789abcdef';
  let capture: ShellServer;
  beforeAll(async () => {
    capture = await startShellServer({
      appOrigins: ['http://localhost:4310'],
      extraConnectSrc: ['http://127.0.0.1:54321'],
      captureSecret: SECRET,
    });
  });
  afterAll(async () => {
    await capture.close();
  });

  it('answers 503 on /v2/capture without a configured secret', async () => {
    const res = await fetch(`${shell.shellUrl}capture`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
  });

  it('serves the capture page only for a valid signature', async () => {
    const url = await signCaptureUrl({
      captureUrl: capture.captureUrl,
      src: 'http://127.0.0.1:54321/storage/v1/object/sign/x/site.bin?token=t',
      exp: Math.floor(Date.now() / 1000) + 60,
      secret: SECRET,
    });
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(CAPTURE_HTML);
    const csp = ok.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https: wss: http://127.0.0.1:54321;");
    expect(csp).toContain('sandbox allow-scripts allow-same-origin');
    expect(ok.headers.get('cache-control')).toBe('no-store');

    const bad = await fetch(url.replace(/sig=[^&]+/, `sig=${'A'.repeat(43)}`));
    expect(bad.status).toBe(403);
    expect(await bad.text()).toBe('');
    expect(capture.captureRequests()).toEqual({ served: 1, refused: 1 });
  });

  it('serves capture.js with the security headers', async () => {
    const res = await fetch(`${capture.shellUrl}capture.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toContain('[br-capture]');
  });
});
