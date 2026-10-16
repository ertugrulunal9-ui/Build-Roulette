import { expect, test, type Page } from '@playwright/test';
import { buildFrame, clickRouted, startBattle, waitForBuild } from './helpers';
import { watchCsp } from './csp';
import { crawl, one } from './link-preview';
import { importApp, importFolder, importZip, plainSite, viteSite, writeProject } from './sites';
import { battleRow, ephemeralObjects, sql } from './stack';

/**
 * The solo game end to end against the real local Supabase stack with the capture worker
 * running (playwright.solo.config.ts), in import mode (docs/09): the player imports a built
 * site (a fixture, sites.ts). Deadlines are forced with psql as the superuser.
 *
 * SOLO_SCREENSHOT_DIR=/some/dir also saves UI screenshots (spin, build, results, battle page).
 */

const SHOTS = process.env['SOLO_SCREENSHOT_DIR'];

async function snap(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t014-${name}.png` });
}

/** The battle's site kept in this page's IndexedDB (`br-sites`), or null. */
async function storedSite(page: Page, battle: string): Promise<{ imports: number } | null> {
  return page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('br-sites');
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(new Error('open failed'));
      };
    });
    if (!db.objectStoreNames.contains('sites')) {
      db.close();
      return null;
    }
    const tx = db.transaction('sites', 'readonly');
    const value = await new Promise((resolve) => {
      const r = tx.objectStore('sites').get(key);
      r.onsuccess = () => {
        resolve(r.result as unknown);
      };
    });
    db.close();
    return (value as { imports: number } | undefined) ?? null;
  }, `battle:${battle}`);
}

/** The colour at (x, y) of an image URL, decoded by the browser. */
async function pixel(page: Page, url: string, x: number, y: number) {
  return page.evaluate(
    async ({ url, x, y }) => {
      const res = await fetch(url);
      const bitmap = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      return { width: bitmap.width, height: bitmap.height, r, g, b };
    },
    { url, x, y },
  );
}

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 20;

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('ship: spin → build → ship → results (screenshot, speedrun) → destroy → permanent page', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  watchCsp(page, pageErrors);

  const battle = await startBattle(page, 'E2E Shipper');
  // The reels land one after another on the server's cards.
  await expect(page.getByTestId('reel-build')).toHaveAttribute('data-landed', 'true');
  await snap(page, 'spin');
  const reelText = await page.getByTestId('reel-build').innerText();
  // (The later reels are not awaited: on a busy machine BUILD can start before the test sees
  // the last one land.)
  const card = sql(
    `select c.build_text from public.battles b join public.challenges c on c.id = b.challenge_id where b.id = '${battle}'`,
  );
  expect(reelText).toContain(card);

  // BUILD: the challenge header, the countdown, the drop zone; Ship it waits for an import.
  await waitForBuild(page);
  await expect(page.getByTestId('challenge')).toContainText(card);
  await expect(page.getByTestId('drop-title')).toHaveText('Drop your built site here');
  await expect(page.getByTestId('ship-button')).toBeDisabled();
  await expect(page.getByTestId('autosave-status')).toHaveText('Nothing imported yet');
  // A first try with a .zip, then the real build with "Choose folder": the last one counts.
  await importZip(page, plainSite('First draft', 'rgb(90, 90, 90)'));
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('First draft');
  await importApp(page, 'Rocket Pomodoro', 'rgb(255, 87, 34)');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('import-summary')).toContainText('Imported dist · 4 files');
  await expect.poll(() => storedSite(page, battle)).toMatchObject({ imports: 2 });
  await snap(page, 'build');

  // SHIP.
  await expect(page.getByTestId('ship-button')).toBeEnabled();
  await page.getByTestId('ship-button').click();
  await expect(page.getByTestId('ship-dialog')).toContainText("You can't import again after");
  await page.getByTestId('build-name').fill('E2E Rocket');
  await clickRouted(page.getByTestId('confirm-ship'));

  // RESULTS: speedrun, completion time, then the real screenshot from the capture worker.
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('E2E Rocket');
  await expect(page.locator('[data-testid=award][data-award=speedrun]')).toBeVisible();
  await expect(page.getByTestId('completion-time')).toHaveText(/^\d+:\d\d\.\d$/);
  const shot = page.getByTestId('screenshot');
  await expect(shot).toHaveAttribute('data-capture', 'captured', { timeout: 90_000 });
  await expect
    .poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(1280);
  const src = (await shot.getAttribute('src')) ?? '';
  expect(src).toContain(`/storage/v1/object/public/screenshots/${battle}/`);
  const px = await pixel(page, src, 40, 760);
  expect(near(px.r, 255) && near(px.g, 87) && near(px.b, 34)).toBe(true);
  // The stats: files, the pack's size, two imports.
  await expect(page.getByTestId('build-stats')).toHaveText(
    /^4 files · \d+ (B|KB) · imported 2 times$/,
  );
  const stats = JSON.parse(
    sql(`select stats::text from public.builds where battle_id = '${battle}'`),
  ) as Record<string, unknown>;
  expect(stats).toEqual({ files: 4, bundle_bytes: expect.any(Number) as unknown, imports: 2 });
  // The last look runs the shipped site in reveal mode.
  const reveal = page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe');
  await expect(reveal.locator('h1.e2e-title')).toHaveText('Rocket Pomodoro');
  await expect(page.locator('[data-testid=reveal-frame]')).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
  );
  // What was uploaded: the autosave of each import, and at ship the site pack and the
  // client thumbnail.
  const uid = sql(`select builder_id from public.builds where battle_id = '${battle}'`);
  const files = ephemeralObjects(battle).map((n) => n.slice(`${battle}/${uid}/`.length));
  expect(files.sort()).toEqual(['autosave/site.bin', 'site.bin', 'thumb.webp']);
  await snap(page, 'results');

  // Force the end of the last-look window: DESTROY.
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battle}'`,
  );
  await expect(page.getByTestId('destroy-moment')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('build-destroyed')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid=reveal-frame]')).toHaveCount(0, { timeout: 10_000 });
  // The battle's site is gone from IndexedDB.
  await expect.poll(() => storedSite(page, battle)).toBeNull();
  // The destroy worker deletes the ephemeral files on the server.
  await expect(page.getByTestId('source-status')).toContainText('deleted from the server', {
    timeout: 60_000,
  });
  expect(ephemeralObjects(battle)).toEqual([]);
  const row = battleRow(battle);
  expect(row.phase).toBe('destroyed');
  expect(row.destroyed_at).not.toBeNull();

  // The permanent page.
  await page.getByTestId('permanent-link').click();
  await expect(page).toHaveURL(new RegExp(`/battles/${battle}$`));
  await expect(page.getByTestId('battle-title')).toHaveText(card);
  await expect(page.getByTestId('public-build-name')).toContainText('E2E Rocket');
  await expect(page.locator('[data-testid=award][data-award=speedrun]')).toBeVisible();
  await expect(page.getByTestId('public-completion')).toHaveText(/^\d+:\d\d\.\d$/);
  await expect
    .poll(() =>
      page
        .getByTestId('public-screenshot')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBe(1280);
  const shotUrl = await page.getByTestId('public-screenshot').getAttribute('src');
  expect(shotUrl).toContain(`/storage/v1/object/public/screenshots/${battle}/`);
  const shotFile = await page.request.get(shotUrl ?? '');
  expect(shotFile.status()).toBe(200);
  expect(shotFile.headers()['content-type']).toMatch(/^image\/(webp|png|jpeg)$/);
  // The page is a static shell (T-037); its link preview is written at the edge (T-038): a
  // crawler, which runs no script, gets this battle's title and this screenshot.
  const preview = await crawl(page.request, `/battles/${battle}`);
  expect(preview.status).toBe(200);
  expect(one(preview, 'og:image')).toBe(shotUrl);
  expect(one(preview, 'og:title')).toMatch(/^E2E Rocket by /);
  expect(preview.titles).toEqual([await page.title()]);
  await expect(page).toHaveTitle(/^E2E Rocket by .* · Build Roulette$/);
  await snap(page, 'battle-page');

  // Play again starts over.
  await page.goto('/play');
  await expect(page.getByTestId('display-name')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('auto-ship: no ship; at the deadline the last import (its CSS too) is shipped and captured', async ({
  page,
}) => {
  const battle = await startBattle(page, 'E2E Autosaver');
  await waitForBuild(page);

  // The whole project folder: the import finds dist/ in it. The background comes only from
  // the stylesheet under /assets/.
  const { project } = writeProject(viteSite('Autosaved build', 'rgb(0, 160, 80)'));
  await importFolder(page, project);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Autosaved build');
  await expect(buildFrame(page).locator('main')).toHaveCSS('background-color', 'rgb(0, 160, 80)');
  await expect(page.getByTestId('import-summary')).toContainText('2 skipped');
  // Every import is autosaved at once.
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  const uid = sql(`select builder_id from public.builds where battle_id = '${battle}'`);
  expect(ephemeralObjects(battle)).toEqual([`${battle}/${uid}/autosave/site.bin`]);

  // Force the build deadline (and its grace) to the past; the client notices and nudges.
  sql(`update public.battles
         set building_started_at = now() - interval '620 seconds',
             building_ends_at = now() - interval '20 seconds',
             phase_ends_at = now() - interval '20 seconds'
       where id = '${battle}'`);
  await setVisibility(page, 'visible'); // resync now instead of at the next poll
  await expect(page.getByTestId('times-up')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('times-up')).toContainText('Your last import is being shipped');
  await expect.poll(() => battleRow(battle).phase, { timeout: 20_000 }).toBe('shipping');
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battle}'`,
  );

  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('build-status-text')).toHaveText('Auto-shipped at the deadline');
  await expect(page.getByTestId('award')).toHaveCount(0);
  const shot = page.getByTestId('screenshot');
  await expect(shot).toHaveAttribute('data-capture', 'captured', { timeout: 90_000 });
  const src = (await shot.getAttribute('src')) ?? '';
  // Green background: the capture rendered autosave/site.bin with its stylesheet.
  const px = await pixel(page, src, 1200, 700);
  expect(near(px.r, 0) && near(px.g, 160) && near(px.b, 80)).toBe(true);
  // The last look shows the autosaved site.
  const reveal = page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe');
  await expect(reveal.locator('h1.e2e-title')).toHaveText('Autosaved build');
});

test('a reload during BUILD brings the last import back (this browser, then the remote autosave)', async ({
  page,
  browser,
}) => {
  const battle = await startBattle(page, 'E2E Reloader');
  await waitForBuild(page);
  await importApp(page, 'Before the reload', 'rgb(120, 20, 160)');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');

  // A reload: the import is back at once from IndexedDB, with the import count.
  await page.reload();
  await expect(page.getByTestId('build-stage')).toBeVisible({ timeout: 30_000 });
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Before the reload', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('ship-button')).toBeEnabled();
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await expect.poll(() => storedSite(page, battle)).toMatchObject({ imports: 1 });

  // The same player on a browser without that copy (cleared storage): the remote autosave.
  const state = await page.context().storageState();
  const other = await browser.newContext({
    storageState: { cookies: state.cookies, origins: state.origins.map((o) => ({ ...o })) },
  });
  const page2 = await other.newPage();
  // Only the session (localStorage) travels with storageState; IndexedDB stays behind.
  await page2.goto(`/play?battle=${battle}`);
  await expect(page2.getByTestId('build-stage')).toBeVisible({ timeout: 30_000 });
  await expect(buildFrame(page2).locator('h1.e2e-title')).toHaveText('Before the reload', {
    timeout: 30_000,
  });
  await expect(page2.getByTestId('import-summary')).toContainText('the folder you dropped');
  await other.close();
});
