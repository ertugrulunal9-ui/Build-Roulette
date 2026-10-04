import { expect, test } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, openPlayground } from './helpers';

const SHELL_URL = `http://127.0.0.1:${process.env['SHELL_PORT'] ?? '4311'}/v1/`;

test('e. hello from a wrong origin or a different window is ignored', async ({ page }) => {
  await openPlayground(page);
  const before = await page.evaluate(() => window.__playground.previewStats());
  expect(before.handshakes).toBe(1);

  const rejected = () => page.evaluate(() => window.__playground.previewStats().rejectedMessages);
  let expected = before.rejectedMessages;

  // 1. The page itself posting a hello (wrong source, wrong origin).
  await page.evaluate(() => {
    window.postMessage({ type: 'hello', protocol: 1 }, '*');
  });
  expected += 1;
  await expect.poll(rejected).toBe(expected);

  // 2. Wrong origin, wrong window: a srcdoc frame (app origin) forging a hello.
  await page.evaluate(() => {
    const forged = document.createElement('iframe');
    forged.srcdoc = `<script>parent.postMessage({ type: 'hello', protocol: 1 }, '*');</script>`;
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
  const r = await page.evaluate(async () => {
    window.__playground.writeFile(
      'src/App.tsx',
      `export function App() { return <h1 data-testid="title">still mine</h1>; }`,
    );
    return window.__playground.buildAndLoad();
  });
  expect(r.ok).toBe(true);
  await expect(buildFrame(page).getByTestId('title')).toHaveText('still mine');
});

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), ' +
  'display-capture=(), screen-wake-lock=(), idle-detection=(), midi=(), ' +
  'publickey-credentials-get=(), publickey-credentials-create=(), xr-spatial-tracking=()';

function expectSecurityHeaders(h: Record<string, string>): void {
  const csp = h['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(
    /script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http:\/\/localhost:\d+/,
  );
  expect(csp).toMatch(/frame-ancestors http:\/\/localhost:\d+/);
  expect(csp).toContain("connect-src 'self' https: wss:");
  expect(csp).toContain('worker-src blob:;');
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
  for (const url of [SHELL_URL, `${SHELL_URL}shell.js`]) {
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expectSecurityHeaders(res.headers());
  }
});

test('every path of the sandbox host carries the security headers, 404s included', async ({
  request,
}) => {
  const origin = new URL(SHELL_URL).origin;
  for (const path of ['/', '/missing', '/v1/missing.js', '/v9/']) {
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

test('Chromium recognises every Permissions-Policy feature (no "Unrecognized feature" warning)', async ({
  page,
}) => {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(m.text()));
  // Top-level load of the shell: the header is parsed for this document, and any warning is
  // logged to this page's console.
  await page.goto(SHELL_URL);
  await expect(page).toHaveTitle('Build Roulette sandbox');
  // The embedded case too: the preview iframe (allow=) and the shell's child frame.
  await openPlayground(page);
  await page.waitForTimeout(300);
  expect(lines.filter((l) => /unrecognized feature|permissions.policy/i.test(l))).toEqual([]);
});

test('frame-ancestors blocks other origins from embedding the shell', async ({ page }) => {
  // The mock CDN origin (http://localhost:4312) is a different origin from the app.
  const cdnOrigin = `http://localhost:${process.env['CDN_PORT'] ?? '4312'}`;
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  await page.goto(`${cdnOrigin}/health`);
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

test('builds may use eval and new Function (script-src unsafe-eval)', async ({ page }) => {
  await openPlayground(page);
  // pixi.js v8 and other engines compile shaders/accessors with new Function at runtime.
  const files = reactApp(
    `<p data-testid="evaluated">{String(fromFunction + fromEval)}</p>`,
    `const fromFunction = new Function('return 1')() as number;
const fromEval = (0, eval)('2') as number;`,
  );
  const r = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      return window.__playground.buildAndLoad();
    },
    { files, manifest: REACT_MANIFEST },
  );
  expect(r.ok).toBe(true);
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
  const r = await page.evaluate(async () => {
    window.__playground.writeFile(
      'src/App.tsx',
      `export function App() { return <p data-testid="fs">{String(document.fullscreenEnabled)}</p>; }`,
    );
    return window.__playground.buildAndLoad();
  });
  expect(r.ok).toBe(true);

  const preview = page.locator('#preview');
  expect(await preview.getAttribute('allow')).toContain('fullscreen');
  expect(await preview.getAttribute('allowfullscreen')).toBeNull();
  // The shell's per-load child frame (the build's document).
  const child = page.frameLocator('#preview').locator('iframe');
  expect(await child.getAttribute('allow')).toContain('fullscreen');
  expect(await child.getAttribute('allowfullscreen')).toBeNull();
  // Fullscreen is still delegated all the way down to the build.
  await expect(buildFrame(page).getByTestId('fs')).toHaveText('true');
  // Chromium: "Allow attribute will take precedence over 'allowfullscreen'."
  expect(consoleLines.filter((l) => /allowfullscreen/i.test(l))).toEqual([]);
});
