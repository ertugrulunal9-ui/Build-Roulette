import { expect, test, type Page } from '@playwright/test';
import {
  CDN_ORIGIN,
  buildFrame,
  clickRouted,
  replaceEditorText,
  setCdnOutage,
  startBattle,
  waitForBuild,
} from './helpers';
import { ephemeralObjects, sql } from './stack';

/**
 * T-032: the package CDN goes down during BUILD (playwright.solo.config.ts, the real local
 * stack). The template preview ran during SPIN, so React is in the browser's HTTP cache:
 * editing, autosave, ship and the last look keep working. The screenshot renderer is
 * another browser without that cache, so the client thumbnail stands in for it.
 */

test.afterEach(async ({ page }) => {
  await setCdnOutage(page, 'off');
});

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('CDN down mid-BUILD: edit, autosave, ship and the last look still work', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const battle = await startBattle(page, 'E2E Offline');
  await waitForBuild(page);
  await expect(buildFrame(page).locator('h1')).toHaveText('Hello, Build Roulette!');

  await setCdnOutage(page, 'refuse');
  const failed: string[] = [];
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(CDN_ORIGIN)) failed.push(r.url());
  });

  await replaceEditorText(
    page,
    `import { useState } from 'react';

export function App() {
  const [n, setN] = useState(0);
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeContent: 'center' }}>
      <h1 className="e2e-offline">Shipped offline</h1>
      <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>
    </main>
  );
}
`,
  );
  const frame = buildFrame(page);
  await expect(frame.locator('h1.e2e-offline')).toHaveText('Shipped offline');
  await frame.getByRole('button').click();
  await expect(frame.getByRole('button')).toHaveText('Clicked 1');

  // Autosave goes to Storage, not to the package CDN.
  await setVisibility(page, 'hidden');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await setVisibility(page, 'visible');
  const uid = sql(`select builder_id from public.builds where battle_id = '${battle}'`);
  expect(ephemeralObjects(battle)).toContain(`${battle}/${uid}/autosave/bundle.js`);

  // Ship: a production build, the client thumbnail, the upload and the RPC.
  await page.getByTestId('ship-button').click();
  await page.getByTestId('build-name').fill('E2E Offline');
  await clickRouted(page.getByTestId('confirm-ship'));
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('E2E Offline');
  expect(ephemeralObjects(battle)).toEqual(
    expect.arrayContaining([`${battle}/${uid}/bundle.js`, `${battle}/${uid}/thumb.webp`]),
  );

  // The last look runs the shipped bundle in a fresh reveal-mode preview, from the cache.
  const reveal = page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe');
  await expect(reveal.locator('h1.e2e-offline')).toHaveText('Shipped offline');
  await expect(page.getByTestId('reveal-no-packages')).toHaveCount(0);

  // The renderer's browser has no cached React: the client thumbnail is the screenshot.
  await expect(page.getByTestId('screenshot')).toHaveAttribute('data-capture', 'fallback', {
    timeout: 90_000,
  });
  expect(failed).toEqual([]);
  expect(pageErrors).toEqual([]);
});
