import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';

/**
 * Clicks `target` once the browser really routes pointer input at its centre to it.
 *
 * Chromium decides which frame gets a mouse event from the compositor's hit-test data, not
 * from the DOM. Right after a modal dialog opens over the cross-site preview iframe, that
 * data can still show the iframe at the dialog's place (measured under CPU load: 16 of 25
 * first clicks on a freshly opened dialog went to the iframe; one second later, all reached
 * the dialog). A person cannot click a button before it is drawn, but Playwright clicks as
 * soon as the DOM is stable. So this helper hovers the target until the element itself
 * receives the pointer move (proof that routing is up to date), then clicks.
 */
export async function clickRouted(target: Locator): Promise<void> {
  const page = target.page();
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((el) => {
    const e = el as HTMLElement & { __routed?: boolean };
    e.__routed = false;
    el.addEventListener(
      'pointermove',
      () => {
        e.__routed = true;
      },
      { once: true },
    );
  });
  let nudge = 0;
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        if (!box) return false;
        // A slightly different point each time, so every poll is a real pointer move.
        nudge = (nudge + 1) % 3;
        await page.mouse.move(box.x + box.width / 2 + nudge - 1, box.y + box.height / 2);
        return target.evaluate((el) => (el as HTMLElement & { __routed?: boolean }).__routed);
      },
      { message: 'pointer input never reached the element', intervals: [50, 100, 200] },
    )
    .toBe(true);
  await target.click();
}

/** The imported site's own document: preview iframe (the shell) → the site's frame. */
export function buildFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid=preview-frame]').frameLocator('iframe');
}

/** Opens `/try` and waits for its drop zone. Collects page errors. */
export async function openTry(page: Page): Promise<{ pageErrors: string[] }> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/try');
  await expect(page.getByTestId('drop-zone')).toBeVisible({ timeout: 20_000 });
  return { pageErrors };
}

/** Name entry → Spin. Returns the battle id (from `?battle=`). */
export async function startBattle(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('play-solo').click();
  await expect(page).toHaveURL(/\/play$/);
  const input = page.getByTestId('display-name');
  await expect(input).not.toHaveValue(''); // a random fun default
  await input.fill(name);
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  await expect(page.getByTestId('spin')).toBeVisible();
  await expect(page).toHaveURL(/[?&]battle=[0-9a-f-]{36}/);
  return new URL(page.url()).searchParams.get('battle') ?? '';
}

/** Waits until SPIN is over and BUILD shows its drop zone (nothing imported yet). */
export async function waitForBuild(page: Page): Promise<void> {
  await expect(page.getByTestId('spin')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('countdown')).toHaveAttribute('data-level', /normal|low/);
  await expect(page.getByTestId('drop-zone')).toHaveAttribute('data-state', 'idle');
}

/**
 * The static social card (public/og-card.png) as an absolute `og:image` URL: the shells' own
 * default, and a battle's preview when rank 1 has no screenshot or was taken down (T-038).
 */
export const STATIC_CARD = /^https?:\/\/[^/]+\/og-card\.png$/;
