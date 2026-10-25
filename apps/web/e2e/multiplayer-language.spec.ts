import { expect, test } from './diagnostics';
import { createRoom, joinByLink, member, newPlayer, progress, waitForBuild } from './rooms';

/**
 * A room where players read different languages (T-050): the host picked Turkish, the guest
 * did not. Each sees the lobby, the toasts, the spin and BUILD in their own language; server
 * content (the cards, the names) is the same for both.
 *
 * `LANGUAGE_SCREENSHOT_DIR=/dir` saves the Turkish lobby (1280×800).
 */

const SHOTS = process.env['LANGUAGE_SCREENSHOT_DIR'];

test('a Turkish host and an English guest: lobby, toast, spin and BUILD each in their language', async ({
  browser,
}, info) => {
  const host = await newPlayer(browser, info, 'Hande');
  const guest = await newPlayer(browser, info, 'Gus');
  await host.context.addInitScript(() => {
    window.localStorage.setItem('br:locale', 'tr');
  });
  await host.page.setViewportSize({ width: 1280, height: 800 });

  const code = await createRoom(host);
  await expect(host.page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(host.page.getByTestId('player-count')).toHaveText('1/8 oyuncu');
  await expect(host.page.getByTestId('ready-toggle')).toHaveText('Hazırım');
  await expect(host.page.getByTestId('copy-invite')).toHaveText('Davet linkini kopyala');

  await joinByLink(guest, code);
  await expect(guest.page.getByTestId('lobby')).toBeVisible();
  await expect(guest.page.getByTestId('player-count')).toHaveText('2/8 players');
  await expect(guest.page.getByTestId('waiting-for-host')).toContainText('Waiting for Hande');
  // The host's toast and lobby, in Turkish.
  await expect(host.page.getByTestId('toast').filter({ hasText: 'Gus katıldı.' })).toBeVisible();
  await expect(member(host.page, 'Gus')).toContainText('Oyuncu');
  await expect(host.page.getByTestId('player-count')).toHaveText('2/8 oyuncu');

  await host.page.getByTestId('ready-toggle').click();
  await guest.page.getByTestId('ready-toggle').click();
  await expect(host.page.getByTestId('ready-toggle')).toHaveText('✓ Hazırsın!');
  await expect(host.page.getByTestId('ready-summary')).toContainText(
    'hazır ve çevrimiçi olan herkes oynar',
  );
  if (SHOTS) await host.page.screenshot({ path: `${SHOTS}/lobby.png` });

  await host.page.getByTestId('start-battle').click();
  await expect(host.page.getByTestId('spin')).toContainText(`Oda ${code} · herkesin görevi…`);
  await expect(guest.page.getByTestId('spin')).toContainText(
    `Room ${code} · everyone's challenge is…`,
  );

  await waitForBuild(host.page);
  await waitForBuild(guest.page);
  // The same cards (server content, English) for both; only the labels differ.
  const cardText = (page: typeof host.page) =>
    page.getByTestId('challenge').locator('li').first().locator('strong');
  await expect(cardText(host.page)).toHaveText((await cardText(guest.page).textContent()) ?? '');
  await expect(host.page.getByTestId('challenge')).toContainText('PROJE');
  await expect(host.page.getByTestId('progress-sidebar')).toContainText(
    'Oyuncular · 0/2 teslim etti',
  );
  await expect(guest.page.getByTestId('progress-sidebar')).toContainText('Players · 0/2 shipped');
  await expect(progress(host.page, 'Gus')).toBeVisible();
  await expect(host.page.getByTestId('leave-room')).toHaveText('Odadan çık');
  await expect(guest.page.getByTestId('leave-room')).toHaveText('Leave room');

  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});
