import type { Page } from '@playwright/test';
import { expect, test } from './diagnostics';
import { buildFrame, clickRouted } from './helpers';
import { crawl, one } from './link-preview';
import {
  FREEZE_BUTTON,
  battleOf,
  joinByLink,
  member,
  newPlayer,
  phaseOf,
  progress,
  revealLive,
  setVisibility,
  ship,
  storedFile,
  vote,
  waitForBuild,
  writeApp,
  type Player,
} from './rooms';
import { sql } from './stack';

/**
 * Rooms end to end (playwright.multi.config.ts): several browser contexts, each one an
 * anonymous player, against the real local Supabase stack with Realtime and the capture
 * worker. Deadlines are forced with psql as the superuser, like the solo e2e.
 *
 * MULTI_SCREENSHOT_DIR=/some/dir also saves UI screenshots (t020-*.png).
 */

const SHOTS = process.env['MULTI_SCREENSHOT_DIR'];

async function snap(page: Page, name: string, fullPage = false): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t020-${name}.png`, fullPage });
}

test('a 3-player room: lobby → battle → ship and auto-ship → reveal → vote → results by votes → destroy → rematch', async ({
  browser,
}, info) => {
  const host = await newPlayer(browser, info, 'Ada Host');
  const bob = await newPlayer(browser, info, 'Bob Builder');
  const cleo = await newPlayer(browser, info, 'Cleo Late');
  const dave = await newPlayer(browser, info, 'Dave Watcher');
  await host.context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // ─── Create (landing) and join (invite link, and a lower-case code) ───────────────
  await host.page.goto('/');
  await host.page.getByTestId('create-room').click();
  await expect(host.page.getByTestId('host-name')).not.toHaveValue('');
  await host.page.getByTestId('host-name').fill(host.name);
  await host.page.getByTestId('create-room-submit').click();
  await expect(host.page).toHaveURL(/\/r\/[A-HJ-NP-Z2-9]{5}$/);
  const code = new URL(host.page.url()).pathname.split('/').pop() ?? '';
  await expect(host.page.getByTestId('lobby')).toBeVisible();
  await expect(host.page.getByTestId('room-code')).toHaveText(code);
  await host.page.getByTestId('copy-invite').click();
  await expect(host.page.getByTestId('copy-invite')).toHaveText('Copied!');
  expect(await host.page.evaluate(() => navigator.clipboard.readText())).toMatch(
    new RegExp(`/r/${code}$`),
  );

  await joinByLink(bob, code);
  // Cleo types the code on the landing page, lower-case and with spaces.
  await cleo.page.goto('/');
  await cleo.page.getByTestId('join-with-code').click();
  await cleo.page.getByTestId('room-code-input').fill(`  ${code.toLowerCase()} `);
  await cleo.page.getByTestId('join-room-submit').click();
  await expect(cleo.page).toHaveURL(new RegExp(`/r/${code}$`));
  await cleo.page.getByTestId('display-name').fill(cleo.name);
  await cleo.page.getByTestId('join-room').click();

  // Everyone sees everyone online (Presence), the host's crown, "3/8 players".
  for (const p of [host, bob, cleo]) {
    await expect(p.page.locator('[data-testid=member][data-online=true]')).toHaveCount(3);
    await expect(p.page.getByTestId('player-count')).toHaveText('3/8 players');
    await expect(member(p.page, host.name)).toHaveAttribute('data-host', 'true');
  }
  await expect(bob.page.getByTestId('waiting-for-host')).toContainText(host.name);
  await expect(bob.page.getByTestId('start-battle')).toHaveCount(0);
  await expect(host.page.getByTestId('start-battle')).toBeDisabled();

  // ─── Ready up, start ──────────────────────────────────────────────────────────────
  for (const p of [host, bob, cleo]) {
    await p.page.getByTestId('ready-toggle').click();
    await expect(p.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  }
  for (const p of [host, bob, cleo]) {
    await expect(p.page.locator('[data-testid=member][data-ready=true]')).toHaveCount(3);
  }
  await expect(host.page.getByTestId('start-battle')).toBeEnabled();
  await snap(host.page, 'lobby');
  await host.page.getByTestId('start-battle').click();

  // Everyone sees the spin, then the same challenge.
  await expect(host.page.getByTestId('spin')).toBeVisible();
  await expect.poll(() => battleOf(code)).toMatch(/^[0-9a-f-]{36}$/);
  const battleId = battleOf(code);
  const card = sql(
    `select c.build_text from public.battles b join public.challenges c on c.id = b.challenge_id where b.id = '${battleId}'`,
  );
  const limitS = Number(
    sql(
      `select c.time_limit_seconds from public.battles b join public.challenges c on c.id = b.challenge_id where b.id = '${battleId}'`,
    ),
  );
  expect([300, 600, 900]).toContain(limitS);
  for (const p of [host, bob, cleo]) {
    await waitForBuild(p.page);
    await expect(p.page.getByTestId('challenge')).toContainText(card);
    await expect(progress(p.page, host.name)).toHaveAttribute('data-state', 'building');
  }

  // ─── A late joiner is a spectator: challenge, countdown, progress, no editor ──────
  await joinByLink(dave, code);
  await expect(dave.page.getByTestId('spectator-stage')).toBeVisible();
  await expect(dave.page.getByTestId('challenge')).toContainText(card);
  await expect(dave.page.getByTestId('countdown')).toBeVisible();
  await expect(dave.page.getByTestId('progress-player')).toHaveCount(3);
  await expect(dave.page.getByTestId('code-editor')).toHaveCount(0);
  await expect(dave.page.getByTestId('build-stage')).toHaveCount(0);
  await expect(dave.page.getByTestId('ship-button')).toHaveCount(0);

  // ─── The host ships fast (speedrun) ───────────────────────────────────────────────
  await writeApp(host.page, 'Ada Rocket', 'rgb(255, 87, 34)');
  await ship(host.page, 'Ada Rocket');
  // The others see the ship at once (a `build` event): the badge and a toast.
  for (const p of [bob, cleo, dave]) {
    await expect(progress(p.page, host.name)).toHaveAttribute('data-state', 'shipped');
    await expect(progress(p.page, host.name).getByTestId('shipped-badge')).toContainText(
      '“Ada Rocket” at ',
    );
  }
  await expect(
    bob.page.getByTestId('toast').filter({ hasText: `${host.name} shipped “Ada Rocket”` }),
  ).toBeVisible();

  // ─── Cleo edits, refreshes mid-BUILD and gets her work back ───────────────────────
  await writeApp(cleo.page, 'Cleo Autosave', 'rgb(0, 160, 80)');
  await expect
    .poll(() => storedFile(cleo.page, battleId, 'src/App.tsx'))
    .toContain('Cleo Autosave');
  await cleo.page.reload();
  await expect(cleo.page.getByTestId('build-stage')).toBeVisible({ timeout: 30_000 });
  await expect(cleo.page.getByTestId('challenge')).toContainText(card);
  await expect(buildFrame(cleo.page).locator('h1.e2e-title')).toHaveText('Cleo Autosave', {
    timeout: 30_000,
  });
  await expect(progress(cleo.page, host.name)).toHaveAttribute('data-state', 'shipped');
  // She does not ship; hiding the tab autosaves (as does the 30 s timer).
  await setVisibility(cleo.page, 'hidden');
  await expect(cleo.page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await setVisibility(cleo.page, 'visible');

  // ─── Bob builds on; the others see his live activity; he ships late (no speedrun) ─
  // (His build has a button that hangs it: the REVEAL below skips it when it freezes.)
  await writeApp(bob.page, 'Bob Turtle', 'rgb(30, 64, 175)', { extra: FREEZE_BUTTON });
  await expect(progress(host.page, bob.name)).toHaveAttribute('data-online', 'true');
  await expect(progress(host.page, bob.name).getByTestId('activity')).toContainText('lines');
  await snap(bob.page, 'build-sidebar');
  await snap(dave.page, 'spectator');
  // 60% of the time limit has passed (the server computes completion times).
  const elapsed = Math.round(limitS * 0.6);
  sql(`update public.battles
         set building_started_at = now() - interval '${String(elapsed)} seconds',
             building_ends_at = now() + interval '${String(limitS - elapsed)} seconds',
             phase_ends_at = now() + interval '${String(limitS - elapsed)} seconds'
       where id = '${battleId}'`);
  await ship(bob.page, 'Bob Turtle');
  await expect(progress(host.page, bob.name)).toHaveAttribute('data-state', 'shipped');

  // ─── The deadline passes: Cleo's autosave is auto-shipped ─────────────────────────
  // (Ships are moved back too, so none counts as a last-10-seconds clutch ship.)
  sql(`update public.builds set shipped_at = shipped_at - interval '60 seconds'
         where battle_id = '${battleId}' and status = 'shipped';
       update public.battles
         set building_started_at = now() - interval '${String(limitS + 20)} seconds',
             building_ends_at = now() - interval '20 seconds',
             phase_ends_at = now() - interval '20 seconds'
       where id = '${battleId}'`);
  await setVisibility(cleo.page, 'visible'); // resync now (pg_cron would within 5 s anyway)
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).not.toBe('building');
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}' and phase = 'shipping'`,
  );

  // ─── REVEAL: everyone watches the same build, one at a time ───────────────────────
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).toBe('reveal');
  const everyone = [host, bob, cleo, dave];
  // name → [builder id, build id]
  const ids = Object.fromEntries(
    sql(
      `select string_agg(p.display_name || '=' || b.builder_id || '=' || b.id, ',') from public.builds b join public.battle_players p on p.battle_id = b.battle_id and p.user_id = b.builder_id where b.battle_id = '${battleId}'`,
    )
      .split(',')
      .map((t) => t.split('='))
      .map(([name, uid, build]) => [name ?? '', { uid: uid ?? '', build: build ?? '' }]),
  ) as Record<string, { uid: string; build: string }>;
  const buildOf = (p: Player) => ids[p.name]?.build ?? 'missing';
  const userOf = (p: Player) => ids[p.name]?.uid ?? 'missing';
  const revealOrder = sql(
    `select array_to_string(reveal_order, ',') from public.battles where id = '${battleId}'`,
  ).split(',');
  expect([...revealOrder].sort()).toEqual([host, bob, cleo].map(buildOf).sort());
  const titleOf: Record<string, string> = {
    [buildOf(host)]: 'Ada Rocket',
    [buildOf(bob)]: 'Bob Turtle',
    [buildOf(cleo)]: 'Cleo Autosave',
  };
  for (let i = 0; i < revealOrder.length; i++) {
    const id = revealOrder[i] ?? '';
    for (const p of everyone) {
      const stage = p.page.getByTestId('reveal-stage');
      await expect(stage).toHaveAttribute('data-index', String(i), { timeout: 30_000 });
      await expect(stage).toHaveAttribute('data-build', id);
      await expect(p.page.getByTestId('reveal-position')).toHaveText(`Build ${String(i + 1)} of 3`);
      // The same build runs live for everyone (one live frame per page).
      await expect(p.page.locator('[data-testid=reveal-live-frame]')).toHaveCount(1);
      await expect(revealLive(p.page).locator('h1.e2e-title')).toHaveText(titleOf[id] ?? '?', {
        timeout: 30_000,
      });
      await expect(p.page.getByTestId('user-build-label')).toBeVisible();
    }
    if (i === 0) {
      // Reveal mode: no popups, no modals, no clipboard.
      for (const p of everyone) {
        const frame = p.page.locator('[data-testid=reveal-live-frame]');
        await expect(frame).toHaveAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
        );
        await expect(frame).toHaveAttribute('allow', 'autoplay; fullscreen; gamepad');
      }
      // Only the host has the controls; the slot counts down from the server's time.
      await expect(host.page.getByTestId('reveal-host-controls')).toBeVisible();
      for (const p of [bob, cleo, dave]) {
        await expect(p.page.getByTestId('reveal-next')).toHaveCount(0);
        await expect(p.page.getByTestId('reveal-host-note')).toContainText(host.name);
      }
      await expect(host.page.getByTestId('countdown')).toContainText(/0:[0-5]\d|1:00/);
      await expect(host.page.locator('[data-testid=reveal-strip-item]')).toHaveCount(3);
      await snap(host.page, 'reveal');
    }
    if (id === buildOf(bob)) {
      // Cleo freezes Bob's build in her tab, then skips it: the button is outside the
      // frozen iframe, and only her screen changes.
      await revealLive(cleo.page).locator('button.e2e-freeze').click();
      await cleo.page.getByTestId('skip-build').click();
      await expect(cleo.page.getByTestId('build-skipped')).toBeVisible();
      await expect(cleo.page.getByTestId('fallback-thumb')).toBeVisible(); // Bob shipped by hand
      await expect(cleo.page.locator('[data-testid=reveal-live-frame]')).toHaveCount(0);
      // Dave freezes it too and waits: the watchdog stops it ("this build froze").
      await revealLive(dave.page).locator('button.e2e-freeze').click();
      await expect(dave.page.getByTestId('build-froze')).toBeVisible({ timeout: 20_000 });
      await expect(dave.page.locator('[data-testid=reveal-live-frame]')).toHaveCount(0);
      // Everyone else still watches it live, on the same slot.
      for (const p of [host, bob]) {
        await expect(revealLive(p.page).locator('h1.e2e-title')).toHaveText('Bob Turtle');
        await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', String(i));
      }
      expect(phaseOf(battleId)).toBe('reveal');
    }
    // The host moves on: the next build, or (from the last one) to the vote.
    await clickRouted(
      host.page.getByTestId(i < revealOrder.length - 1 ? 'reveal-next' : 'skip-to-vote'),
    );
  }

  // ─── VOTE: one pick per category, never your own build ────────────────────────────
  for (const p of everyone) {
    await expect(p.page.getByTestId('vote-stage')).toBeVisible({ timeout: 30_000 });
    await expect(p.page.getByTestId('vote-progress')).toHaveText(/0\/3 voted/);
    await expect(p.page.locator('[data-testid=vote-category]')).toHaveCount(4);
  }
  // The spectator watches but has no ballot.
  await expect(dave.page.getByTestId('vote-stage')).toHaveAttribute('data-can-vote', 'false');
  await expect(dave.page.getByTestId('vote-spectator-note')).toBeVisible();
  await expect(dave.page.locator('button[data-testid=vote-option]')).toHaveCount(0);
  // A player's own build is shown in every category but cannot be picked.
  for (const p of [host, bob, cleo]) {
    const own = buildOf(p);
    await expect(p.page.locator('[data-testid=vote-option][data-own=true]')).toHaveCount(4);
    await expect(
      p.page.locator(`[data-testid=vote-option][data-own=true][data-build="${own}"]`),
    ).toHaveCount(4);
    await expect(
      p.page.locator(`button[data-testid=vote-option][data-build="${own}"]`),
    ).toHaveCount(0);
    await expect(p.page.locator('button[data-testid=vote-option]')).toHaveCount(8);
  }
  const [A, B, C] = [buildOf(host), buildOf(bob), buildOf(cleo)];
  // The scripted ballots (A = Ada's build, B = Bob's, C = Cleo's):
  //   Ada:  overall B, rule B, style C, chaos B
  //   Bob:  overall C, rule A (a revote; C first), style C, chaos A
  //   Cleo: overall A, rule B, style B, chaos B
  // Tallies: overall A1 B1 C1 (a three-way tie), rule A1 B2, style B1 C2, chaos A1 B2;
  // totals A 3, B 6, C 3. Ranking: Best Build is tied, so all votes decide: B first; A and
  // C are tied on both, so the earlier ship wins: A (Ada shipped by hand) before C (Cleo's
  // autosave, shipped at the deadline). Awards, one winner per category (T-022): the
  // three-way Best Build tie goes to B, who has the most votes in all (6 vs 3 and 3);
  // rule B, style C, chaos B; plus Ada's speedrun and fastest ship.
  for (const [cat, id] of [
    ['overall', B],
    ['rule', B],
    ['style', C],
    ['chaos', B],
  ] as const) {
    await vote(host.page, cat, id);
  }
  await expect(host.page.getByTestId('ballot-complete')).toBeVisible();
  for (const p of everyone) {
    await expect(p.page.getByTestId('vote-progress')).toHaveText(/1\/3 voted/);
  }
  await snap(host.page, 'vote', true);

  await vote(bob.page, 'rule', C);
  await vote(bob.page, 'rule', A); // a revote replaces the earlier pick
  await expect(
    bob.page.locator('[data-testid=vote-category][data-category=rule] [data-selected=true]'),
  ).toHaveCount(1);
  expect(
    sql(
      `select build_id from public.votes where battle_id = '${battleId}' and voter_id = '${userOf(bob)}' and category = 'rule'`,
    ),
  ).toBe(A);
  for (const [cat, id] of [
    ['overall', C],
    ['style', C],
    ['chaos', A],
  ] as const) {
    await vote(bob.page, cat, id);
  }
  await expect(bob.page.getByTestId('ballot-complete')).toBeVisible();
  await expect(dave.page.getByTestId('vote-progress')).toHaveText(/2\/3 voted/);

  // Cleo picks two, refreshes, and finds her ballot as she left it.
  await vote(cleo.page, 'overall', A);
  await vote(cleo.page, 'rule', B);
  await cleo.page.reload();
  await expect(cleo.page.getByTestId('vote-stage')).toBeVisible({ timeout: 30_000 });
  const option = (cat: string, id: string) =>
    cleo.page.locator(
      `[data-testid=vote-category][data-category=${cat}] [data-testid=vote-option][data-build="${id}"]`,
    );
  await expect(option('overall', A)).toHaveAttribute('data-selected', 'true');
  await expect(option('rule', B)).toHaveAttribute('data-selected', 'true');
  await expect(cleo.page.locator('[data-testid=vote-option][data-selected=true]')).toHaveCount(2);
  await expect(cleo.page.getByTestId('ballot-complete')).toHaveCount(0);
  expect(phaseOf(battleId)).toBe('voting');
  // Her last pick completes every ballot: voting ends at once (no waiting for the timer).
  await vote(cleo.page, 'style', B);
  await option('chaos', B).click();
  await expect.poll(() => phaseOf(battleId), { timeout: 15_000 }).toBe('results');
  expect(
    sql(
      `select payload ->> 'reason' from public.battle_events where battle_id = '${battleId}' and type = 'phase' and payload ->> 'to' = 'results'`,
    ),
  ).toBe('all_voted');

  // ─── RESULTS: ranked by votes, category awards, the winner highlighted ────────────
  for (const p of everyone) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
    await expect(p.page.getByTestId('ranked-build')).toHaveCount(3);
  }
  const row = (page: Page, who: Player) =>
    page.locator(`[data-testid=ranked-build][data-builder="${userOf(who)}"]`);
  const counts = (page: Page, who: Player) =>
    row(page, who)
      .locator('[data-testid=vote-count]')
      .evaluateAll((els): Record<string, number> =>
        Object.fromEntries(
          els.map((e) => [
            e.getAttribute('data-category') ?? '',
            Number(e.getAttribute('data-count')),
          ]),
        ),
      );
  const awardsOf = (page: Page, who: Player) =>
    row(page, who)
      .locator('[data-testid=award]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-award')).sort());
  for (const p of [host, dave]) {
    await expect(row(p.page, bob)).toHaveAttribute('data-rank', '1');
    await expect(row(p.page, host)).toHaveAttribute('data-rank', '2');
    await expect(row(p.page, cleo)).toHaveAttribute('data-rank', '3');
    await expect(row(p.page, cleo)).toHaveAttribute('data-status', 'auto_shipped');
    await expect(row(p.page, cleo).getByTestId('status-badge')).toHaveText('Auto-shipped');
    await expect(row(p.page, bob)).toHaveAttribute('data-winner', 'true');
    await expect(row(p.page, bob).getByTestId('winner-banner')).toBeVisible();
    await expect(p.page.getByTestId('winner-banner')).toHaveCount(1);
    await expect(row(p.page, bob)).toHaveAttribute('data-total-votes', '6');
    await expect(row(p.page, host)).toHaveAttribute('data-total-votes', '3');
    await expect(row(p.page, cleo)).toHaveAttribute('data-total-votes', '3');
    expect(await counts(p.page, host)).toEqual({ overall: 1, rule: 1, style: 0, chaos: 1 });
    expect(await counts(p.page, bob)).toEqual({ overall: 1, rule: 2, style: 1, chaos: 2 });
    expect(await counts(p.page, cleo)).toEqual({ overall: 1, rule: 0, style: 2, chaos: 0 });
    // Best Build: one vote each, so the total votes decide (Bob 6, Ada 3, Cleo 3).
    expect(await awardsOf(p.page, bob)).toEqual(['chaos', 'overall', 'rule']);
    expect(await awardsOf(p.page, host)).toEqual(['fastest_ship', 'speedrun']);
    expect(await awardsOf(p.page, cleo)).toEqual(['style']);
    await expect(p.page.locator('[data-testid=award][data-award=overall]')).toHaveCount(1);
    await expect(row(p.page, bob).locator('[data-testid=award][data-award=overall]')).toContainText(
      '1 vote',
    );
    await expect(p.page.getByTestId('ranking-rule')).toContainText('Ranked by votes');
    await expect(p.page.getByTestId('ranking-rule')).toContainText(
      'a tie goes to more votes in all',
    );
  }
  // The capture worker screenshots all three; the page shows them as they arrive.
  await expect(host.page.locator('[data-testid=ranked-build][data-capture=captured]')).toHaveCount(
    3,
    { timeout: 150_000 },
  );
  for (const who of [host, bob, cleo]) {
    await expect
      .poll(() =>
        row(host.page, who)
          .getByTestId('build-screenshot')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
      )
      .toBe(1280);
  }
  // Each player's own build in the last look (reveal mode); the spectator has none.
  const lastLook = (page: Page) =>
    page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe').locator('h1.e2e-title');
  await expect(lastLook(host.page)).toHaveText('Ada Rocket');
  await expect(lastLook(cleo.page)).toHaveText('Cleo Autosave');
  await expect(dave.page.locator('[data-testid=reveal-frame]')).toHaveCount(0);
  await snap(host.page, 'results', true);

  // ─── DESTROY for everyone, back in the lobby ──────────────────────────────────────
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
  for (const p of [host, bob, cleo, dave]) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
    // The podium: Bob's build won the vote.
    await expect(p.page.getByTestId('last-battle').locator('li').first()).toContainText(
      'Bob Turtle',
    );
    await expect(p.page.getByTestId('last-battle')).toContainText('Ada Rocket');
  }
  expect(phaseOf(battleId)).toBe('destroyed');
  // The battle's local copies are gone; the late spectator now has a player slot.
  expect(await storedFile(host.page, battleId, 'src/App.tsx')).toBeNull();
  await expect(member(host.page, dave.name)).toHaveAttribute('data-role', 'player');
  await expect(host.page.getByTestId('player-count')).toHaveText('4/8 players');

  // ─── Rematch: a new battle in the same room ───────────────────────────────────────
  for (const p of [host, dave]) await p.page.getByTestId('ready-toggle').click();
  await expect(host.page.getByTestId('start-battle')).toHaveText('Start the rematch');
  await expect(host.page.getByTestId('start-battle')).toBeEnabled();
  await host.page.getByTestId('start-battle').click();
  await expect.poll(() => battleOf(code)).not.toBe(battleId);
  for (const p of [host, dave]) await expect(p.page.getByTestId('spin')).toBeVisible();
  // Bob and Cleo did not ready up: they watch this one.
  await expect(bob.page.getByTestId('spectator-stage')).toBeVisible();

  // ─── The permanent page: votes, category awards, the winner ───────────────────────
  const pub = await cleo.context.newPage();
  pub.on('pageerror', (e) => cleo.errors.push(e.message));
  await pub.goto(`/battles/${battleId}`);
  const publicBuilds = pub.getByTestId('public-build');
  await expect(publicBuilds).toHaveCount(3);
  await expect(publicBuilds.nth(0)).toHaveAttribute('data-winner', 'true');
  await expect(publicBuilds.nth(0).getByTestId('public-build-name')).toContainText('Bob Turtle');
  await expect(publicBuilds.nth(1).getByTestId('public-build-name')).toContainText('Ada Rocket');
  await expect(publicBuilds.nth(0).getByTestId('vote-tally')).toHaveAttribute('data-total', '6');
  await expect(publicBuilds.nth(0).locator('[data-testid=award][data-source=vote]')).toHaveCount(3);
  await expect(publicBuilds.nth(0).locator('[data-award=overall]')).toBeVisible();
  await expect(pub.locator('[data-testid=award][data-award=overall]')).toHaveCount(1);
  await expect(publicBuilds.nth(1).locator('[data-testid=award][data-source=vote]')).toHaveCount(0);
  await expect(publicBuilds.nth(2).locator('[data-award=style]')).toBeVisible();
  // The link preview (T-038, written at the edge for crawlers): the winner, Bob's build, with
  // its screenshot from Storage.
  const preview = await crawl(pub.request, `/battles/${battleId}`);
  expect(preview.status).toBe(200);
  expect(one(preview, 'og:title')).toMatch(/^Bob Turtle by /);
  expect(one(preview, 'og:description')).toMatch(/^Winner: Bob Turtle by /);
  const ogUrl = one(preview, 'og:image');
  expect(ogUrl).toContain(`/storage/v1/object/public/screenshots/${battleId}/`);
  const og = await pub.request.get(ogUrl);
  expect(og.status()).toBe(200);
  expect(og.headers()['content-type']).toMatch(/^image\//);
  await snap(pub, 'battle-page', true);
  await pub.close();

  for (const p of [host, bob, cleo, dave]) {
    expect(p.errors, `${p.name}: page errors`).toEqual([]);
    await p.context.close();
  }
});

test('the host kicks a member in the lobby; the kicked user cannot come back', async ({
  browser,
}, info) => {
  const host = await newPlayer(browser, info, 'Hana Host');
  const eve = await newPlayer(browser, info, 'Eve Kicked');

  await host.page.goto('/');
  await host.page.getByTestId('create-room').click();
  await host.page.getByTestId('host-name').fill(host.name);
  await host.page.getByTestId('create-room-submit').click();
  await expect(host.page.getByTestId('lobby')).toBeVisible();
  const code = new URL(host.page.url()).pathname.split('/').pop() ?? '';

  await joinByLink(eve, code);
  await expect(eve.page.getByTestId('lobby')).toBeVisible();
  await expect(member(host.page, eve.name)).toHaveAttribute('data-online', 'true');
  // Only the host has kick buttons.
  await expect(eve.page.getByTestId('kick')).toHaveCount(0);

  await member(host.page, eve.name).getByTestId('kick').click();
  const dialog = host.page.getByTestId('kick-confirm');
  await expect(dialog).toContainText(`Kick ${eve.name}?`);
  await dialog.getByTestId('confirm').click();

  await expect(eve.page.getByTestId('kicked')).toBeVisible();
  await expect(eve.page.getByTestId('kicked')).toContainText(`You were removed from room ${code}`);
  await expect(member(host.page, eve.name)).toHaveCount(0);
  await expect(host.page.getByTestId('player-count')).toHaveText('1/8 players');

  // Coming back with the link: refused.
  await eve.page.goto(`/r/${code}`);
  await expect(eve.page.getByTestId('join-error')).toBeVisible();
  await expect(eve.page.locator('[data-code=kicked]')).toBeVisible();

  for (const p of [host, eve]) {
    expect(p.errors, `${p.name}: page errors`).toEqual([]);
    await p.context.close();
  }
});

test('join errors: unknown and malformed codes', async ({ browser }, info) => {
  const p = await newPlayer(browser, info, 'Lost Larry');
  // A well-formed code that no room has: join_room answers room_not_found.
  const unused = ['ZZZZZ', 'ZZZZY', 'ZZZZX'].find(
    (c) => sql(`select count(*) from public.rooms where code = '${c}'`) === '0',
  );
  expect(unused).toBeDefined();
  await p.page.goto(`/r/${(unused ?? '').toLowerCase()}`);
  await p.page.getByTestId('display-name').fill(p.name);
  await p.page.getByTestId('join-room').click();
  await expect(p.page.locator('[data-testid=join-error] [data-code=room_not_found]')).toBeVisible();
  // A malformed code (no 0, 1, I or O in codes) never reaches the server.
  await p.page.goto('/r/ZZZZ0');
  await expect(p.page.locator('[data-testid=join-error] [data-code=room_not_found]')).toBeVisible();
  // The landing page refuses a malformed code before navigating.
  await p.page.goto('/');
  await p.page.getByTestId('join-with-code').click();
  await p.page.getByTestId('room-code-input').fill('abc');
  await p.page.getByTestId('join-room-submit').click();
  await expect(p.page.getByTestId('code-error')).toContainText('5 letters and digits');
  await expect(p.page).toHaveURL(/\/$/);
  expect(p.errors).toEqual([]);
  await p.context.close();
});
