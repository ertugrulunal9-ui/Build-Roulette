import { expect, test, type Page } from '@playwright/test';
import { WELCOME_KEY } from '../src/lib/onboarding/welcome';
import { LOCALE_STORAGE_KEY } from '../src/lib/i18n/locale';
import { watchCsp } from './csp';
import { buildFrame, clickRouted, openTry, startBattle, waitForBuild } from './helpers';
import { LINK_FIXTURE_ORIGIN, startLinkFixture, type LinkFixture } from './link-fixture';
import { viteSite, writeProject, importFolder } from './sites';
import { sql } from './stack';

/**
 * Import from a published link (docs/10, T-052) against the real local stack: the page checks
 * the link, signs in anonymously (on `/try`, only now), and the `import-url` Edge Function
 * copies a fixture site from a static server on this machine (e2e/link-fixture.ts, allowed for
 * this suite only). Then the copy runs exactly like a dropped folder.
 *
 * LINK_SCREENSHOT_DIR=/dir also saves screenshots of the link field, the copying state, an
 * error and the copied site (1280×800 light, dark, 390 px; English and Turkish).
 */

const LINK = `${LINK_FIXTURE_ORIGIN}/`;
const SHOTS = process.env['LINK_SCREENSHOT_DIR'];
const SUPABASE = ':54321';

let fixture: LinkFixture;
test.beforeAll(async () => {
  fixture = await startLinkFixture();
});
test.afterAll(async () => {
  await fixture.close();
});

/** Every request this page sends to Supabase (the URLs, in order). */
function supabaseRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(SUPABASE)) seen.push(r.url());
  });
  return seen;
}

async function pasteLink(page: Page, link: string): Promise<void> {
  const input = page.getByTestId('link-input');
  await input.fill(link);
  await input.press('Enter');
}

test('/try: a pasted link is copied and runs; the session is made only for it; Copy again', async ({
  page,
}) => {
  const { pageErrors } = await openTry(page);
  watchCsp(page, pageErrors);
  const requests = supabaseRequests(page);

  // A folder first: no Supabase at all.
  const { dist } = writeProject(viteSite('From a folder', 'rgb(90, 90, 90)'));
  await importFolder(page, dist);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('From a folder');
  expect(requests).toEqual([]);

  // Then a link, from "Import again → Paste a link…".
  fixture.serve(viteSite('Published on a host', 'rgb(255, 87, 34)'));
  await clickRouted(page.getByTestId('import-again'));
  await page.getByTestId('import-again-paste').click();
  await expect(page.getByTestId('link-input')).toBeFocused();
  await pasteLink(page, LINK);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Published on a host', {
    timeout: 30_000,
  });
  await expect(buildFrame(page).locator('main')).toHaveCSS('background-color', 'rgb(255, 87, 34)');
  const summary = page.getByTestId('import-summary');
  await expect(summary).toHaveAttribute('data-root', LINK);
  // index.html, the module and the stylesheet: a copy takes what the page uses (the fixture's
  // unreferenced vite.svg stays behind).
  await expect(summary).toContainText('Copied from host.docker.internal:4330 · 3 files');
  // Signed in anonymously for the link (and only then), then the function.
  expect(requests.some((u) => u.includes('/auth/v1/signup'))).toBe(true);
  expect(requests.filter((u) => u.endsWith('/functions/v1/import-url'))).toHaveLength(1);
  expect(fixture.hits).toContain('/');

  // Re-published: "Copy again from <host>" in one click.
  fixture.serve(viteSite('Published again', 'rgb(33, 150, 243)'));
  await clickRouted(page.getByTestId('import-again'));
  await expect(page.getByTestId('import-again-link')).toHaveText(
    /Copy again from host\.docker\.internal:4330/,
  );
  await page.getByTestId('import-again-link').click();
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Published again', {
    timeout: 30_000,
  });

  // The link is remembered in this browser: a new visit of /try offers it again.
  await page.reload();
  await expect(page.getByTestId('link-input')).toHaveValue(LINK, { timeout: 20_000 });
  expect(pageErrors).toEqual([]);
});

test('/try: a link on another host, or no link at all, fails at once without a request', async ({
  page,
}) => {
  const { pageErrors } = await openTry(page);
  watchCsp(page, pageErrors);
  const requests = supabaseRequests(page);

  await pasteLink(page, 'https://example.com/my-app');
  await expect(page.getByTestId('import-error-title')).toHaveText(
    "That site's host isn't supported",
  );
  await expect(page.getByTestId('import-error-hint')).toContainText('*.lovable.app');
  await expect(page.getByTestId('import-error-hint')).toContainText('download the code');
  await expect(page.getByTestId('link-input')).toHaveAttribute('aria-invalid', 'true');

  await pasteLink(page, 'my-app.lovable');
  await expect(page.getByTestId('import-error-title')).toHaveText("That link can't be used");
  // The list of hosts on demand.
  await page.getByTestId('link-hosts-toggle').click();
  await expect(page.getByTestId('link-hosts')).toContainText('*.netlify.app');
  expect(requests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('/try: a missing site and a private one get their words; copying can be cancelled', async ({
  page,
}) => {
  const { pageErrors } = await openTry(page);
  watchCsp(page, pageErrors);

  await pasteLink(page, `${LINK_FIXTURE_ORIGIN}/gone/`);
  await expect(page.getByTestId('import-error-title')).toHaveText("That site couldn't be loaded", {
    timeout: 30_000,
  });
  await expect(page.getByTestId('import-error-hint')).toContainText('It answered 404.');

  await pasteLink(page, `${LINK_FIXTURE_ORIGIN}/private/`);
  await expect(page.getByTestId('import-error-title')).toHaveText('That site is private', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('import-error-hint')).toHaveText(
    'Make the site public in your builder and publish again, then paste the link.',
  );

  // A slow site: "Copying your site…", the controls wait, Cancel brings the zone back.
  await pasteLink(page, `${LINK_FIXTURE_ORIGIN}/slow/`);
  await expect(page.getByTestId('link-copying')).toHaveText(/Copying your site…/);
  await expect(page.getByTestId('link-input')).toBeDisabled();
  await expect(page.getByTestId('link-import')).toBeDisabled();
  await expect(page.getByTestId('choose-folder')).toBeDisabled();
  await page.getByTestId('link-cancel').click();
  await expect(page.getByTestId('link-copying')).toHaveCount(0);
  await expect(page.getByTestId('drop-zone')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('link-input')).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test('BUILD: import by link → autosaved → ship → results', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  watchCsp(page, pageErrors);
  fixture.serve(viteSite('Linked Pomodoro', 'rgb(0, 150, 136)'));

  const battle = await startBattle(page, 'E2E Linker');
  await waitForBuild(page);
  await expect(page.getByTestId('ship-button')).toBeDisabled();
  await pasteLink(page, LINK);
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Linked Pomodoro', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('import-summary')).toContainText(
    'Copied from host.docker.internal:4330 · 3 files',
  );
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  // The battle remembers the link: Import again offers it.
  await clickRouted(page.getByTestId('import-again'));
  await expect(page.getByTestId('import-again-link')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('ship-button').click();
  await page.getByTestId('build-name').fill('E2E Linked');
  await clickRouted(page.getByTestId('confirm-ship'));
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('E2E Linked');
  await expect(page.getByTestId('build-stats')).toHaveText(/^3 files · .* · imported once$/);
  const stats = JSON.parse(
    sql(`select stats::text from public.builds where battle_id = '${battle}'`),
  ) as Record<string, unknown>;
  expect(stats).toEqual({ files: 3, bundle_bytes: expect.any(Number) as unknown, imports: 1 });
  expect(pageErrors).toEqual([]);
});

test('screenshots: the link field, copying, an error, the copied site (EN, TR; light, dark, 390 px)', async ({
  browser,
}) => {
  test.skip(!SHOTS, 'LINK_SCREENSHOT_DIR is not set');
  test.setTimeout(240_000);
  const dir = SHOTS ?? '';
  for (const locale of ['en', 'tr'] as const) {
    for (const look of ['light', 'dark', 'mobile'] as const) {
      const context = await browser.newContext({
        viewport: look === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        colorScheme: look === 'dark' ? 'dark' : 'light',
        storageState: {
          cookies: [],
          origins: [
            {
              origin: test.info().project.use.baseURL ?? 'http://localhost:3100',
              localStorage: [
                { name: WELCOME_KEY, value: 'done' },
                { name: LOCALE_STORAGE_KEY, value: locale },
              ],
            },
          ],
        },
      });
      const page = await context.newPage();
      const shot = (name: string) =>
        page.screenshot({ path: `${dir}/${locale}-${look}-${name}.png`, fullPage: false });
      await openTry(page);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await page.getByTestId('link-input').scrollIntoViewIfNeeded();
      await shot('1-field');
      await pasteLink(page, `${LINK_FIXTURE_ORIGIN}/slow/`);
      await expect(page.getByTestId('link-copying')).toBeVisible();
      await shot('2-copying');
      await page.getByTestId('link-cancel').click();
      await pasteLink(page, `${LINK_FIXTURE_ORIGIN}/private/`);
      await expect(page.getByTestId('import-error')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('import-error').scrollIntoViewIfNeeded();
      await shot('3-error');
      fixture.serve(viteSite('Published on a host', 'rgb(255, 87, 34)'));
      await pasteLink(page, LINK);
      await expect(buildFrame(page).locator('h1.e2e-title')).toBeVisible({ timeout: 30_000 });
      await clickRouted(page.getByTestId('import-again'));
      await shot('4-copied');
      await page.getByTestId('import-again-paste').click();
      await expect(page.getByTestId('link-row')).toBeVisible();
      await shot('5-paste-row');
      await context.close();
    }
  }
});
