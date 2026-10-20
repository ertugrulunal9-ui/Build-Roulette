import { expect, test } from '@playwright/test';
import { openTry } from './helpers';
import { importZip, sourceProject } from './sites';
import { FIRST_VISIT } from './welcome';

/**
 * The onboarding (T-049, docs/09 §9.6): the welcome screen on a first visit, the
 * `/how-it-works` guide, and the "How do I import?" help on `/try`. Every other suite starts
 * with the welcome already seen (e2e/welcome.ts); the welcome tests here start fresh.
 */

test.describe('a first visit', () => {
  test.use({ storageState: FIRST_VISIT });

  test('the home page shows the welcome; Next ×3, then "Let\'s play" closes it for good', async ({
    page,
  }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /Welcome to Build Roulette/ });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('welcome-step-title')).toContainText('Spin');
    await expect(page.getByTestId('welcome-next')).toBeFocused();
    for (const title of ['Build it your way', 'Build & drop', 'Ship, reveal, vote']) {
      await page.getByTestId('welcome-next').click();
      await expect(page.getByTestId('welcome-step-title')).toContainText(title);
    }
    await expect(page.getByTestId('welcome-step-count')).toHaveText('Step 4 of 4');
    await expect(page.getByTestId('welcome-practice')).toBeVisible();
    await expect(page.getByTestId('welcome-guide')).toHaveAttribute('href', '/how-it-works');
    await page.getByTestId('welcome-play').click();
    await expect(dialog).toBeHidden();
    // The page behind works: the home page's actions.
    await expect(page.getByTestId('play-solo')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('pitch')).toBeVisible();
    await expect(page.getByTestId('welcome')).toHaveCount(0);
    // "How it works" brings it back, from step 1; Esc closes it.
    await page.getByTestId('how-it-works').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('welcome-step-title')).toContainText('Spin');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('"Practice first" goes to /try, where the welcome never shows', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('welcome')).toBeVisible();
    await page.getByRole('button', { name: 'Go to step 4' }).click();
    await page.getByTestId('welcome-practice').click();
    await expect(page).toHaveURL(/\/try$/);
    await expect(page.getByTestId('drop-zone')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('welcome')).toHaveCount(0);
  });

  test('/play shows it before a battle; the guide and /try never do', async ({ page }) => {
    await page.goto('/how-it-works');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('welcome')).toHaveCount(0);
    await openTry(page);
    await expect(page.getByTestId('welcome')).toHaveCount(0);
    await page.goto('/play');
    await expect(page.getByTestId('welcome')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('welcome-skip').click();
    await expect(page.getByTestId('welcome')).toBeHidden();
    await expect(page.getByTestId('display-name')).toBeVisible();
  });
});

test('/how-it-works: every section, the tool tabs switch, the prompt line', async ({ page }) => {
  await page.goto('/how-it-works');
  await expect(page).toHaveTitle('How it works · Build Roulette');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /dist folder/);
  for (const [id, title] of [
    ['one-minute', 'The game in one minute'],
    ['rules', 'The rules for your site'],
    ['checklist', 'Before your first battle'],
    ['tools', 'Tool guides'],
    ['prompt', 'A line to add to your prompt'],
    ['build-folders', 'Where the build ends up'],
    ['troubleshooting', 'Troubleshooting'],
    ['faq', 'FAQ'],
  ] as const) {
    const section = page.getByTestId(`guide-${id}`);
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(title);
  }
  await expect(page.getByTestId('step-card')).toHaveCount(4);
  await expect(page.getByTestId('guide-rules')).toContainText('5 MB and 300 files');
  await expect(page.getByTestId('guide-build-folders')).toContainText('.output/public/');

  // The tabs: a click, then the arrow keys.
  const tabs = page.getByRole('tablist', { name: 'Kind of tool' });
  await expect(page.getByTestId('tool-panel-editor')).toBeVisible();
  await expect(page.getByTestId('tool-panel-web')).toBeHidden();
  await tabs.getByRole('tab', { name: 'Web builders' }).click();
  await expect(page.getByTestId('tool-panel-web')).toBeVisible();
  await expect(page.getByTestId('tool-panel-web')).toContainText('npm install');
  await expect(page.getByTestId('tool-panel-editor')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'No framework' })).toBeFocused();
  await expect(page.getByTestId('tool-panel-plain')).toBeVisible();
  await expect(page.getByTestId('tool-panel-plain')).toContainText('No build needed');

  // The prompt line: copied (the clipboard needs the permission in a test browser).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('copy-prompt-button').click();
  await expect(page.getByTestId('copy-prompt-button')).toHaveText('Copied!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'static site that runs entirely in the browser',
  );

  // FAQ answers open.
  await page.getByText('Can I play on a phone?').click();
  await expect(page.getByText('Building needs a computer.')).toBeVisible();
});

test('/try: "How do I import?" expands, links to the guide; an error links to it', async ({
  page,
}) => {
  await openTry(page);
  await expect(page.getByTestId('how-it-works')).toHaveAttribute('href', '/how-it-works');
  const help = page.getByTestId('import-help');
  await expect(help).toBeVisible();
  await expect(page.getByTestId('import-help-where')).toBeHidden(); // closed by default
  await help.getByText('How do I import?').click();
  await expect(page.getByTestId('import-help-where')).toBeVisible();
  await expect(page.getByTestId('import-help-where')).toContainText('Vite');
  const guide = page.getByTestId('import-help-guide');
  await expect(guide).toHaveAttribute('href', '/how-it-works');
  await expect(guide).toHaveAttribute('target', '_blank');
  const [tab] = await Promise.all([page.context().waitForEvent('page'), guide.click()]);
  await expect(tab).toHaveURL(/\/how-it-works$/);
  await expect(tab.getByRole('heading', { level: 1 })).toHaveText('How Build Roulette works');
  await tab.close();

  // A refused import: "How do I fix this?" opens the help again.
  await help.getByText('How do I import?').click();
  await expect(page.getByTestId('import-help-where')).toBeHidden();
  await importZip(page, sourceProject());
  await expect(page.getByTestId('import-error-title')).toHaveText(
    'This is source code, not the built site',
  );
  await page.getByTestId('import-error-fix').click();
  await expect(page.getByTestId('import-help-where')).toBeVisible();
  await expect(help.locator('summary')).toBeFocused();
});
