import { expect, test, type Page } from '@playwright/test';
import { html, markupSite, moduleSite, type SiteSpec } from './fixtures';
import { loadSite, openPlayground } from './helpers';

/**
 * The client thumbnail (`capture-thumbnail` → `thumbnail`): the shell renders what the
 * site frame shows into a small WebP, the fallback for the server capture (docs/03 §3.7).
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

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 24;

async function thumbnail(page: Page, files: SiteSpec, w: number, h: number) {
  await openPlayground(page);
  await loadSite(page, files);
  const webp = await page.evaluate(({ w, h }) => window.__playground.captureThumbnail(w, h), {
    w,
    h,
  });
  expect(webp?.startsWith('data:image/webp;base64,')).toBe(true);
  return webp ?? '';
}

test('a DOM site: the thumbnail is a WebP of the page, inline styles included', async ({
  page,
}) => {
  const webp = await thumbnail(
    page,
    markupSite(
      '<main style="position: fixed; inset: 0; background: rgb(255, 87, 34)"><h1>Thumb</h1></main>',
    ),
    320,
    200,
  );
  const px = await pixelAt(page, webp, 160, 150);
  expect([px.width, px.height]).toEqual([320, 200]);
  expect(near(px.r, 255) && near(px.g, 87) && near(px.b, 34)).toBe(true);
});

test('a built site: its linked stylesheet (/assets/*.css) is in the thumbnail', async ({
  page,
}) => {
  const webp = await thumbnail(
    page,
    {
      'index.html': html({
        head: '<link rel="stylesheet" href="/assets/index-c55.css" />',
        body: '<main class="hero"><h1>Linked</h1></main>',
      }),
      'assets/index-c55.css':
        '.hero { position: fixed; inset: 0; background: rgb(30, 90, 200); }\n',
    },
    320,
    200,
  );
  const px = await pixelAt(page, webp, 160, 150);
  expect(near(px.r, 30) && near(px.g, 90) && near(px.b, 200)).toBe(true);
});

test('a canvas site: the thumbnail copies the canvas pixels', async ({ page }) => {
  const webp = await thumbnail(
    page,
    moduleSite(`root.innerHTML = '<canvas style="position: fixed; inset: 0; width: 100vw; height: 100vh"></canvas>';
const c = root.querySelector('canvas');
c.width = 400;
c.height = 300;
const ctx = c.getContext('2d');
ctx.fillStyle = 'rgb(0, 160, 80)';
ctx.fillRect(0, 0, 400, 300);`),
    160,
    100,
  );
  const px = await pixelAt(page, webp, 80, 50);
  expect(near(px.r, 0) && near(px.g, 160) && near(px.b, 80)).toBe(true);
});
