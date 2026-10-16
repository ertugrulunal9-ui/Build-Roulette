import { expect, test } from '@playwright/test';
import { buildFrame, fmt, openPlayground, siteFrame } from './helpers';

test('a. the sample site (module entry, CSS, lazy chunk, data file) renders inside the cross-site iframe', async ({
  page,
}) => {
  const boot = await openPlayground(page);
  console.log(
    `[metrics] handshake ${fmt(boot.connectMs)} after page start; first preview (load -> ready, worker registration included) ${fmt(boot.firstPreviewMs)}`,
  );

  const frame = buildFrame(page);
  const title = frame.getByTestId('title');
  await expect(title).toHaveText('Hello Build Roulette');
  // The site's own stylesheet (/assets/index-s4mpl3.css).
  await expect(title).toHaveCSS('color', 'rgb(255, 0, 128)');
  await expect(frame.getByTestId('data')).toHaveText('data from /data.json');
  await expect(frame.locator('#root')).toHaveAttribute('data-lazy', 'loaded');
  await frame.getByTestId('inc').click();
  await frame.getByTestId('inc').click();
  await expect(frame.getByTestId('inc')).toHaveText('count is 2');

  // The site's document: standards mode, on the sandbox origin, at `/` (the site id is gone
  // from the address), with the bootstrap first in <head>.
  const info = await siteFrame(page).evaluate(() => ({
    compatMode: document.compatMode,
    origin: location.origin,
    path: location.pathname + location.search,
    firstInHead: document.head.firstElementChild?.outerHTML.slice(0, 30) ?? null,
    controlled: navigator.serviceWorker.controller?.scriptURL ?? null,
  }));
  expect(info.compatMode).toBe('CSS1Compat');
  expect(info.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(info.path).toBe('/');
  expect(info.firstInHead).toMatch(/^<script>\(function\(\)\{/);
  expect(info.controlled).toMatch(/\/v2\/sw\.js$/);

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
