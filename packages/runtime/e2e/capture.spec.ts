/**
 * The capture page (`/v2/capture`, docs/03 §3.7, docs/09 §9.3): a signed URL of a site pack
 * renders the site top-level at 1280×800, through the same site worker as the preview.
 * The dev server stores packs (`PUT /__test/site`) on the other test origin and signs capture
 * URLs with its per-process secret (`/__test/capture-url`).
 */
import { expect, test, type Page } from '@playwright/test';
import { viteLikeSite, type SiteSpec } from './fixtures';
import { openPlayground } from './helpers';

const READY_SITE: SiteSpec = {
  ...viteLikeSite('Captured'),
  // The entry also tells the capture renderer that its first frame is on screen.
  'assets/index-abc.js': `${viteLikeSite('Captured')['assets/index-abc.js'] ?? ''}
const pick = (r) => Object.fromEntries([...r.headers].filter(([k]) => k === 'content-security-policy'));
fetch('/').then((r) => { document.body.dataset.csp = pick(r)['content-security-policy']; });
requestAnimationFrame(() => window.buildRoulette?.ready());
`,
};

async function signedCaptureUrl(page: Page, name: string, files: SiteSpec): Promise<string> {
  await openPlayground(page);
  await page.evaluate(({ name, files }) => window.__playground.uploadPack(name, files), {
    name,
    files,
  });
  const res = await page.request.get(`/__test/capture-url?name=${name}`);
  expect(res.status()).toBe(200);
  return res.text();
}

test('g. a signed capture URL renders the site pack, with the ready signal and the paint state', async ({
  page,
  context,
}) => {
  const url = await signedCaptureUrl(page, 'cap1', READY_SITE);
  expect(url).toMatch(/\/v2\/capture\?exp=\d+&src=[^&]+&sig=[\w-]{43}$/);

  const capture = await context.newPage();
  await capture.setViewportSize({ width: 1280, height: 800 });
  const lines: string[] = [];
  capture.on('console', (m) => lines.push(m.text()));
  const res = await capture.goto(url);
  expect(res?.status()).toBe(200);
  await expect(capture.locator('html')).toHaveAttribute('data-br-capture', 'ready');
  await expect(capture.locator('html')).toHaveAttribute('data-br-paint', 'content');
  const site = capture.frameLocator('iframe');
  await expect(site.getByTestId('title')).toHaveText('Captured');
  await expect(site.getByTestId('title')).toHaveCSS('color', 'rgb(255, 0, 128)');
  await expect
    .poll(async () => {
      const text = await site.getByTestId('out').textContent();
      return text ? (JSON.parse(text) as unknown) : null;
    })
    .toEqual({
      lazy: 'chunk ok',
      data: 'Captured data',
      worker: 'worker Captured data',
      image: '40x20',
    });
  expect(lines).toContain('[br-capture] loaded');
  expect(lines).toContain('[br-capture] ready');
  expect(lines.filter((l) => l.startsWith('[br-capture] failed'))).toEqual([]);

  // The site runs under the capture variant of the site CSP: framed by the capture page only,
  // with the capture page's sandbox flags.
  const csp = await site.locator('body').getAttribute('data-csp');
  expect(csp).toContain("frame-ancestors 'self';");
  expect(csp).toMatch(/; sandbox allow-scripts allow-same-origin allow-forms allow-pointer-lock$/);
  // The site's frame is 1280×800, at `/`.
  const frame = capture.frames().find((f) => f.parentFrame() === capture.mainFrame());
  expect(
    await frame?.evaluate(() => [innerWidth, innerHeight, location.pathname + location.search]),
  ).toEqual([1280, 800, '/']);
});

test('g. the capture gate refuses a tampered URL, and a broken pack fails visibly', async ({
  page,
  context,
}) => {
  const url = await signedCaptureUrl(page, 'cap2', READY_SITE);
  const tampered = url.replace(
    /src=[^&]+/,
    `src=${encodeURIComponent('http://localhost:1/x.bin')}`,
  );
  const refused = await page.request.get(tampered);
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toBe('');

  const capture = await context.newPage();
  // A pack the page cannot read: the page says so in its attributes.
  await page.evaluate(async () => {
    const res = await fetch('/__test/site?name=broken', { method: 'PUT', body: 'not a pack' });
    if (!res.ok) throw new Error(String(res.status));
  });
  const broken = await (await page.request.get('/__test/capture-url?name=broken')).text();
  await capture.goto(broken);
  await expect(capture.locator('html')).toHaveAttribute('data-br-capture', 'failed');
  await expect(capture.locator('html')).toHaveAttribute(
    'data-br-capture-error',
    /The imported site could not be read: not a site pack/,
  );
});
