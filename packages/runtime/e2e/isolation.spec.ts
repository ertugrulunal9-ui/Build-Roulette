import { expect, test } from '@playwright/test';
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

test('shell responses carry the CSP / Permissions-Policy headers adapted for local origins', async ({
  request,
}) => {
  const res = await request.get(SHELL_URL);
  expect(res.status()).toBe(200);
  const h = res.headers();
  const csp = h['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(/script-src 'self' 'unsafe-inline' blob: http:\/\/localhost:\d+/);
  expect(csp).toMatch(/frame-ancestors http:\/\/localhost:\d+/);
  expect(csp).toContain('connect-src https: wss:');
  expect(h['permissions-policy']).toBe(
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()',
  );
  expect(h['cross-origin-resource-policy']).toBe('same-site');
  expect(h['referrer-policy']).toBe('no-referrer');
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
