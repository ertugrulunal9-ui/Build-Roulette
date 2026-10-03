import { expect, test } from '@playwright/test';
import { buildFrame, fmt, openPlayground } from './helpers';

test('a. React + TS + local CSS + zustand + package CSS render inside the cross-site iframe', async ({
  page,
}) => {
  const boot = await openPlayground(page);
  console.log(
    `[metrics] worker cold start (new Worker -> esbuild-wasm ready): ${fmt(boot.coldStartMs)} (wasm init inside worker ${fmt(boot.wasmInitMs)})`,
  );
  console.log(
    `[metrics] first build ${fmt(boot.firstBuildMs)}, first preview (build -> ready, cold CDN) ${fmt(boot.firstPreviewMs)}`,
  );

  const frame = buildFrame(page);
  const title = frame.getByTestId('title');
  await expect(title).toHaveText('Hello Build Roulette');
  // Local styles.css
  await expect(title).toHaveCSS('color', 'rgb(255, 0, 128)');
  // Package CSS (animate.css fetched from the CDN by the worker and inlined)
  await expect(title).toHaveCSS('animation-name', 'fadeIn');
  // zustand store + React event handling (single React instance, hooks work)
  await frame.getByTestId('inc').click();
  await frame.getByTestId('inc').click();
  await expect(frame.getByTestId('inc')).toHaveText('count is 2');

  // The build document is a standards-mode document with the import map applied.
  const info = await page
    .frames()
    .find((f) => f.parentFrame()?.parentFrame() === page.mainFrame())
    ?.evaluate(() => ({
      compatMode: document.compatMode,
      origin: location.origin,
      importMap: document.querySelector('script[type="importmap"]')?.textContent ?? null,
    }));
  expect(info?.compatMode).toBe('CSS1Compat');
  expect(info?.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(info?.importMap).toContain('"react"');

  // The app page cannot reach into the sandbox (cross-origin).
  const crossOriginBlocked = await page.evaluate(() => {
    const f = document.querySelector<HTMLIFrameElement>('#preview');
    try {
      return f?.contentDocument === null;
    } catch {
      return true;
    }
  });
  expect(crossOriginBlocked).toBe(true);

  const attrs = await page.locator('#preview').evaluate((f) => ({
    sandbox: f.getAttribute('sandbox'),
    allow: f.getAttribute('allow'),
    referrerpolicy: f.getAttribute('referrerpolicy'),
  }));
  expect(attrs).toEqual({
    sandbox:
      'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups',
    allow: 'autoplay; fullscreen; gamepad; clipboard-write',
    referrerpolicy: 'no-referrer',
  });
});
