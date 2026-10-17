import { expect, test, type Page } from '@playwright/test';
import { watchCsp } from './csp';
import { openTry } from './helpers';
import { dropFiles, sourceProject, zipFiles } from './sites';
import { FIRST_VISIT } from './welcome';

/**
 * English / Turkish (T-050, docs/09 §9.7): English by default whatever the browser's language,
 * the "EN / TR" switch on the page, Turkish kept after a reload (with `<html lang="tr">`, no
 * English flash, no hydration error, no CSP violation from the early script), and back.
 *
 * `LANGUAGE_SCREENSHOT_DIR=/dir` saves Turkish screenshots (1280×800, and the home page at
 * 390×844).
 */

const SHOTS = process.env['LANGUAGE_SCREENSHOT_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Page errors, console errors (hydration mismatches are console errors) and CSP violations. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  watchCsp(page, errors);
  return errors;
}

test.use({ locale: 'tr-TR', viewport: { width: 1280, height: 800 } });

test('English by default on a Turkish browser; TR switches the home page, welcome and guide; a reload keeps it; EN switches back', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('pitch')).toContainText('A party game for vibe coders');
  const picker = page.getByRole('group', { name: 'Language' });
  await expect(picker.getByRole('button', { name: /English/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Switch: the page changes in place (no navigation), and <html lang> follows.
  await picker.getByRole('button', { name: /Türkçe/ }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByTestId('pitch')).toContainText('Vibe coder’lar için bir parti oyunu');
  await expect(page.getByTestId('play-solo')).toHaveText('Solo oyna');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Bir kapışma nasıl geçer' }),
  ).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Dil' }).getByRole('button', { name: /Türkçe/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.localStorage.getItem('br:locale'))).toBe('tr');
  await shot(page, 'home');

  // The welcome (from "How it works"), in Turkish.
  await page.getByTestId('how-it-works').click();
  const dialog = page.getByRole('dialog', { name: /Build Roulette’e hoş geldin/ });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('welcome-step-title')).toContainText('Çevir');
  await expect(page.getByTestId('welcome-step-count')).toHaveText('Adım 1 / 4');
  await page.getByRole('button', { name: '3. adıma git' }).click();
  await expect(page.getByTestId('welcome-step-title')).toContainText('Build al ve bırak');
  await shot(page, 'welcome-step-3');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A reload keeps Turkish: the first paint is already Turkish (the early script hides the
  // English prerender until React shows Turkish).
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.locator('html')).toHaveAttribute('data-locale-ready', '');
  await expect(page.getByTestId('pitch')).toContainText('Vibe coder’lar için');

  // The guide.
  await page.getByTestId('home-guide').click();
  await expect(page).toHaveURL(/\/how-it-works$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build Roulette nasıl oynanır');
  await expect(page).toHaveTitle('Nasıl oynanır · Build Roulette');
  await expect(page.getByTestId('guide-faq')).toContainText('Telefondan oynayabilir miyim?');
  await page.getByRole('tab', { name: 'Terminal ajanları' }).click();
  await expect(page.getByTestId('tool-panel-terminal')).toContainText('Boş bir klasör oluştur');
  await page.getByTestId('guide-tools').scrollIntoViewIfNeeded();
  await shot(page, 'guide-tool-tabs');
  // A fresh load of the guide itself (a static page) is Turkish too.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build Roulette nasıl oynanır');

  // Back to English, remembered too.
  await page
    .getByRole('group', { name: 'Dil' })
    .getByRole('button', { name: /English/ })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How Build Roulette works');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('How it works · Build Roulette');
  await page.goto('/');
  await expect(page.getByTestId('pitch')).toContainText('A party game for vibe coders');
  expect(errors).toEqual([]);
});

test.describe('a first visit in Turkish', () => {
  test.use({ storageState: FIRST_VISIT });

  test('the welcome that opens by itself has the switch', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /Welcome to Build Roulette/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Türkçe/ }).click();
    await expect(page.getByRole('dialog', { name: /hoş geldin/ })).toBeVisible();
    await expect(page.getByTestId('welcome-step-title')).toContainText('Çevir');
    await expect(page.getByTestId('welcome-next')).toContainText('İleri');
    expect(errors).toEqual([]);
  });
});

test('/try: the import error, the drop zone and its help in Turkish', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('br:locale', 'tr');
  });
  await openTry(page);
  await expect(page).toHaveTitle('İçe aktarmayı dene · Build Roulette');
  await expect(page.getByTestId('drop-title')).toHaveText('Build’i alınmış siteni buraya bırak');
  await expect(page.getByTestId('choose-folder')).toContainText('Klasör seç');
  await dropFiles(page, [
    {
      name: 'my-app.zip',
      mimeType: 'application/zip',
      buffer: zipFiles(sourceProject(), 'my-app/'),
    },
  ]);
  await expect(page.getByTestId('import-error-title')).toHaveText(
    'Bu kaynak kod, build’i alınmış site değil',
  );
  await expect(page.getByTestId('import-error-hint').locator('code').first()).toHaveText(
    'npm run build',
  );
  await page.getByTestId('import-error-fix').click();
  await expect(page.getByTestId('import-help')).toHaveAttribute('open', '');
  await expect(page.getByTestId('import-help')).toContainText('Build’im nerede?');
  await shot(page, 'try-import-error');
  // Switching back re-words the error in place.
  await page
    .getByRole('group', { name: 'Dil' })
    .getByRole('button', { name: /English/ })
    .click();
  await expect(page.getByTestId('import-error-title')).toHaveText(
    'This is source code, not the built site',
  );
  expect(errors).toEqual([]);
});

test('a phone: Turkish (longer words) at 390 px, no sideways scroll on home, the guide, /try and /play', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.localStorage.setItem('br:locale', 'tr');
  });
  const noSidewaysScroll = async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };
  await page.goto('/');
  await expect(page.getByTestId('pitch')).toContainText('Vibe coder’lar için');
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('create-room-form')).toContainText('Adın');
  await noSidewaysScroll();
  await shot(page, 'home-390');
  await page.goto('/how-it-works');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build Roulette nasıl oynanır');
  await noSidewaysScroll();
  await page.goto('/try');
  await expect(page.getByTestId('drop-title')).toHaveText('Build’i alınmış siteni buraya bırak', {
    timeout: 20_000,
  });
  await noSidewaysScroll();
  await page.goto('/play');
  await expect(page.getByRole('button', { name: 'Çevir', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await noSidewaysScroll();
});

test('the 404 page and an unknown battle, in Turkish', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('br:locale', 'tr');
  });
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bu sayfa bulunamadı.');
  await expect(page).toHaveTitle('Sayfa bulunamadı · Build Roulette');
  await expect(page.getByRole('group', { name: 'Dil' })).toBeVisible();
});
