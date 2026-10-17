import { expect, test } from '@playwright/test';
import { markupSite } from './fixtures';
import { SHELL_URL, buildFrame, loadSite, openPlayground } from './helpers';

test('e. hello from a wrong origin or a different window is ignored', async ({ page }) => {
  await openPlayground(page);
  const before = await page.evaluate(() => window.__playground.previewStats());
  expect(before.handshakes).toBe(1);

  const rejected = () => page.evaluate(() => window.__playground.previewStats().rejectedMessages);
  let expected = before.rejectedMessages;

  // 1. The page itself posting a hello (wrong source, wrong origin).
  await page.evaluate(() => {
    window.postMessage({ type: 'hello', protocol: 2 }, '*');
  });
  expected += 1;
  await expect.poll(rejected).toBe(expected);

  // 2. Wrong origin, wrong window: a srcdoc frame (app origin) forging a hello.
  await page.evaluate(() => {
    const forged = document.createElement('iframe');
    forged.srcdoc = `<script>parent.postMessage({ type: 'hello', protocol: 2 }, '*');</script>`;
    document.body.append(forged);
  });
  expected += 1;
  await expect.poll(rejected).toBe(expected);

  // 3. Right origin, wrong window: a second copy of the real shell posts a genuine hello
  //    (and keeps retrying, because nobody ever connects it).
  await page.evaluate((shellUrl) => {
    const decoyShell = document.createElement('iframe');
    decoyShell.src = shellUrl;
    decoyShell.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    document.body.append(decoyShell);
  }, SHELL_URL);
  await expect.poll(rejected).toBeGreaterThanOrEqual(expected + 2);

  const after = await page.evaluate(() => window.__playground.previewStats());
  expect(after.handshakes).toBe(1);
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');

  // The real preview still works after the spoof attempts.
  await loadSite(page, markupSite('<h1 data-testid="title">still mine</h1>'));
  await expect(buildFrame(page).getByTestId('title')).toHaveText('still mine');
});

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), ' +
  'display-capture=(), screen-wake-lock=(), idle-detection=(), midi=(), ' +
  'publickey-credentials-get=(), publickey-credentials-create=(), xr-spatial-tracking=()';

function expectSecurityHeaders(h: Record<string, string>): void {
  const csp = h['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toMatch(/frame-ancestors http:\/\/localhost:\d+;/);
  expect(csp).toContain("connect-src 'self' https: wss:");
  expect(csp).toContain("frame-src 'self';");
  expect(csp).toContain("worker-src 'self';");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(h['permissions-policy']).toBe(PERMISSIONS_POLICY);
  expect(h['origin-agent-cluster']).toBe('?1');
  expect(h['cross-origin-resource-policy']).toBe('same-site');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-content-type-options']).toBe('nosniff');
}

test('shell responses carry the CSP / Permissions-Policy headers adapted for local origins', async ({
  request,
}) => {
  for (const url of [SHELL_URL, `${SHELL_URL}shell.js`, `${SHELL_URL}sw.js`]) {
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expectSecurityHeaders(res.headers());
  }
  // The site worker may control the whole origin and is never cached.
  const sw = await request.get(`${SHELL_URL}sw.js`);
  expect(sw.headers()['service-worker-allowed']).toBe('/');
  expect(sw.headers()['cache-control']).toBe('no-store');
  expect(sw.headers()['content-type']).toMatch(/^text\/javascript/);
});

test('every path of the sandbox host carries the security headers, 404s included', async ({
  request,
}) => {
  const origin = new URL(SHELL_URL).origin;
  for (const path of ['/', '/missing', '/v2/missing.js', '/v1/', '/v9/', '/assets/index.js']) {
    const res = await request.get(`${origin}${path}`);
    expect(res.status(), path).toBe(404);
    expectSecurityHeaders(res.headers());
  }
  const reset = await request.get(`${SHELL_URL}reset`);
  expect(reset.status()).toBe(200);
  expect(reset.headers()['clear-site-data']).toBe('"cache", "cookies", "storage"');
  expect(reset.headers()['cache-control']).toBe('no-store');
  expectSecurityHeaders(reset.headers());
});

test('site responses from the site worker carry the site CSP and the security headers', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(
    page,
    markupSite(
      '<pre data-testid="headers"></pre>',
      `const pick = (r) => Object.fromEntries([...r.headers].filter(([k]) => k !== 'date'));
const results = {};
for (const p of ['/', '/assets/app.js', '/nope.js']) {
  const r = await fetch(p);
  results[p] = { status: r.status, ...pick(r) };
}
setTimeout(() => { document.querySelector('[data-testid="headers"]').textContent = JSON.stringify(results); });`,
    ),
  );
  const text = await buildFrame(page).getByTestId('headers').textContent();
  const results = JSON.parse(text ?? '{}') as Record<string, Record<string, string | number>>;
  const appOrigin = new URL(page.url()).origin;
  const siteCsp = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
    "style-src 'self' 'unsafe-inline' blob: https:",
    'img-src * data: blob:',
    'font-src * data:',
    'media-src * data: blob:',
    expect.stringMatching(/^connect-src 'self' https: wss:/),
    "worker-src 'self' blob:",
    `frame-ancestors 'self' ${appOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ];
  for (const [path, h] of Object.entries(results)) {
    expect(String(h['content-security-policy']).split('; '), path).toEqual(siteCsp);
    expect(h['permissions-policy'], path).toBe(PERMISSIONS_POLICY);
    expect(h['origin-agent-cluster'], path).toBe('?1');
    expect(h['referrer-policy'], path).toBe('no-referrer');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['cross-origin-resource-policy'], path).toBe('same-site');
    expect(h['cache-control'], path).toBe('no-store');
  }
  expect(results['/']).toMatchObject({ status: 200, 'content-type': 'text/html; charset=utf-8' });
  expect(results['/assets/app.js']).toMatchObject({
    status: 200,
    'content-type': 'text/javascript; charset=utf-8',
  });
  expect(results['/nope.js']).toMatchObject({ status: 404 });
});

test('Chromium recognises every Permissions-Policy feature (no "Unrecognized feature" warning)', async ({
  page,
}) => {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(m.text()));
  // Top-level load of the shell: the header is parsed for this document, and any warning is
  // logged to this page's console.
  await page.goto(SHELL_URL);
  await expect(page).toHaveTitle('Build Roulette sandbox');
  // The embedded case too: the preview iframe (allow=) and the site's child frame (whose
  // headers come from the site worker).
  await openPlayground(page);
  await page.waitForTimeout(300);
  expect(lines.filter((l) => /unrecognized feature|permissions.policy/i.test(l))).toEqual([]);
});

test('frame-ancestors blocks other origins from embedding the shell', async ({ page }) => {
  // The other test origin (http://localhost:4312) is neither the app nor the sandbox.
  const otherOrigin = `http://localhost:${process.env['OTHER_PORT'] ?? '4312'}`;
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  await page.goto(`${otherOrigin}/health`);
  await page.evaluate((shellUrl) => {
    const f = document.createElement('iframe');
    f.src = shellUrl;
    document.body.append(f);
  }, SHELL_URL);
  await expect
    .poll(() => consoleLines.join('\n'))
    .toMatch(/Refused to frame .*frame-ancestors http:\/\/localhost:\d+/);
  // The shell never ran in that frame.
  const child = page.frames().find((f) => f !== page.mainFrame());
  expect(child?.url()).not.toBe(SHELL_URL);
});

test('sites may use eval and new Function (script-src unsafe-eval)', async ({ page }) => {
  await openPlayground(page);
  // pixi.js v8 and other engines compile shaders/accessors with new Function at runtime.
  await loadSite(
    page,
    markupSite(
      '<p data-testid="evaluated"></p>',
      `const fromFunction = new Function('return 1')();
const fromEval = (0, eval)('2');
setTimeout(() => { document.querySelector('[data-testid="evaluated"]').textContent = String(fromFunction + fromEval); });`,
    ),
  );
  await expect(buildFrame(page).getByTestId('evaluated')).toHaveText('3');
  const errors = await page.evaluate(() =>
    window.__playground.events.filter((e) => e.type === 'error').map((e) => e.data),
  );
  expect(errors).toEqual([]);
});

test('preview frames allow fullscreen through allow= only (no allowfullscreen warning)', async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  await openPlayground(page);
  await loadSite(
    page,
    markupSite(
      '<p data-testid="fs"></p>',
      `setTimeout(() => { document.querySelector('[data-testid="fs"]').textContent = String(document.fullscreenEnabled); });`,
    ),
  );

  const preview = page.locator('#preview');
  expect(await preview.getAttribute('allow')).toContain('fullscreen');
  expect(await preview.getAttribute('allowfullscreen')).toBeNull();
  // The shell's per-load child frame (the site's document).
  const child = page.frameLocator('#preview').locator('iframe');
  expect(await child.getAttribute('allow')).toContain('fullscreen');
  expect(await child.getAttribute('allowfullscreen')).toBeNull();
  // Fullscreen is still delegated all the way down to the site.
  await expect(buildFrame(page).getByTestId('fs')).toHaveText('true');
  // Chromium: "Allow attribute will take precedence over 'allowfullscreen'."
  expect(consoleLines.filter((l) => /allowfullscreen/i.test(l))).toEqual([]);
});
