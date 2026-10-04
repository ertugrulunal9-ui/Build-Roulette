import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS_POLICY } from '../src/headers';
import { startShellServer, type ShellServer } from '../src/server';

let shell: ShellServer;

beforeAll(async () => {
  shell = await startShellServer({
    appOrigins: ['http://localhost:4310'],
    cdnOrigin: 'http://localhost:4312',
  });
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

  it('sends the security headers on 404s and unknown paths too', async () => {
    for (const p of ['/', '/nope', '/v1/nope.html', '/v2/']) {
      const res = await fetch(`${shell.origin}${p}`);
      expect(res.status, p).toBe(404);
      expectSecurityHeaders(res, p);
    }
  });

  it('serves /v1/reset with Clear-Site-Data and no-store, and counts requests', async () => {
    const before = shell.resetRequests();
    const res = await fetch(`${shell.shellUrl}reset`);
    expect(res.status).toBe(200);
    expect(res.headers.get('clear-site-data')).toBe('"cache", "cookies", "storage"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectSecurityHeaders(res, 'reset');
    expect(shell.resetRequests()).toBe(before + 1);
  });
});
