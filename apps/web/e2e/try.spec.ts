import { expect, test } from '@playwright/test';
import { buildFrame, clickRouted, openTry } from './helpers';
import {
  dropFiles,
  importFolder,
  importZip,
  plainSite,
  sourceProject,
  viteSite,
  writeProject,
  zipFiles,
} from './sites';

/**
 * `/try` (docs/09 §9.5): the import practice page. No battle, no account, no upload: the
 * drop zone, the pickers, a real drop, what a refused import says, and the live preview of
 * an imported site (its files, Problems, the watchdog, the keyboard).
 */

test('a Vite-like dist folder picked with "Choose folder" runs: module, stylesheet, root-relative URLs', async ({
  page,
}) => {
  const { pageErrors } = await openTry(page);
  await expect(page).toHaveTitle(/^Try an import · Build Roulette$/);
  await expect(page.getByTestId('drop-title')).toHaveText('Drop your built site here');
  await expect(page.getByTestId('choose-folder')).toBeVisible();
  await expect(page.getByTestId('choose-zip')).toBeVisible();
  // Before anything is imported, nothing is uploaded or stored: no Supabase at all here.
  const supabase: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(':54321')) supabase.push(r.url());
  });

  const { dist } = writeProject(viteSite('Hello from dist', 'rgb(255, 87, 34)'));
  await importFolder(page, dist);
  const h1 = buildFrame(page).locator('h1.e2e-title');
  await expect(h1).toHaveText('Hello from dist');
  // The stylesheet under /assets/ loaded (the background comes only from it).
  await expect(buildFrame(page).locator('main')).toHaveCSS('background-color', 'rgb(255, 87, 34)');
  // The picked folder is the build output itself.
  const summary = page.getByTestId('import-summary');
  await expect(summary).toHaveAttribute('data-root', 'dist/');
  await expect(summary).toContainText('Imported dist · 4 files');
  await expect(page.getByTestId('drop-zone')).toHaveCount(0);
  // The site runs with `location.pathname === '/'`, like on a static host.
  await expect
    .poll(() =>
      buildFrame(page)
        .locator('body')
        .evaluate(() => location.pathname),
    )
    .toBe('/');
  expect(supabase).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('a whole project folder: the dist folder inside is found, the rest is left out', async ({
  page,
}) => {
  await openTry(page);
  const { project } = writeProject(viteSite('From the project', 'rgb(0, 150, 136)'));
  await importFolder(page, project);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('From the project');
  const summary = page.getByTestId('import-summary');
  await expect(summary).toContainText('Imported my-app/dist · 4 files');
  await expect(summary).toContainText('2 skipped'); // package.json and src/main.ts
});

test('a .zip, then Import again replaces the site (the preview reloads)', async ({ page }) => {
  await openTry(page);
  await importZip(page, viteSite('Zipped', 'rgb(33, 150, 243)'));
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Zipped');

  // Import again: the menu offers both pickers (keyboard reachable buttons).
  await clickRouted(page.getByTestId('import-again'));
  await expect(page.getByTestId('import-again-folder')).toBeVisible();
  await expect(page.getByTestId('import-again-zip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('import-again-folder')).toBeHidden();
  const { dist } = writeProject(viteSite('Second import', 'rgb(76, 175, 80)'));
  await importFolder(page, dist);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Second import');
  await expect(page.getByTestId('import-summary')).toContainText('4 files');
});

test('a real drop: a one-file plain HTML site, then a dropped .zip replaces it', async ({
  page,
}) => {
  const { pageErrors } = await openTry(page);
  await dropFiles(page, [
    {
      name: 'index.html',
      mimeType: 'text/html',
      buffer: Buffer.from(plainSite('Plain HTML', 'rgb(120, 20, 160)')['index.html'] ?? ''),
    },
  ]);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Plain HTML');
  await expect(page.getByTestId('import-summary')).toContainText('1 file');

  // Dropping anywhere on the page works over the running preview too.
  await dropFiles(page, [
    {
      name: 'build.zip',
      mimeType: 'application/zip',
      buffer: zipFiles(viteSite('Dropped zip', 'rgb(0, 160, 80)'), 'dist/'),
    },
  ]);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Dropped zip');
  await expect(page.getByTestId('import-summary')).toContainText('dist');
  expect(pageErrors).toEqual([]);
});

test('dropping source code: "This is source code, not the built site", and the drop zone stays usable', async ({
  page,
}) => {
  await openTry(page);
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
  const hint = page.getByTestId('import-error-hint');
  await expect(hint).toContainText('npm run build');
  await expect(hint.locator('code').first()).toHaveText('npm run build');
  await expect(page.getByTestId('drop-zone')).toHaveAttribute('data-state', 'error');

  // A picked project folder without a build: the same answer.
  const { project } = writeProject(sourceProject(), { sub: '' });
  await importFolder(page, project);
  await expect(page.getByTestId('import-error-title')).toHaveText(
    'This is source code, not the built site',
  );

  // The zone still takes the built site.
  await importZip(page, viteSite('Built after all', 'rgb(63, 81, 181)'));
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Built after all');
  await expect(page.getByTestId('import-error')).toHaveCount(0);
});

test('Problems: a runtime error, a file that failed to load and console output; the site keeps running', async ({
  page,
}) => {
  await openTry(page);
  const site = viteSite('With problems', 'rgb(200, 90, 90)', {
    extraJs: `console.log('hello from the site');
const s = document.createElement('script');
s.src = '/assets/missing.js';
document.head.appendChild(s);
setTimeout(() => { throw new Error('boom from the site'); }, 0);`,
  });
  await importZip(page, site);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('With problems');
  await expect(page.getByTestId('problem-count')).toHaveText('(2)');
  // Only a site that cannot be served at all covers the preview.
  await expect(page.getByTestId('error-overlay')).toHaveCount(0);
  await clickRouted(page.getByTestId('problems-toggle'));
  const problems = page.getByTestId('problems');
  await expect(problems).toContainText('boom from the site');
  await expect(problems).toContainText('Failed to load /assets/missing.js');
  await clickRouted(page.getByRole('tab', { name: /Console/ }));
  await expect(page.getByTestId('console')).toContainText('hello from the site');
});

test('an infinite loop shows the crashed state; Restart, then a new import, recover', async ({
  page,
}) => {
  await openTry(page);
  await importZip(page, viteSite('Loop', 'rgb(0, 0, 0)', { extraJs: 'for (;;) {}' }));
  const crashed = page.getByTestId('preview-crashed');
  await expect(crashed).toBeVisible({ timeout: 30_000 });
  await expect(crashed).toContainText('The preview crashed');
  await expect(page.getByTestId('preview-frame')).toHaveCount(0);
  // The page itself stays responsive (the preview is site-isolated); Restart runs the same
  // site again, which loops again.
  await crashed.getByRole('button', { name: 'Restart preview' }).click();
  await expect(crashed).toBeHidden();
  await expect(crashed).toBeVisible({ timeout: 30_000 });
  // A fixed build, imported: runs in a fresh preview.
  await importZip(page, viteSite('Recovered', 'rgb(0, 128, 0)'));
  await expect(crashed).toBeHidden();
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Recovered');
});

test('a click into the preview gives the keyboard to the site', async ({ page }) => {
  await openTry(page);
  await importZip(
    page,
    viteSite('none', 'rgb(30, 64, 175)', {
      extraJs:
        "window.addEventListener('keydown', (e) => { document.querySelector('h1').textContent = e.key; });",
    }),
  );
  const h1 = buildFrame(page).locator('h1.e2e-title');
  await expect(h1).toHaveText('none');
  await h1.click();
  await page.keyboard.press('x');
  await expect(h1).toHaveText('x');
});

test('keyboard and colour scheme: the pickers are reachable with Tab; dark mode is dark', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openTry(page);
  const zone = page.getByTestId('drop-zone');
  await expect(zone).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(zone).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
  // Tab reaches "Choose folder" (after the header's link), Enter would open the picker.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('choose-folder').focus();
  await expect(page.getByTestId('choose-folder')).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await chooser).isMultiple()).toBe(true);
});

test('/playground moved to /try', async ({ page, request }) => {
  const res = await request.get('/playground', { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers()['location']).toMatch(/\/try$/);
  await page.goto('/playground');
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('drop-zone')).toBeVisible();
});
