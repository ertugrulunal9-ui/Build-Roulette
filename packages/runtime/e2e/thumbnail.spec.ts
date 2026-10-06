import { expect, test, type Page } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { openPlayground } from './helpers';

/**
 * The client thumbnail (`capture-thumbnail` → `thumbnail`): the shell renders what the
 * build frame shows into a small WebP, the fallback for the server capture (docs/03 §3.7).
 */

/** Decodes a data URL in the page and returns its size and the colour at (x, y). */
async function pixelAt(page: Page, url: string, x: number, y: number) {
  return page.evaluate(
    async ({ url, x, y }) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      return { width: img.naturalWidth, height: img.naturalHeight, r, g, b };
    },
    { url, x, y },
  );
}

async function loadAndWait(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate(({ files, manifest }) => window.__playground.setProject(files, manifest), {
    files,
    manifest: REACT_MANIFEST,
  });
  const report = await page.evaluate(() => window.__playground.buildAndLoad());
  expect(report.ok).toBe(true);
  await page.evaluate(() => window.__playground.waitForReady(window.__playground.lastLoadId()));
}

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 24;

test('a DOM build: the thumbnail is a WebP of the page, styles included', async ({ page }) => {
  await openPlayground(page);
  await loadAndWait(page, {
    ...reactApp(
      `<main style={{ position: 'fixed', inset: 0, background: 'rgb(255, 87, 34)' }}><h1>Thumb</h1></main>`,
    ),
  });
  const webp = await page.evaluate(() => window.__playground.captureThumbnail(320, 200));
  expect(webp?.startsWith('data:image/webp;base64,')).toBe(true);
  const px = await pixelAt(page, webp ?? '', 160, 150);
  expect([px.width, px.height]).toEqual([320, 200]);
  expect(near(px.r, 255) && near(px.g, 87) && near(px.b, 34)).toBe(true);
});

test('a canvas build: the thumbnail copies the canvas pixels', async ({ page }) => {
  await openPlayground(page);
  await loadAndWait(
    page,
    reactApp(
      `<canvas ref={(c) => { if (!c) return; c.width = 400; c.height = 300; const ctx = c.getContext('2d')!; ctx.fillStyle = 'rgb(0, 160, 80)'; ctx.fillRect(0, 0, 400, 300); }} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }} />`,
    ),
  );
  const webp = await page.evaluate(() => window.__playground.captureThumbnail(160, 100));
  expect(webp?.startsWith('data:image/webp;base64,')).toBe(true);
  const px = await pixelAt(page, webp ?? '', 80, 50);
  expect(near(px.r, 0) && near(px.g, 160) && near(px.b, 80)).toBe(true);
});
