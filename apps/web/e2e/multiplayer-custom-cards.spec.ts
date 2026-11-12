import type { Page } from '@playwright/test';
import { expect, test } from './diagnostics';
import {
  createRoom,
  expectNoHorizontalScroll,
  joinByLink,
  newPhone,
  newPlayer,
  waitForBuild,
} from './rooms';
import { sql } from './stack';

/**
 * Custom cards (T-053), end to end (playwright.multi.config.ts): the host writes the room's
 * own BUILD card and a long STYLE card and picks a 30-minute limit in the lobby; the other
 * player sees which cards the host wrote but not their text; at the spin both reels land on
 * the host's cards, and the long one fits its reel, on a computer and on a phone.
 *
 * MULTI_SCREENSHOT_DIR=/some/dir also saves UI screenshots (t053-*.png).
 */

const SHOTS = process.env['MULTI_SCREENSHOT_DIR'];

/**
 * 80 characters, the longest card the server accepts (any deck card is at most 60), with long
 * words: on a 360px phone it wraps to more lines than the spinning reel's height.
 */
const LONG_STYLE =
  'Extraordinarily melodramatic weather announcements for houseplants in apartments';

async function snap(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t053-${name}.png` });
}

test('custom cards: the host writes a BUILD card and a 30-minute limit, the reels land on them', async ({
  browser,
}, info) => {
  const host = await newPlayer(browser, info, 'Ada Host');
  const bob = await newPlayer(browser, info, 'Bob Builder');
  const code = await createRoom(host);
  await joinByLink(bob, code);
  await expect(bob.page.getByTestId('lobby')).toBeVisible();
  // A phone player watches the spin (and cannot build: DNF).
  const cleo = await newPhone(browser, info, 'Cleo Phone');
  // A narrow Android phone rather than the iPhone's 390px: the long card needs its whole reel.
  await cleo.page.setViewportSize({ width: 360, height: 740 });
  await joinByLink(cleo, code);
  await expect(cleo.page.getByTestId('lobby')).toBeVisible();
  await expect(bob.page.getByTestId('custom-card-settings')).toHaveCount(0);

  // ─── The host's card, cleaned by the server ──────────────────────────────────────
  const build = host.page.getByTestId('setting-card-build');
  await expect(build).toHaveAttribute('placeholder', 'Random from the deck');
  await build.fill('  A pet rock   that judges you ');
  await build.press('Enter');
  await expect(build).toHaveValue('A pet rock that judges you');
  await host.page.getByTestId('setting-card-style').fill(LONG_STYLE);
  await host.page.getByTestId('setting-card-style').press('Enter');
  await host.page.getByTestId('setting-time-limit').selectOption('1800');

  // A card the filter blocks is refused; the draft stays for the host to fix.
  const rule = host.page.getByTestId('setting-card-rule');
  await rule.fill('A shit detector');
  await rule.press('Enter');
  await expect(host.page.getByTestId('action-error')).toContainText(
    'That card is not allowed here',
  );
  await expect(rule).toHaveValue('A shit detector');
  await rule.fill('');
  await rule.blur();
  await snap(host.page, 'host-lobby');

  // ─── Everyone else: which cards, never their text ────────────────────────────────
  await expect(bob.page.getByTestId('cards-summary')).toHaveText(
    'The host wrote the BUILD and STYLE cards: you see them at the spin. Build time: 30 min.',
  );
  await expect(bob.page.getByTestId('lobby')).not.toContainText('pet rock');
  await expect(bob.page.getByTestId('lobby')).not.toContainText('museum');
  await snap(bob.page, 'player-lobby');

  // ─── The spin lands on the host's card ───────────────────────────────────────────
  await bob.page.getByTestId('ready-toggle').click();
  await cleo.page.getByTestId('ready-toggle').click();
  await host.page.getByTestId('ready-toggle').click();
  await expect(host.page.getByTestId('start-battle')).toBeEnabled();
  await host.page.getByTestId('start-battle').click();
  for (const p of [host, bob, cleo]) {
    await expect(p.page.getByTestId('reel-build')).toHaveAttribute('data-landed', 'true', {
      timeout: 30_000,
    });
    await expect(p.page.getByTestId('reel-build')).toContainText('A pet rock that judges you');
    await expect(p.page.getByTestId('reel-style')).toHaveAttribute('data-landed', 'true');
    await expect(p.page.getByTestId('reel-style')).toContainText(LONG_STYLE);
    // The long card is not clipped: every line is inside the reel's value, and the reel's box
    // (overflow: hidden, for the landing animation) grows with it.
    for (const kind of ['build', 'rule', 'style']) {
      const reel = p.page.getByTestId(`reel-${kind}`);
      const value = reel.locator('.br-spin-card__value--landed');
      expect(await value.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await expect
        .poll(() => reel.locator('[aria-live]').evaluate((el) => el.scrollHeight - el.clientHeight))
        .toBeLessThanOrEqual(1);
    }
    await expect(p.page.getByTestId('reel-time')).toHaveAttribute('data-landed', 'true');
    await expect(p.page.getByTestId('reel-time')).toContainText('30');
  }
  await expectNoHorizontalScroll(cleo.page);
  await snap(bob.page, 'spin');
  await snap(cleo.page, 'spin-phone');
  await waitForBuild(bob.page);

  const battleId = sql(`select current_battle_id from public.rooms where code = '${code}'`);
  expect(
    sql(
      `select c.build_text || '|' || (c.build_card_id is null) || '|' || (c.rule_card_id is not null)
              || '|' || (c.style_text = '${LONG_STYLE}') || '|' || c.time_limit_seconds
         from public.battles b join public.challenges c on c.id = b.challenge_id
        where b.id = '${battleId}'`,
    ),
  ).toBe('A pet rock that judges you|true|true|true|1800');
});
