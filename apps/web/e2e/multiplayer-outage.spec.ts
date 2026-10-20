import { expect, test } from '@playwright/test';
import { buildFrame } from './helpers';
import {
  battleOf,
  createRoom,
  importApp,
  joinByLink,
  newPlayer,
  phaseOf,
  progress,
  ship,
  waitForBuild,
} from './rooms';
import { ephemeralObjects, sql } from './stack';

/**
 * Storage goes down for one player of a room during BUILD (playwright.multi.config.ts, the
 * real local stack with Realtime). Realtime is a different service: the room keeps seeing
 * the player's import (Presence) while the autosave retries; once Storage is back, the
 * retried autosave is what the deadline auto-ships. (Before M6 this suite took the package
 * CDN down before SPIN; imported sites need no package CDN.)
 */
test('Storage down for one player: the room still sees the import, and the retried autosave is auto-shipped', async ({
  browser,
}, info) => {
  const ann = await newPlayer(browser, info, 'Ann Online');
  const ben = await newPlayer(browser, info, 'Ben Offline');
  const code = await createRoom(ann);
  await joinByLink(ben, code);
  for (const p of [ann, ben]) {
    await p.page.getByTestId('ready-toggle').click();
    await expect(p.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(ann.page.getByTestId('start-battle')).toBeEnabled();
  await ann.page.getByTestId('start-battle').click();
  await expect.poll(() => battleOf(code)).toMatch(/^[0-9a-f-]{36}$/);
  const battleId = battleOf(code);
  for (const p of [ann, ben]) await waitForBuild(p.page);

  // Ben's Storage refuses every connection; Realtime (a WebSocket) is not affected.
  await ben.page.route('**/storage/v1/object/**', (route) => route.abort('connectionrefused'));
  await importApp(ben.page, 'Ben Offline Build', 'rgb(160, 20, 120)');
  await expect(buildFrame(ben.page).locator('main')).toHaveCSS(
    'background-color',
    'rgb(160, 20, 120)',
  );
  await expect(ben.page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'error');
  await expect(progress(ann.page, ben.name).getByTestId('activity')).toContainText('imported', {
    timeout: 30_000,
  });
  const benId = sql(
    `select p.user_id from public.battle_players p where p.battle_id = '${battleId}' and p.display_name = '${ben.name}'`,
  );
  expect(ephemeralObjects(battleId).filter((o) => o.includes(`/${benId}/`))).toEqual([]);

  // Storage is back: the retry lands.
  await ben.page.unroute('**/storage/v1/object/**');
  await expect(ben.page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 30_000,
  });
  expect(ephemeralObjects(battleId)).toContain(`${battleId}/${benId}/autosave/site.bin`);

  // Ann ships; the deadline passes for Ben: his autosave is auto-shipped.
  await importApp(ann.page, 'Ann Shipped', 'rgb(33, 150, 243)');
  await ship(ann.page, 'Ann Shipped');
  sql(`update public.battles
         set building_started_at = now() - interval '620 seconds',
             building_ends_at = now() - interval '20 seconds',
             phase_ends_at = now() - interval '20 seconds'
       where id = '${battleId}'`);
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).not.toBe('building');
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}' and phase = 'shipping'`,
  );
  await expect
    .poll(
      () =>
        sql(
          `select status from public.builds where battle_id = '${battleId}' and builder_id = '${benId}'`,
        ),
      { timeout: 30_000 },
    )
    .toBe('auto_shipped');
  expect([...ann.errors, ...ben.errors]).toEqual([]);
});
