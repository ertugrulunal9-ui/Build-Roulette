import { expect, test } from '@playwright/test';
import { watchCsp } from './csp';
import { buildFrame, openPlayground } from './helpers';

/**
 * The static site as Cloudflare Pages serves it (T-037), through `wrangler pages dev out/`
 * (playwright.config.ts): the shells behind `_redirects` rewrites (and `/battles/{id}` behind
 * T-038's link-preview Function), the 404 page, the headers of `_headers`, and no CSP
 * violation on any page. Needs no Supabase stack: every page is checked in a state it
 * reaches without data (a malformed id, no session). The Function's other cases need the
 * stack: link-preview.spec.ts.
 */

const MALFORMED = 'not-a-uuid';

test('every page is a file: the shells keep their URL, unknown paths get the 404 page', async ({
  page,
  request,
}) => {
  for (const path of [
    '/',
    '/play',
    '/playground',
    '/r',
    '/battles',
    '/u',
    '/admin',
    '/admin/sign-in',
  ]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toMatch(/^text\/html/);
  }
  // The rewrites (`/u/:id /u 200` …): one path segment, the URL stays.
  for (const path of ['/u/x', '/r/K7QXM']) {
    expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
  }
  // `/battles/{id}` is answered by the link-preview Function (T-038), with the same shell: a
  // malformed id is a 404 (the shell's HTML, so the page still shows its not-found view).
  const malformed = await request.get('/battles/x', { maxRedirects: 0 });
  expect(malformed.status()).toBe(404);
  expect(malformed.headers()['x-br-preview']).toBe('malformed');
  expect(await malformed.text()).toContain('<title>Battle not found · Build Roulette</title>');
  for (const path of ['/nope', '/battles/x/y', '/r/K7QXM/extra', '/admin/nope']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).toContain('This page could not be found.');
  }

  const battleRes = await page.goto(`/battles/${MALFORMED}`);
  expect(battleRes?.status()).toBe(404);
  await expect(page.getByTestId('battle-not-found')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/battles/${MALFORMED}$`));
  await expect(page).toHaveTitle('Battle not found · Build Roulette');
  await page.goto(`/u/${MALFORMED}?before=x`);
  await expect(page.getByTestId('player-not-found')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/u/${MALFORMED}\\?before=x$`));
  await page.goto('/r');
  await expect(page.getByText('This link has no room code.')).toBeVisible();
});

test('the headers of _headers: CSP without inline scripts, no framing, long cache for hashed assets', async ({
  request,
}) => {
  for (const path of ['/', `/battles/${MALFORMED}`, '/admin', '/nope']) {
    const h = (await request.get(path)).headers();
    const csp = h['content-security-policy'] ?? '';
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("object-src 'none'");
    expect(csp, path).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
    expect(csp, path).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy'], path).toContain('camera=()');
  }
  expect((await request.get('/admin')).headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect((await request.get('/')).headers()['x-robots-tag']).toBeUndefined();

  const html = await (await request.get('/')).text();
  const chunk = /<script src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(html)?.[1];
  expect(chunk).toBeTruthy();
  const asset = await request.get(chunk ?? '');
  expect(asset.status()).toBe(200);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('/admin without a session: the not-found screen, and no request leaves the page', async ({
  page,
}) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:')) outside.push(r.url());
  });
  await page.goto('/admin');
  await expect(page.getByTestId('admin-not-found')).toBeVisible();
  await expect(page.getByText('This page could not be found.')).toBeVisible();
  await expect(page.getByText('Moderation')).toHaveCount(0);
  await expect(page).toHaveTitle('Build Roulette');
  expect(outside).toEqual([]);
  // The sign-in page renders its form; its button waits for the page's script.
  await page.goto('/admin/sign-in');
  await expect(page.getByTestId('admin-sign-in-submit')).toBeEnabled();
});

test('the CSP is enforced: an injected inline script does not run (and is reported)', async ({
  page,
}) => {
  const violations = watchCsp(page);
  await page.goto('/');
  const ran = await page.evaluate(() => {
    const w = window as Window & { injected?: boolean };
    const s = document.createElement('script');
    s.textContent = 'window.injected = true';
    document.head.append(s);
    return w.injected === true;
  });
  expect(ran).toBe(false);
  await expect.poll(() => violations.length).toBe(1);
  expect(violations[0]).toContain("script-src 'self'");
});

test('no Content-Security-Policy violation on any page (the playground runs a build)', async ({
  page,
}) => {
  const violations = watchCsp(page);
  for (const path of [
    '/',
    '/play',
    `/battles/${MALFORMED}`,
    `/u/${MALFORMED}`,
    '/admin',
    '/admin/sign-in',
    '/nope',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  // The playground: the bundler worker (esbuild.wasm), the cross-site preview iframe.
  await openPlayground(page);
  await expect(buildFrame(page).locator('h1')).toHaveText('Hello, Build Roulette!');
  expect(violations).toEqual([]);
});
