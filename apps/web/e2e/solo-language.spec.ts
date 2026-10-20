import { expect, test, type Page } from '@playwright/test';
import { watchCsp } from './csp';
import { buildFrame, clickRouted, startBattle, waitForBuild } from './helpers';
import { dropFiles, importApp, sourceProject, zipFiles } from './sites';

/**
 * Switching to Turkish in the middle of a battle (T-050) against the real local stack: the
 * import error and the BUILD stage reword in place, while the imported site keeps running (the
 * same preview iframe, the site's own state intact) and the countdown keeps going; then ship
 * and see the results in Turkish.
 *
 * `LANGUAGE_SCREENSHOT_DIR=/dir` saves Turkish screenshots (1280×800).
 */

const SHOTS = process.env['LANGUAGE_SCREENSHOT_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The countdown's `m:ss` in seconds. */
async function countdownSeconds(page: Page): Promise<number> {
  const text = await page.getByTestId('countdown').innerText();
  const m = /(\d+):(\d\d)/.exec(text);
  if (!m) throw new Error(`no countdown in ${JSON.stringify(text)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

test.use({ viewport: { width: 1280, height: 800 } });

test('TR during BUILD: the import stays, the countdown keeps running; ship → results in Turkish', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  watchCsp(page, pageErrors);

  await startBattle(page, 'E2E Dil');
  await waitForBuild(page);
  await expect(page.getByTestId('drop-title')).toHaveText('Drop your built site here');

  // An import error in English, then the switch: the same error, reworded in place.
  await dropFiles(page, [
    {
      name: 'my-app.zip',
      mimeType: 'application/zip',
      buffer: zipFiles(sourceProject(), 'my-app/'),
    },
  ]);
  await expect(page.getByTestId('import-error-title')).toHaveText(
    'This is source code, not the built site',
  );
  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('button', { name: /Türkçe/ })
    .click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByTestId('import-error-title')).toHaveText(
    'Bu kaynak kod, build’i alınmış site değil',
  );
  await expect(page.getByTestId('drop-title')).toHaveText('Build’i alınmış siteni buraya bırak');
  await expect(page.getByTestId('ship-button')).toHaveText('Teslim et 🚀');
  await shot(page, 'build-import-error');

  // Back to English for the import, so the switch happens with a running site.
  await page
    .getByRole('group', { name: 'Dil' })
    .getByRole('button', { name: /English/ })
    .click();
  await importApp(page, 'Dil Roketi', 'rgb(0, 150, 136)');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('import-summary')).toContainText('Imported dist · 4 files');

  // Marks that a remount or a reload would lose: one on the preview iframe, one inside the site.
  await page.getByTestId('preview-frame').evaluate((el) => {
    el.setAttribute('data-e2e-mark', 'kept');
  });
  await buildFrame(page)
    .locator('h1.e2e-title')
    .evaluate(() => {
      (window as unknown as { __e2eAlive: number }).__e2eAlive = 42;
    });
  const before = await countdownSeconds(page);

  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('button', { name: /Türkçe/ })
    .click();
  await expect(page.getByTestId('import-summary')).toContainText('İçe aktarılan: dist · 4 dosya');
  await expect(page.getByTestId('autosave-status')).toContainText('Kaydedildi');
  await expect(page.getByTestId('countdown')).toContainText('İnşa');
  await expect(page.getByTestId('preview-frame')).toHaveAttribute('title', 'Sitenin önizlemesi');
  // The same iframe, the same running site.
  await expect(page.getByTestId('preview-frame')).toHaveAttribute('data-e2e-mark', 'kept');
  await expect(page.locator('[data-testid=preview-frame]')).toHaveCount(1);
  expect(
    await buildFrame(page)
      .locator('h1.e2e-title')
      .evaluate(() => (window as unknown as { __e2eAlive?: number }).__e2eAlive),
  ).toBe(42);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Dil Roketi');
  // The countdown keeps running.
  await expect.poll(() => countdownSeconds(page), { timeout: 10_000 }).toBeLessThan(before);
  await expect(page.getByTestId('build-stage')).toBeVisible();
  await shot(page, 'build');

  // SHIP, in Turkish.
  await page.getByTestId('ship-button').click();
  await expect(page.getByTestId('ship-dialog')).toContainText('Teslim edilsin mi?');
  await page.getByTestId('build-name').fill('Dil Roketi');
  await clickRouted(page.getByTestId('confirm-ship'));

  // RESULTS, in Turkish.
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('Dil Roketi');
  await expect(page.getByTestId('build-status-text')).toHaveText('Teslim edildi');
  await expect(page.getByTestId('results')).toContainText('Sonuçlar');
  await expect(page.getByTestId('results')).toContainText('Yapan: E2E Dil');
  await expect(page.getByTestId('build-stats')).toHaveText(
    /^4 dosya · \d+ (B|KB) · bir kez içe aktarıldı$/,
  );
  await expect(page.locator('[data-testid=award][data-award=speedrun]')).toContainText('Speedrun');
  await expect(page.getByTestId('challenge')).toContainText('KURAL');
  await expect(page.getByTestId('screenshot')).toHaveAttribute('data-capture', 'captured', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('last-look')).toContainText('Son bakış');
  await shot(page, 'results');
  expect(pageErrors).toEqual([]);
});
