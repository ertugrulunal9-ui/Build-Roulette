import { expect, test } from '@playwright/test';
import { buildFrame, clickRouted, startBattle, waitForBuild } from './helpers';
import { importApp } from './sites';
import { ephemeralObjects, sql } from './stack';

/**
 * Storage goes down during BUILD (playwright.solo.config.ts, the real local stack): the
 * import still runs in the preview and is kept in this browser; the autosave says it failed
 * and retries until Storage answers again; then ship, results and the last look work.
 * (Before M6 this suite took the package CDN down; imported sites need no package CDN.)
 */

test('Storage down mid-BUILD: the import runs and is kept, the autosave retries, then ships', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const battle = await startBattle(page, 'E2E Storage Down');
  await waitForBuild(page);
  const uid = sql(`select builder_id from public.builds where battle_id = '${battle}'`);

  // Storage refuses every connection (uploads and downloads of build files).
  let refused = 0;
  await page.route('**/storage/v1/object/**', (route) => {
    refused++;
    return route.abort('connectionrefused');
  });
  await importApp(page, 'Made offline', 'rgb(0, 150, 136)');
  // The preview does not need Storage.
  await expect(buildFrame(page).locator('main')).toHaveCSS('background-color', 'rgb(0, 150, 136)');
  const status = page.getByTestId('autosave-status');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(status).toHaveText('Save failed, retrying');
  expect(refused).toBeGreaterThan(0);
  expect(ephemeralObjects(battle)).toEqual([]);

  // A reload while Storage is still down: the import comes back from this browser.
  await page.reload();
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Made offline', {
    timeout: 30_000,
  });
  await expect(status).toHaveAttribute('data-state', 'error');

  // Storage is back: the next retry (5, 10, 20 s…) lands.
  await page.unroute('**/storage/v1/object/**');
  await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  expect(ephemeralObjects(battle)).toEqual([`${battle}/${uid}/autosave/site.bin`]);

  // Ship: the site pack, the client thumbnail, the RPC.
  await page.getByTestId('ship-button').click();
  await page.getByTestId('build-name').fill('E2E Back Online');
  await clickRouted(page.getByTestId('confirm-ship'));
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('E2E Back Online');
  expect(ephemeralObjects(battle)).toEqual(
    expect.arrayContaining([`${battle}/${uid}/site.bin`, `${battle}/${uid}/thumb.webp`]),
  );
  const reveal = page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe');
  await expect(reveal.locator('h1.e2e-title')).toHaveText('Made offline');
  expect(pageErrors).toEqual([]);
});

test('a ship while Storage is down fails with a message; the player can ship once it is back', async ({
  page,
}) => {
  await startBattle(page, 'E2E Ship Retry');
  await waitForBuild(page);
  await importApp(page, 'Ship me', 'rgb(255, 193, 7)');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');

  await page.route('**/storage/v1/object/**', (route) => route.abort('connectionrefused'));
  await page.getByTestId('ship-button').click();
  await page.getByTestId('build-name').fill('E2E Retried');
  await clickRouted(page.getByTestId('confirm-ship'));
  await expect(page.getByTestId('ship-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('confirm-ship')).toHaveText('Try again');

  await page.unroute('**/storage/v1/object/**');
  await clickRouted(page.getByTestId('confirm-ship'));
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('E2E Retried');
});
