import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  battleOf,
  createRoom,
  expectNoHorizontalScroll,
  joinByLink,
  member,
  newPhone,
  newPlayer,
  phaseOf,
  revealLive,
  ship,
  vote,
  waitForBuild,
  writeApp,
  type Player,
} from './rooms';
import { ephemeralObjects, sql } from './stack';

/**
 * Phones in a room (playwright.multi.config.ts; docs/06 M4: "mobile works for reveal and
 * vote"): Playwright's iPhone 13 profile (390×664, touch) in Chromium, next to desktop
 * players, against the real local stack with Realtime and the capture worker.
 *
 * - The room's host is on a phone: creates the room, changes the reveal/vote settings,
 *   readies up and starts; during BUILD sees the "building needs a desktop browser" notice
 *   with the battle state (nothing autosaves there, so the build ends DNF); a second phone
 *   joins mid-BUILD and spectates.
 * - REVEAL on the phones: each build is a screenshot or thumbnail first, runs live only after
 *   "Tap to run live"; the host's Next sits in a bar fixed to the bottom. Desktops run the
 *   build at once.
 * - VOTE on the phone: one build per row, taps; rapid taps on two builds in one category
 *   end with the last one (the latest-click-wins queue, with cast_vote slowed down so the
 *   taps overlap the requests).
 * - RESULTS on the phones, then the player history page /u/[id] (phone and desktop).
 * - No page scrolls sideways at 390 px, anywhere.
 *
 * MULTI_SCREENSHOT_DIR=/some/dir saves t021-{lobby-settings,mobile-reveal,mobile-vote,
 * mobile-results,history}.png.
 */

const SHOTS = process.env['MULTI_SCREENSHOT_DIR'];

/**
 * Phones get viewport screenshots only: a full-page screenshot of a page taller than the
 * viewport makes Playwright's Chromium drop the touch emulation for good (measured:
 * `(hover: none) and (pointer: coarse)` stays false afterwards), which would turn the phone
 * into a desktop for the rest of the test.
 */
async function snap(page: Page, name: string, fullPage = false): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t021-${name}.png`, fullPage });
}

const option = (page: Page, category: string, buildId: string): Locator =>
  page.locator(
    `[data-testid=vote-category][data-category=${category}] [data-testid=vote-option][data-build="${buildId}"]`,
  );

/** Taps a vote card on a phone and waits until the server confirmed it. */
async function tapVote(page: Page, category: string, buildId: string): Promise<void> {
  await option(page, category, buildId).tap();
  await expect(option(page, category, buildId)).toHaveAttribute('data-selected', 'true');
}

test('phones in a room: join, host from a phone, watch the reveal (still first, tap to run), vote with taps, results, history', async ({
  browser,
}, info) => {
  test.setTimeout(8 * 60_000);
  const pia = await newPhone(browser, info, 'Pia Phone');
  const ada = await newPlayer(browser, info, 'Ada Desk');
  const bob = await newPlayer(browser, info, 'Bob Desk');
  const sam = await newPhone(browser, info, 'Sam Phone');
  const players = [pia, ada, bob];

  // ─── Pia creates the room on her phone; the desktops join ─────────────────────────
  const code = await createRoom(pia);
  for (const p of [ada, bob]) {
    await joinByLink(p, code);
    await expect(p.page.getByTestId('lobby')).toBeVisible();
  }
  for (const p of players) {
    await expect(p.page.locator('[data-testid=member][data-online=true]')).toHaveCount(3);
  }
  await expect(member(pia.page, pia.name)).toHaveAttribute('data-host', 'true');
  // Phones are told what they can do before they ready up; desktops are not.
  await expect(pia.page.getByTestId('phone-lobby-note')).toContainText('Building needs');
  await expect(ada.page.getByTestId('phone-lobby-note')).toHaveCount(0);
  await expectNoHorizontalScroll(pia.page);

  // ─── The host's reveal/vote settings, from the phone ──────────────────────────────
  await expect(ada.page.getByTestId('reveal-vote-settings')).toHaveCount(0);
  await expect(ada.page.getByTestId('settings-summary')).toContainText('60 s to vote');
  await pia.page.getByTestId('setting-reveal-slot').selectOption('30');
  await expect(ada.page.getByTestId('settings-summary')).toContainText('30 s per build');
  await pia.page.getByTestId('setting-voting').selectOption('90');
  await expect(ada.page.getByTestId('settings-summary')).toContainText('90 s to vote');
  await pia.page.getByTestId('setting-reveal-vote').tap();
  await expect(ada.page.getByTestId('settings-summary')).toContainText('off');
  await expect(pia.page.getByTestId('setting-voting')).toBeDisabled();
  await pia.page.getByTestId('setting-reveal-vote').tap();
  await expect(ada.page.getByTestId('settings-summary')).toContainText('Reveal and vote on');
  expect(
    JSON.parse(sql(`select settings::text from public.rooms where code = '${code}'`)),
  ).toMatchObject({ reveal_slot_s: 30, voting_s: 90, reveal_vote: true });
  await pia.page.getByTestId('reveal-vote-settings').scrollIntoViewIfNeeded();
  await snap(pia.page, 'lobby-settings');

  // ─── Ready (a tap on the phone) and start ─────────────────────────────────────────
  await pia.page.getByTestId('ready-toggle').tap();
  for (const p of [ada, bob]) await p.page.getByTestId('ready-toggle').click();
  await expect(pia.page.getByTestId('start-battle')).toBeEnabled();
  await pia.page.getByTestId('start-battle').tap();
  await expect.poll(() => battleOf(code), { intervals: [50] }).toMatch(/^[0-9a-f-]{36}$/);
  const battleId = battleOf(code);
  expect(
    JSON.parse(sql(`select settings::text from public.battles where id = '${battleId}'`)),
  ).toMatchObject({ reveal_slot_s: 30, voting_s: 90, reveal_vote: true });

  // ─── BUILD: the phone player watches, with her battle state ───────────────────────
  for (const p of [ada, bob]) await waitForBuild(p.page);
  const notice = pia.page.getByTestId('desktop-needed');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute('data-build-status', 'draft');
  await expect(pia.page.getByTestId('phone-battle-state')).toContainText('DNF');
  await expect(pia.page.getByTestId('spectator-stage')).toHaveAttribute('data-role', 'player');
  await expect(pia.page.getByTestId('progress-player')).toHaveCount(3);
  await expect(pia.page.getByTestId('build-stage')).toHaveCount(0);
  await expectNoHorizontalScroll(pia.page);

  // A second phone joins mid-BUILD: a spectator, with everyone's progress.
  await joinByLink(sam, code);
  await expect(sam.page.getByTestId('spectator-stage')).toBeVisible({ timeout: 30_000 });
  await expect(sam.page.getByTestId('spectator-stage')).toHaveAttribute('data-role', 'spectator');
  await expect(sam.page.getByTestId('desktop-needed')).toHaveCount(0);
  await expectNoHorizontalScroll(sam.page);

  // The desktops build and ship; the deadline passes for Pia (nothing to auto-ship).
  await writeApp(ada.page, 'Ada Rocket', 'rgb(220, 38, 38)');
  await ship(ada.page, 'Ada Rocket');
  await writeApp(bob.page, 'Bob Turtle', 'rgb(30, 64, 175)');
  await ship(bob.page, 'Bob Turtle');
  await expect(pia.page.locator('[data-testid=progress-player][data-state=shipped]')).toHaveCount(
    2,
  );
  sql(`update public.builds set shipped_at = shipped_at - interval '60 seconds'
         where battle_id = '${battleId}' and status = 'shipped';
       update public.battles
         set building_started_at = now() - interval '320 seconds',
             building_ends_at = now() - interval '20 seconds',
             phase_ends_at = now() - interval '20 seconds'
       where id = '${battleId}'`);
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).not.toBe('building');
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}' and phase = 'shipping'`,
  );
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).toBe('reveal');
  const ids = Object.fromEntries(
    sql(
      `select string_agg(p.display_name || '=' || b.builder_id || '=' || b.id || '=' || b.status, ',') from public.builds b join public.battle_players p on p.battle_id = b.battle_id and p.user_id = b.builder_id where b.battle_id = '${battleId}'`,
    )
      .split(',')
      .map((t) => t.split('='))
      .map(([name, uid, build, status]) => [name ?? '', { uid, build, status }]),
  ) as Record<string, { uid: string; build: string; status: string }>;
  const buildOf = (p: Player) => ids[p.name]?.build ?? 'missing';
  const userOf = (p: Player) => ids[p.name]?.uid ?? 'missing';
  // The phone never built or autosaved: the server had nothing to ship for her.
  expect(ids[pia.name]?.status).toBe('dnf');
  expect(ephemeralObjects(battleId).filter((o) => o.includes(`/${userOf(pia)}/`))).toEqual([]);

  // ─── REVEAL: phones see the still first and run it on a tap ───────────────────────
  const order = sql(
    `select array_to_string(reveal_order, ',') from public.battles where id = '${battleId}'`,
  ).split(',');
  expect([...order].sort()).toEqual([buildOf(ada), buildOf(bob)].sort());
  const titleOf: Record<string, string> = {
    [buildOf(ada)]: 'Ada Rocket',
    [buildOf(bob)]: 'Bob Turtle',
  };
  for (const p of [pia, sam, ada, bob]) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', '0', {
      timeout: 30_000,
    });
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-build', order[0] ?? '');
  }
  for (const phone of [pia, sam]) {
    await expect(phone.page.getByTestId('reveal-stage')).toHaveAttribute('data-view', 'still');
    await expect(phone.page.getByTestId('tap-to-run')).toBeVisible();
    // The hand-shipped build's thumbnail (or its screenshot, once captured).
    await expect(
      phone.page.getByTestId('reveal-still').getByTestId('fallback-thumb'),
    ).toBeVisible();
    await expect(phone.page.locator('iframe[data-testid=reveal-live-frame]')).toHaveCount(0);
    await expectNoHorizontalScroll(phone.page);
  }
  // Desktops run it at once.
  await expect(ada.page.getByTestId('reveal-stage')).toHaveAttribute('data-view', 'live');
  await expect(revealLive(ada.page).locator('h1.e2e-title')).toHaveText(
    titleOf[order[0] ?? ''] ?? '',
  );
  // The phone host's controls are in reach (a bar fixed to the bottom of the screen).
  const bar = pia.page.getByTestId('reveal-host-controls');
  await expect(bar).toBeInViewport();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await snap(pia.page, 'mobile-reveal');
  // A tap runs it live, in the labelled reveal-mode frame.
  await pia.page.getByTestId('tap-to-run').tap();
  await expect(pia.page.getByTestId('reveal-stage')).toHaveAttribute('data-view', 'live');
  await expect(revealLive(pia.page).locator('h1.e2e-title')).toHaveText(
    titleOf[order[0] ?? ''] ?? '',
    { timeout: 30_000 },
  );
  await expect(pia.page.getByTestId('skip-build')).toBeVisible();
  // Sam did not tap: still the still.
  await expect(sam.page.getByTestId('reveal-stage')).toHaveAttribute('data-view', 'still');

  // The host moves on from her phone; the next build starts as a still again.
  await pia.page.getByTestId('reveal-next').tap();
  for (const p of [pia, sam, ada, bob]) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', '1');
  }
  await expect(pia.page.getByTestId('reveal-stage')).toHaveAttribute('data-view', 'still');
  await expect(pia.page.locator('iframe[data-testid=reveal-live-frame]')).toHaveCount(0);
  await sam.page.getByTestId('tap-to-run').tap();
  await expect(revealLive(sam.page).locator('h1.e2e-title')).toHaveText(
    titleOf[order[1] ?? ''] ?? '',
    { timeout: 30_000 },
  );
  await expect(pia.page.getByTestId('reveal-next')).toHaveText(/start the vote/);
  await pia.page.getByTestId('reveal-next').tap();

  // ─── VOTE on the phone: rows, taps, the latest tap wins ───────────────────────────
  for (const p of [pia, sam, ada, bob]) {
    await expect(p.page.getByTestId('vote-stage')).toBeVisible({ timeout: 30_000 });
  }
  await expect(pia.page.getByTestId('vote-stage')).toHaveAttribute('data-can-vote', 'true');
  await expect(sam.page.getByTestId('vote-stage')).toHaveAttribute('data-can-vote', 'false');
  const A = buildOf(ada);
  const B = buildOf(bob);
  // One build per row: the cards are as wide as the list (big tap targets).
  const card = await option(pia.page, 'overall', A).boundingBox();
  expect(card?.width ?? 0).toBeGreaterThan(300);
  expect(card?.height ?? 0).toBeGreaterThanOrEqual(64);
  await expectNoHorizontalScroll(pia.page);

  // Rapid taps, alternating builds, while every cast_vote takes 800 ms: each tap lands
  // while a request is in flight, so the queue decides. The last tap must win.
  let casts = 0;
  await pia.page.route('**/rest/v1/rpc/cast_vote', async (route) => {
    casts++;
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  for (const id of [A, B, A, B, A, B]) await option(pia.page, 'overall', id).tap();
  await expect(option(pia.page, 'overall', B)).toHaveAttribute('data-selected', 'true', {
    timeout: 10_000,
  });
  await expect(option(pia.page, 'overall', A)).toHaveAttribute('data-selected', 'false');
  await expect(
    pia.page.locator('[data-testid=vote-category][data-category=overall]'),
  ).toHaveAttribute('data-state', 'picked');
  expect(
    sql(
      `select build_id from public.votes where battle_id = '${battleId}' and voter_id = '${userOf(pia)}' and category = 'overall'`,
    ),
  ).toBe(B);
  // Fewer requests than taps: the clicks in between were folded into the queue.
  expect(casts).toBeLessThan(6);
  await pia.page.unroute('**/rest/v1/rpc/cast_vote');
  await tapVote(pia.page, 'rule', A);
  await tapVote(pia.page, 'style', B);
  await snap(pia.page, 'mobile-vote');
  await tapVote(pia.page, 'chaos', A);
  await expect(pia.page.getByTestId('ballot-complete')).toBeVisible();

  for (const cat of ['overall', 'rule', 'style', 'chaos']) await vote(ada.page, cat, B);
  for (const cat of ['overall', 'rule', 'style']) await vote(bob.page, cat, A);
  // The last pick completes the last ballot: VOTING ends at once, so the page may already
  // show RESULTS when the confirmation would.
  await option(bob.page, 'chaos', A).click();

  // ─── RESULTS on the phones (voting ended early: everyone present voted) ───────────
  for (const p of [pia, sam, ada, bob]) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  }
  expect(
    sql(
      `select payload ->> 'reason' from public.battle_events where battle_id = '${battleId}' and type = 'phase' and payload ->> 'from' = 'voting'`,
    ),
  ).toBe('all_voted');
  // Bob: overall from Ada and Pia (2) beats Ada's 1.
  await expect(
    pia.page.locator(`[data-testid=ranked-build][data-builder="${userOf(bob)}"]`),
  ).toHaveAttribute('data-rank', '1');
  await expect(
    pia.page.locator(`[data-testid=ranked-build][data-builder="${userOf(pia)}"]`),
  ).toHaveAttribute('data-status', 'dnf');
  for (const phone of [pia, sam]) await expectNoHorizontalScroll(phone.page);
  // Nothing to run for a DNF: no last-look pane taking the phone's screen, just a line.
  await expect(pia.page.getByTestId('no-last-look')).toContainText('did not ship');
  await expect(pia.page.locator('[data-testid=reveal-frame]')).toHaveCount(0);
  await pia.page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await snap(pia.page, 'mobile-results');

  // A name opens that player's history in a new tab (the room keeps running).
  const [history] = await Promise.all([
    pia.context.waitForEvent('page'),
    pia.page
      .locator(`[data-testid=ranked-build][data-builder="${userOf(bob)}"]`)
      .getByTestId('player-history-link')
      .tap(),
  ]);
  await expect(history.getByTestId('player-name')).toHaveText(bob.name, { timeout: 30_000 });
  const entry = history.locator(`[data-testid=history-battle][data-battle="${battleId}"]`);
  await expect(entry).toHaveAttribute('data-rank', '1');
  await expect(entry.getByTestId('history-rank')).toContainText('#1 of 3');
  await expect(entry.getByTestId('history-build-name')).toHaveText('Bob Turtle');
  await expectNoHorizontalScroll(history);
  await history.close();
  await expect(pia.page.getByTestId('results')).toBeVisible();

  // ─── DESTROY → lobby; the history stays (desktop) ─────────────────────────────────
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
  for (const p of [pia, sam, ada, bob]) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
  }
  await expectNoHorizontalScroll(pia.page);
  await expectNoHorizontalScroll(sam.page);
  await ada.page.goto(`/u/${userOf(ada)}`);
  await expect(ada.page.getByTestId('player-name')).toHaveText(ada.name);
  const mine = ada.page.locator(`[data-testid=history-battle][data-battle="${battleId}"]`);
  await expect(mine.getByTestId('history-rank')).toContainText('#2 of 3');
  await expect(mine.getByTestId('history-challenge')).toHaveText(
    sql(
      `select c.build_text from public.battles b join public.challenges c on c.id = b.challenge_id where b.id = '${battleId}'`,
    ),
  );
  await expect(mine.getByTestId('award')).not.toHaveCount(0);
  await expect(mine.getByTestId('history-screenshot')).toBeVisible();
  await snap(ada.page, 'history', true);
  await mine.getByTestId('history-battle-link').click();
  await expect(ada.page).toHaveURL(new RegExp(`/battles/${battleId}$`));
  await expect(ada.page.getByTestId('my-history-link')).toHaveAttribute(
    'href',
    `/u/${userOf(ada)}`,
  );
  // The DNF player's history lists the battle too, without a rank.
  await pia.page.goto(`/u/${userOf(pia)}`);
  await expect(
    pia.page.locator(`[data-testid=history-battle][data-battle="${battleId}"]`),
  ).toHaveAttribute('data-status', 'dnf');
  await expectNoHorizontalScroll(pia.page);
  // An unknown player: the not-found page.
  await pia.page.goto('/u/00000000-0000-4000-8000-000000000000');
  await expect(pia.page.getByTestId('player-not-found')).toBeVisible();

  for (const p of [pia, sam, ada, bob]) expect(p.errors, `${p.name}: page errors`).toEqual([]);
  for (const p of [pia, sam, ada, bob]) await p.context.close();
});
