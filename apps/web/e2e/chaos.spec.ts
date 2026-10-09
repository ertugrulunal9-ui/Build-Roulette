import type { Page } from '@playwright/test';
import { expect, test } from './diagnostics';
import { buildFrame, clickRouted } from './helpers';
import {
  autosaveNow,
  battleOf,
  createRoom,
  joinByLink,
  member,
  newPlayer,
  openFile,
  phaseOf,
  progress,
  revealLive,
  ship,
  storedFile,
  vote,
  waitForBuild,
  writeApp,
  type Player,
} from './rooms';
import {
  assertUuid,
  dropRealtimeDatabaseFeed,
  keepRealtimeDatabaseFeedDown,
  ephemeralText,
  realtimeDatabaseFeedUp,
  sql,
} from './stack';

/**
 * Rooms under chaos (playwright.chaos.config.ts, docs/04 §4.8, docs/06 M3 exit criteria):
 * several browser contexts against the real local stack (Realtime, pg_cron, the capture and
 * destroy worker), with network drops, skewed clocks, refreshes, a host who disappears,
 * every client gone at T-0, an abandoned battle and a full room. M4 (T-021) adds REVEAL and
 * VOTE under chaos: a refresh mid-REVEAL, a vote cast offline (retried until it lands), a
 * player offline until the vote closes (told in RESULTS) and the host leaving mid-VOTE.
 *
 * Time is real where it matters: the battle's time limit is set (as the superuser) while
 * the battle spins, so BUILD has true deadlines that every client learns from the server.
 * Long waits that would only burn minutes (the 5 min abandonment window, the 60 s last
 * look, REVEAL slots and the vote where a test does not drive them) are shortened with SQL,
 * as the other e2e do. Every battle runs with REVEAL and VOTING (the default). Every test ends by checking, in the
 * database, that the battle reached a consistent terminal state and no shipped build was
 * lost (expectTerminal).
 */

const MIN = 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────────────

/** The host creates a room and everyone else joins with the invite link. */
async function gather(players: Player[]): Promise<string> {
  const [host, ...rest] = players;
  if (!host) throw new Error('no players');
  const code = await createRoom(host);
  for (const p of rest) {
    await joinByLink(p, code);
    await expect(p.page.getByTestId('lobby')).toBeVisible();
  }
  return code;
}

/**
 * Everyone readies up, the host starts, and while the battle spins its time limit becomes
 * `limitS` (the real one is 5–15 min). Returns the battle id once every player builds.
 */
async function startBattle(code: string, players: Player[], limitS: number): Promise<string> {
  const [host] = players;
  if (!host) throw new Error('no players');
  for (const p of players) {
    await expect(p.page.locator('[data-testid=member][data-online=true]')).toHaveCount(
      players.length,
    );
    await p.page.getByTestId('ready-toggle').click();
    await expect(p.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(host.page.getByTestId('start-battle')).toBeEnabled();
  await host.page.getByTestId('start-battle').click();
  await expect.poll(() => battleOf(code), { intervals: [50] }).toMatch(/^[0-9a-f-]{36}$/);
  const battleId = assertUuid(battleOf(code));
  const changed = sql(`update public.challenges c set time_limit_seconds = ${String(limitS)}
                         from public.battles b
                        where b.id = '${battleId}' and b.challenge_id = c.id and b.phase = 'spinning'
                    returning c.id`);
  expect(changed, 'the time limit must be set while the battle spins').not.toBe('');
  for (const p of players) await waitForBuild(p.page);
  expect(
    sql(
      `select extract(epoch from building_ends_at - building_started_at)::int from public.battles where id = '${battleId}'`,
    ),
  ).toBe(String(limitS));
  return battleId;
}

/** Seconds left in the battle's phase, by the database clock. */
function serverRemainingS(battleId: string): number {
  return Number(
    sql(
      `select extract(epoch from phase_ends_at - clock_timestamp()) from public.battles where id = '${battleId}'`,
    ),
  );
}

async function countdownS(page: Page): Promise<number | null> {
  const text = (await page.getByTestId('countdown').locator('span').last().textContent()) ?? '';
  const m = /^(\d+):(\d\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The page's countdown shows the server's remaining time (±2 s), whatever its clock says. */
async function expectCountdownInSync(p: Player, battleId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const shown = await countdownS(p.page);
        if (shown === null) return Number.POSITIVE_INFINITY;
        return Math.abs(shown - serverRemainingS(battleId));
      },
      { message: `${p.name}: countdown vs server`, timeout: 15_000 },
    )
    .toBeLessThanOrEqual(2);
}

const userOf = (battleId: string, name: string) =>
  sql(
    `select user_id from public.battle_players where battle_id = '${battleId}' and display_name = '${name}'`,
  );

interface BuildRow {
  builder: string;
  name: string | null;
  status: string;
  capture_status: string;
  screenshot_path: string | null;
  final_rank: number | null;
  source_destroyed_at: string | null;
}

interface BattleRow {
  phase: string;
  version: number;
  is_complete: boolean;
  destroyed_at: string | null;
  room_status: string | null;
  players: number;
  events: number[];
  builds: BuildRow[];
  ephemeral_objects: number;
  screenshots: number;
}

function battleRow(battleId: string): BattleRow {
  return JSON.parse(
    sql(`select json_build_object(
      'phase', b.phase, 'version', b.version, 'is_complete', b.is_complete,
      'destroyed_at', b.destroyed_at,
      'room_status', (select r.status from public.rooms r where r.id = b.room_id),
      'players', (select count(*) from public.battle_players bp where bp.battle_id = b.id),
      'events', (select coalesce(json_agg(e.version order by e.version), '[]') from public.battle_events e where e.battle_id = b.id),
      'builds', (select coalesce(json_agg(json_build_object(
          'builder', bp.display_name, 'name', bu.name, 'status', bu.status,
          'capture_status', bu.capture_status, 'screenshot_path', bu.screenshot_path,
          'final_rank', bu.final_rank, 'source_destroyed_at', bu.source_destroyed_at)
          order by bp.display_name), '[]')
        from public.builds bu join public.battle_players bp
          on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
        where bu.battle_id = b.id),
      'ephemeral_objects', (select count(*) from storage.objects o
        where o.bucket_id = 'ephemeral-builds' and o.name like b.id || '/%'),
      'screenshots', (select count(*) from storage.objects o
        where o.bucket_id = 'screenshots' and o.name like b.id || '/%'))
    from public.battles b where b.id = '${assertUuid(battleId)}'`),
  ) as BattleRow;
}

/**
 * The battle ended consistently: a terminal phase, one event per version (1…version), one
 * build per roster player, every hand-shipped build still shipped under its name, no
 * screenshot left pending, ranks only for final builds (1…n), and once the destroy worker
 * ran, no ephemeral file left. Returns the final row.
 */
async function expectTerminal(
  battleId: string,
  expected: { phase: 'destroyed' | 'abandoned'; shipped: Record<string, string> },
): Promise<BattleRow> {
  // The destroy worker deletes the build files shortly after the terminal phase.
  await expect.poll(() => battleRow(battleId).destroyed_at, { timeout: 60_000 }).not.toBeNull();
  const b = battleRow(battleId);
  expect(b.phase).toBe(expected.phase);
  expect(b.is_complete).toBe(expected.phase === 'destroyed');
  expect(b.room_status).not.toBe('in_battle');
  expect(b.events, 'one battle event per version').toEqual(
    Array.from({ length: b.version }, (_, i) => i + 1),
  );
  expect(b.builds).toHaveLength(b.players);
  for (const [builder, name] of Object.entries(expected.shipped)) {
    const build = b.builds.find((x) => x.builder === builder);
    expect(build, `${builder}'s build`).toMatchObject({ status: 'shipped', name });
  }
  const final = b.builds.filter((x) => x.status === 'shipped' || x.status === 'auto_shipped');
  for (const x of b.builds) {
    expect(x.source_destroyed_at, `${x.builder}: source deleted`).not.toBeNull();
    if (expected.phase === 'destroyed') {
      expect(x.status, `${x.builder}: no draft after the battle`).not.toBe('draft');
    }
  }
  for (const x of final) {
    expect(x.capture_status, `${x.builder}: capture settled`).not.toBe('pending');
    if (x.capture_status === 'captured' || x.capture_status === 'fallback') {
      expect(x.screenshot_path).toMatch(new RegExp(`^${battleId}/`));
    }
  }
  if (expected.phase === 'destroyed') {
    const ranks = final.map((x) => x.final_rank).filter((r): r is number => r !== null);
    expect(ranks, 'every final build is ranked').toHaveLength(final.length);
    expect(Math.min(...ranks)).toBe(1);
    expect(Math.max(...ranks)).toBeLessThanOrEqual(final.length);
    expect(b.builds.filter((x) => x.status === 'dnf').every((x) => x.final_rank === null)).toBe(
      true,
    );
  } else {
    expect(b.builds.every((x) => x.final_rank === null)).toBe(true);
  }
  expect(b.ephemeral_objects, 'no build file left').toBe(0);
  expect(b.screenshots).toBe(
    final.filter((x) => x.capture_status === 'captured' || x.capture_status === 'fallback').length,
  );
  return b;
}

/** Every file of the battle's workspace in this page's IndexedDB. */
async function storedFiles(page: Page, battleId: string): Promise<Record<string, string>> {
  return page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('br-workspaces');
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(new Error('open failed'));
      };
    });
    const value = await new Promise<unknown>((resolve) => {
      const r = db.transaction('workspaces', 'readonly').objectStore('workspaces').get(key);
      r.onsuccess = () => {
        resolve(r.result as unknown);
      };
    });
    db.close();
    return (value as { files?: Record<string, string> } | undefined)?.files ?? {};
  }, `battle:${battleId}`);
}

/**
 * REVEAL and VOTING without their timers: whenever the battle is in one of them, its
 * deadline (the current slot, or the vote) is moved to now, and the server (pg_cron every
 * 5 s, or a client's nudge) moves on. Returns once the battle is past VOTING.
 */
async function deadlineSkip(battleId: string): Promise<void> {
  await expect
    .poll(
      () => {
        sql(`update public.battles set phase_ends_at = least(phase_ends_at, now())
              where id = '${assertUuid(battleId)}' and phase in ('reveal', 'voting')`);
        return phaseOf(battleId);
      },
      { timeout: 2 * MIN, intervals: [1_000] },
    )
    .not.toMatch(/^(building|shipping|reveal|voting)$/);
}

/** Every page shows the same REVEAL spotlight (index and build) and runs that build. */
async function expectSameSpotlight(players: Player[]): Promise<void> {
  const [first, ...rest] = players;
  if (!first) return;
  const stage = first.page.getByTestId('reveal-stage');
  await expect(stage).toBeVisible({ timeout: MIN });
  const index = (await stage.getAttribute('data-index')) ?? '';
  const build = (await stage.getAttribute('data-build')) ?? '';
  for (const p of rest) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', index, {
      timeout: 30_000,
    });
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-build', build);
  }
  // The build runs (its heading: a template that was shipped untouched has its own).
  for (const p of players) {
    await expect(revealLive(p.page).locator('h1').first()).toBeVisible({ timeout: 30_000 });
  }
}

/** Ends the RESULTS last look now (pg_cron moves the battle to DESTROYED within 5 s). */
function endLastLook(battleId: string): void {
  sql(
    `update public.battles set phase_ends_at = now() where id = '${battleId}' and phase = 'results'`,
  );
}

function expectNoPageErrors(players: Player[]): void {
  for (const p of players) expect(p.errors, `${p.name}: page errors`).toEqual([]);
}

// ─── 6 players under chaos ────────────────────────────────────────────────────────────

test('6 players under chaos: skewed clocks, a network drop, refreshes, the host vanishes (in BUILD, and the next one in REVEAL); the battle completes and the new host starts the rematch @chaos-1', async ({
  browser,
}, info) => {
  test.setTimeout(12 * MIN);
  const ada = await newPlayer(browser, info, 'Ada Host');
  const ben = await newPlayer(browser, info, 'Ben Ahead', { clockSkewMs: 5 * MIN });
  const cy = await newPlayer(browser, info, 'Cy Behind', { clockSkewMs: -5 * MIN });
  const dee = await newPlayer(browser, info, 'Dee Offline');
  const eve = await newPlayer(browser, info, 'Eve Refresh');
  const fay = await newPlayer(browser, info, 'Fay Idle');
  const all = [ada, ben, cy, dee, eve, fay];
  const code = await gather(all);
  // The skewed clocks really are off by ±5 min.
  expect((await ben.page.evaluate(() => Date.now())) - Date.now()).toBeGreaterThan(4.9 * MIN);
  expect((await cy.page.evaluate(() => Date.now())) - Date.now()).toBeLessThan(-4.9 * MIN);

  const battleId = await startBattle(code, all, 150);
  // Every countdown shows the server's time, skewed clocks included.
  for (const p of all) await expectCountdownInSync(p, battleId);

  // ─── Dee's network drops for 15 s mid-BUILD; she keeps editing ────────────────────
  await writeApp(dee.page, 'Dee Before', 'rgb(120, 20, 160)');
  await dee.context.setOffline(true);
  const offlineAt = Date.now();
  await expect(dee.page.getByTestId('reconnecting')).toBeVisible({ timeout: 20_000 });
  await writeApp(dee.page, 'Dee Offline Edit', 'rgb(160, 20, 120)', { waitForPreview: false });
  await expect
    .poll(() => storedFile(dee.page, battleId, 'src/App.tsx'))
    .toContain('Dee Offline Edit');

  // Meanwhile: Ben (+5 min) ships, Cy (−5 min) builds and autosaves (and will not ship).
  await writeApp(ben.page, 'Ben Early', 'rgb(255, 87, 34)');
  await ship(ben.page, 'Ben Early');
  await writeApp(cy.page, 'Cy Behind', 'rgb(0, 150, 136)');
  await autosaveNow(cy.page);

  // ─── The host writes, autosaves, and her laptop dies (the context closes) ─────────
  await writeApp(ada.page, 'Ada Vanished', 'rgb(33, 150, 243)');
  await autosaveNow(ada.page);
  const benCrowned = ben.page
    .getByTestId('toast')
    .filter({ hasText: 'You are the host now' })
    .waitFor({ timeout: 2 * MIN });
  const othersToldOf = [cy, eve, fay].map((p) =>
    p.page
      .getByTestId('toast')
      .filter({ hasText: `${ben.name} is the host now` })
      .waitFor({ timeout: 2 * MIN }),
  );
  await ada.context.close();

  // ─── Dee comes back after 15 s ────────────────────────────────────────────────────
  await dee.page.waitForTimeout(Math.max(0, 15_000 - (Date.now() - offlineAt)));
  await dee.context.setOffline(false);
  await expect(dee.page.getByTestId('reconnecting')).toBeHidden({ timeout: 30_000 });
  // What happened while she was away is there; the countdown is right.
  await expect(progress(dee.page, ben.name)).toHaveAttribute('data-state', 'shipped');
  await expectCountdownInSync(dee, battleId);
  // The edit made offline reaches the server autosave (the 30 s loop retries).
  const deeId = userOf(battleId, dee.name);
  await expect
    .poll(() => ephemeralText(`${battleId}/${deeId}/autosave/source.json`), {
      timeout: 45_000,
      intervals: [1_000],
    })
    .toContain('Dee Offline Edit');
  await expect(buildFrame(dee.page).locator('h1.e2e-title')).toHaveText('Dee Offline Edit');
  await ship(dee.page, 'Dee Unplugged');

  // ─── Eve refreshes mid-BUILD and gets everything back ─────────────────────────────
  await writeApp(eve.page, 'Eve Refreshed', 'rgb(76, 175, 80)');
  await expect.poll(() => storedFile(eve.page, battleId, 'src/App.tsx')).toContain('Eve Refreshed');
  await eve.page.reload();
  await expect(eve.page.getByTestId('build-stage')).toBeVisible({ timeout: 30_000 });
  await expect(buildFrame(eve.page).locator('h1.e2e-title')).toHaveText('Eve Refreshed', {
    timeout: 30_000,
  });
  await expect(progress(eve.page, ben.name)).toHaveAttribute('data-state', 'shipped');
  await expectCountdownInSync(eve, battleId);
  await ship(eve.page, 'Eve Refreshed');

  // ─── Host migration: Ben (the earliest present player) gets the crown ─────────────
  await benCrowned;
  await Promise.all(othersToldOf);
  for (const p of [ben, cy, dee, eve, fay]) {
    await expect(progress(p.page, ben.name)).toHaveAttribute('data-host', 'true');
    await expect(progress(p.page, ada.name)).toHaveAttribute('data-host', 'false');
  }
  expect(sql(`select host_id from public.battles where id = '${battleId}'`)).toBe(
    userOf(battleId, ben.name),
  );

  // ─── T-0 on the skewed clocks: Cy (−5 min) and Fay see time's up with the server ──
  for (const p of [ben, cy, dee, fay]) await expectCountdownInSync(p, battleId);
  await expect
    .poll(() => serverRemainingS(battleId), { timeout: 3 * MIN, intervals: [500] })
    .toBeLessThan(4);
  await expect(cy.page.getByTestId('times-up')).toBeHidden();
  for (const p of [cy, fay]) {
    await expect(p.page.getByTestId('times-up')).toBeVisible({ timeout: 10_000 });
    // Not early, and at most ~2 s late (the 4 Hz countdown and the poll above).
    expect(serverRemainingS(battleId) < 0.5 || phaseOf(battleId) !== 'building').toBe(true);
  }

  // ─── REVEAL (after the 15 s grace): Ben hosts it, on everyone's timeline ──────────
  const present = [ben, cy, dee, eve, fay];
  await expectSameSpotlight(present);
  await expect(ben.page.getByTestId('reveal-host-controls')).toBeVisible();
  for (const p of [cy, dee, eve, fay])
    await expect(p.page.getByTestId('reveal-next')).toHaveCount(0);
  const first = Number(await ben.page.getByTestId('reveal-stage').getAttribute('data-index'));
  await clickRouted(ben.page.getByTestId('reveal-next'));
  for (const p of present) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute(
      'data-index',
      String(first + 1),
    );
  }
  await expectSameSpotlight(present);

  // ─── Ben drops mid-REVEAL: the crown (and the controls) move to Cy ────────────────
  const cyCrowned = cy.page
    .getByTestId('toast')
    .filter({ hasText: 'You are the host now' })
    .waitFor({ timeout: 2 * MIN });
  await ben.context.setOffline(true);
  await cyCrowned;
  await expect(cy.page.getByTestId('reveal-host-controls')).toBeVisible();
  await ben.context.setOffline(false);
  await expect(ben.page.getByTestId('reconnecting')).toBeHidden({ timeout: 30_000 });
  await expect(ben.page.getByTestId('reveal-host-controls')).toHaveCount(0);
  await expect(ben.page.getByTestId('reveal-host-note')).toContainText(cy.name);
  expect(sql(`select host_id from public.battles where id = '${battleId}'`)).toBe(
    userOf(battleId, cy.name),
  );
  // The slots kept running meanwhile; everyone still sees the same one.
  await expectSameSpotlight(present);
  await clickRouted(cy.page.getByTestId('skip-to-vote'));

  // ─── VOTE: Cy and Dee vote for Ben's build everywhere; the timer ends the rest ─────
  for (const p of present) {
    await expect(p.page.getByTestId('vote-stage')).toBeVisible({ timeout: 30_000 });
  }
  const benBuild = sql(
    `select id from public.builds where battle_id = '${battleId}' and builder_id = '${userOf(battleId, ben.name)}'`,
  );
  for (const p of [cy, dee]) {
    for (const cat of ['overall', 'rule', 'style', 'chaos']) await vote(p.page, cat, benBuild);
    await expect(p.page.getByTestId('ballot-complete')).toBeVisible();
  }
  await expect(fay.page.getByTestId('vote-progress')).toHaveText(/2\/6 voted/);
  await deadlineSkip(battleId);

  // ─── RESULTS; Fay refreshes during it ─────────────────────────────────────────────
  for (const p of present) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: MIN });
  }
  // Ranked by votes: Ben's build won Best Build (2 votes).
  await expect(
    fay.page.locator(`[data-testid=ranked-build][data-builder="${userOf(battleId, ben.name)}"]`),
  ).toHaveAttribute('data-rank', '1');
  await fay.page.reload();
  await expect(fay.page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  // Every final build gets its screenshot from the jobs function.
  await expect
    .poll(
      () =>
        sql(
          `select count(*) from public.builds where battle_id = '${battleId}' and status in ('shipped', 'auto_shipped') and capture_status = 'pending'`,
        ),
      { timeout: 3 * MIN, intervals: [1_000] },
    )
    .toBe('0');
  const statuses = Object.fromEntries(battleRow(battleId).builds.map((b) => [b.builder, b.status]));
  expect(statuses).toMatchObject({
    [ada.name]: 'auto_shipped',
    [ben.name]: 'shipped',
    [cy.name]: 'auto_shipped',
    [dee.name]: 'shipped',
    [eve.name]: 'shipped',
  });
  // Fay never touched her template: its autosave ships, or nothing was saved (DNF).
  expect(['auto_shipped', 'dnf']).toContain(statuses[fay.name]);
  await expect(fay.page.locator('[data-testid=ranked-build][data-status=shipped]')).toHaveCount(3);

  // ─── DESTROY, back in the lobby; Cy hosts the rematch ─────────────────────────────
  endLastLook(battleId);
  for (const p of [ben, cy, dee, eve, fay]) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: MIN });
    await expect(p.page.getByTestId('last-battle')).toContainText('Ben Early');
    await expect(member(p.page, cy.name)).toHaveAttribute('data-host', 'true');
  }
  await expectTerminal(battleId, {
    phase: 'destroyed',
    shipped: { [ben.name]: 'Ben Early', [dee.name]: 'Dee Unplugged', [eve.name]: 'Eve Refreshed' },
  });

  for (const p of [ben, cy]) await p.page.getByTestId('ready-toggle').click();
  await expect(cy.page.getByTestId('start-battle')).toHaveText('Start the rematch');
  await expect(cy.page.getByTestId('start-battle')).toBeEnabled();
  await cy.page.getByTestId('start-battle').click();
  await expect.poll(() => battleOf(code)).not.toBe(battleId);
  const rematch = assertUuid(battleOf(code));
  for (const p of [ben, cy]) await waitForBuild(p.page);
  await expect(dee.page.getByTestId('spectator-stage')).toBeVisible();

  expectNoPageErrors(all);
  for (const p of [ben, cy, dee, eve, fay]) await p.context.close();
  // Nobody is left: the rematch is abandoned (the 5 min window, shortened).
  sql(`update public.room_members set last_seen_at = now() - interval '6 minutes'
        where room_id = (select room_id from public.battles where id = '${rematch}')`);
  await expect.poll(() => phaseOf(rematch), { timeout: 30_000 }).toBe('abandoned');
  await expectTerminal(rematch, { phase: 'abandoned', shipped: {} });
});

// ─── REVEAL and VOTE under chaos ──────────────────────────────────────────────────────

test('reveal and vote under chaos: a refresh mid-REVEAL, a vote cast offline (retried), a player offline until the vote closes (told), the host leaves mid-VOTE', async ({
  browser,
}, info) => {
  test.setTimeout(6 * MIN);
  const hana = await newPlayer(browser, info, 'Hana Host');
  const ivo = await newPlayer(browser, info, 'Ivo Flaky');
  const jun = await newPlayer(browser, info, 'Jun Offline');
  const all = [hana, ivo, jun];
  const code = await gather(all);
  // Time to vote, so only presence (not the timer) can end VOTING early below.
  await hana.page.getByTestId('setting-voting').selectOption('120');
  await expect(ivo.page.getByTestId('settings-summary')).toContainText('120 s to vote');
  const battleId = await startBattle(code, all, 120);

  const title: Record<string, string> = {};
  for (const [i, p] of all.entries()) {
    title[p.name] = `${p.name} build`;
    await writeApp(p.page, title[p.name] ?? '', 'rgb(40, 90, 160)');
    await ship(p.page, `${p.name} build`, { last: i === all.length - 1 });
  }
  const buildOf = (name: string) =>
    sql(
      `select id from public.builds where battle_id = '${battleId}' and builder_id = '${userOf(battleId, name)}'`,
    );
  const order = () =>
    sql(
      `select array_to_string(reveal_order, ',') from public.battles where id = '${battleId}'`,
    ).split(',');
  const titleOfBuild = (buildId: string) =>
    title[all.find((p) => buildOf(p.name) === buildId)?.name ?? ''] ?? '';

  // ─── REVEAL: the host moves on, Ivo refreshes and lands on the current build ──────
  await expect.poll(() => phaseOf(battleId), { timeout: MIN }).toBe('reveal');
  await expectSameSpotlight(all);
  await clickRouted(hana.page.getByTestId('reveal-next'));
  for (const p of all) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', '1');
  }
  const second = order()[1] ?? '';
  await ivo.page.reload();
  const stage = ivo.page.getByTestId('reveal-stage');
  await expect(stage).toBeVisible({ timeout: 30_000 });
  await expect(stage).toHaveAttribute('data-index', '1');
  await expect(stage).toHaveAttribute('data-build', second);
  // The right build runs (not the first one, not the next one), on the server's slot.
  await expect(revealLive(ivo.page).locator('h1.e2e-title')).toHaveText(titleOfBuild(second), {
    timeout: 30_000,
  });
  await expect(ivo.page.locator('iframe[data-testid=reveal-live-frame]')).toHaveCount(1);
  await expectCountdownInSync(ivo, battleId);
  await clickRouted(hana.page.getByTestId('reveal-next'));
  for (const p of all) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', '2');
  }
  await clickRouted(hana.page.getByTestId('reveal-next')); // the last build: VOTING starts
  for (const p of all) {
    await expect(p.page.getByTestId('vote-stage')).toBeVisible({ timeout: 30_000 });
  }
  const H = buildOf(hana.name);
  const J = buildOf(jun.name);
  const votesOf = (name: string) =>
    sql(
      `select coalesce(string_agg(category || '=' || build_id, ',' order by category), '') from public.votes where battle_id = '${battleId}' and voter_id = '${userOf(battleId, name)}'`,
    );

  // ─── The host votes once and leaves mid-VOTE: nothing waits for her ───────────────
  await vote(hana.page, 'overall', J);
  await hana.page.getByTestId('leave-room').click();
  await hana.page.getByTestId('leave-confirm').getByTestId('confirm').click();
  await expect(hana.page.getByTestId('room-ended')).toBeVisible();
  await expect
    .poll(() => sql(`select host_id from public.battles where id = '${battleId}'`))
    .toBe(userOf(battleId, ivo.name));

  // ─── Ivo's network drops; the vote he casts offline is kept and retried ───────────
  await ivo.context.setOffline(true);
  await ivo.page
    .locator(
      `[data-testid=vote-category][data-category=overall] [data-testid=vote-option][data-build="${J}"]`,
    )
    .click();
  await expect(ivo.page.getByTestId('votes-unsent')).toBeVisible();
  await expect(
    ivo.page.locator('[data-testid=vote-category][data-category=overall]'),
  ).toHaveAttribute('data-state', 'unsent');
  await ivo.page.waitForTimeout(5_000); // a few retries fail meanwhile
  expect(votesOf(ivo.name), 'nothing reached the server while offline').toBe('');
  await ivo.context.setOffline(false);
  await expect(
    ivo.page.locator(
      `[data-testid=vote-category][data-category=overall] [data-testid=vote-option][data-build="${J}"]`,
    ),
  ).toHaveAttribute('data-selected', 'true', { timeout: 30_000 });
  await expect(ivo.page.getByTestId('votes-unsent')).toHaveCount(0);
  expect(votesOf(ivo.name)).toBe(`overall=${J}`);

  // ─── Jun goes offline and picks; Ivo completes his ballot while Jun still counts ───
  await jun.context.setOffline(true);
  await jun.page
    .locator(
      `[data-testid=vote-category][data-category=overall] [data-testid=vote-option][data-build="${H}"]`,
    )
    .click();
  await expect(jun.page.getByTestId('votes-unsent')).toBeVisible();
  // His last sign of life is now (as if his last heartbeat had just landed), so the 30 s
  // presence window starts here, whatever the heartbeat timing was.
  sql(
    `update public.room_members m set last_seen_at = now() from public.rooms r where r.id = m.room_id and r.code = '${code}' and m.user_id = '${userOf(battleId, jun.name)}'`,
  );
  const junSilent = () =>
    sql(
      `select m.last_seen_at < now() - interval '30 seconds' from public.room_members m join public.rooms r on r.id = m.room_id where r.code = '${code}' and m.user_id = '${userOf(battleId, jun.name)}'`,
    );
  for (const cat of ['rule', 'style', 'chaos']) await vote(ivo.page, cat, H);
  await expect(ivo.page.getByTestId('ballot-complete')).toBeVisible();
  // Jun was seen within 30 s, so he is still present and his ballot is still expected.
  expect(junSilent()).toBe('f');
  expect(phaseOf(battleId)).toBe('voting');
  // Nobody votes again: Jun stops counting as present 30 s after his last heartbeat, and
  // sweep_deadlines (every 5 s) re-checks the early end then (T-022). Neither the host who
  // left nor the silent Jun holds VOTING up, long before its 120 s timer.
  await expect
    .poll(() => phaseOf(battleId), { timeout: 60_000, intervals: [1_000] })
    .toBe('results');
  expect(junSilent()).toBe('t');
  // Ended by the sweep (no actor), not by a vote, with reason all_voted.
  expect(
    sql(
      `select coalesce(actor_id::text, 'system') || ' ' || (payload ->> 'reason') from public.battle_events where battle_id = '${battleId}' and type = 'phase' and payload ->> 'from' = 'voting'`,
    ),
  ).toBe('system all_voted');
  await expect(ivo.page.getByTestId('results')).toBeVisible({ timeout: 30_000 });

  // ─── Jun comes back: RESULTS tells him his pick did not count ─────────────────────
  await jun.context.setOffline(false);
  await expect(jun.page.getByTestId('results')).toBeVisible({ timeout: 60_000 });
  await expect(jun.page.getByTestId('lost-votes')).toContainText('Best Build');
  expect(votesOf(jun.name)).toBe('');
  // The tallies: the left host's partial ballot and the retried vote both count.
  expect(
    JSON.parse(
      sql(
        `select json_object_agg(id, vote_counts -> 'overall') from public.builds where battle_id = '${battleId}'`,
      ),
    ),
  ).toMatchObject({ [J]: 2, [H]: 0 });
  await expect(
    ivo.page.locator(`[data-testid=ranked-build][data-builder="${userOf(battleId, jun.name)}"]`),
  ).toHaveAttribute('data-rank', '1');

  // ─── DESTROY → lobby: Ivo hosts; Hana is among those who left ─────────────────────
  endLastLook(battleId);
  for (const p of [ivo, jun]) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: MIN });
    await expect(member(p.page, ivo.name)).toHaveAttribute('data-host', 'true');
  }
  await expect(member(ivo.page, hana.name).getByTestId('member-status')).toHaveText('left');
  await expectTerminal(battleId, {
    phase: 'destroyed',
    shipped: Object.fromEntries(all.map((p) => [p.name, `${p.name} build`])),
  });
  expectNoPageErrors(all);
  for (const p of all) await p.context.close();
});

// ─── Random chaos (seeded) ────────────────────────────────────────────────────────────

/** A small seeded PRNG (mulberry32): the same CHAOS_SEED replays the same run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random chaos (seeded): drops, refreshes, edits and ships at random on skewed clocks; no shipped build is lost @chaos-2', async ({
  browser,
}, info) => {
  test.setTimeout(7 * MIN);
  const seed = Number(process.env['CHAOS_SEED'] ?? Date.now() % 1_000_000);
  info.annotations.push({ type: 'CHAOS_SEED', description: String(seed) });
  console.log(`random chaos: CHAOS_SEED=${String(seed)}`);
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

  const skews = [-5 * MIN, 0, 5 * MIN] as const;
  const players: Player[] = [];
  for (const name of ['Lou Random', 'Max Random', 'Ned Random', 'Oz Random']) {
    players.push(await newPlayer(browser, info, name, { clockSkewMs: pick(skews) }));
  }
  const code = await gather(players);
  const battleId = await startBattle(code, players, 100);
  const shipped: Record<string, string> = {};
  const log: string[] = [];

  // Chaos until 25 s before the deadline, or until everyone shipped (BUILD then ends at
  // once: a refresh or a ship would no longer land on the BUILD screen).
  let step = 0;
  while (phaseOf(battleId) === 'building' && serverRemainingS(battleId) > 25) {
    step++;
    const p = pick(players);
    const action = shipped[p.name]
      ? pick(['drop', 'refresh'] as const)
      : pick(['drop', 'refresh', 'edit', 'edit', 'ship'] as const);
    log.push(`${String(step)} ${p.name} ${action}`);
    if (action === 'drop') {
      const ms = 3_000 + Math.floor(rnd() * 9_000);
      await p.context.setOffline(true);
      await expect(p.page.getByTestId('reconnecting')).toBeVisible();
      if (!shipped[p.name]) {
        await writeApp(p.page, `${p.name} offline ${String(step)}`, 'rgb(90, 90, 200)', {
          waitForPreview: false,
        });
      }
      await p.page.waitForTimeout(ms);
      await p.context.setOffline(false);
      await expect(p.page.getByTestId('reconnecting')).toBeHidden({ timeout: 30_000 });
    } else if (action === 'refresh') {
      await p.page.reload();
      await expect(p.page.getByTestId('build-stage')).toBeVisible({ timeout: 30_000 });
      await expect(p.page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
        timeout: 30_000,
      });
    } else if (action === 'edit') {
      await writeApp(p.page, `${p.name} edit ${String(step)}`, 'rgb(200, 90, 90)');
    } else {
      const name = `${p.name.split(' ')[0] ?? 'X'} ship ${String(step)}`;
      await ship(p.page, name, { last: Object.keys(shipped).length === players.length - 1 });
      shipped[p.name] = name;
    }
    // Whatever happened, every countdown shows the server's time.
    await expectCountdownInSync(p, battleId);
  }
  console.log(`random chaos steps: ${log.join('; ')}`);
  for (const p of players) await expectCountdownInSync(p, battleId);

  // The rest is up to the server: deadline, auto-ship, REVEAL (everyone on the same
  // spotlight), VOTING, captures, RESULTS, DESTROY. The slots and the vote are not driven:
  // their deadlines are moved to now.
  await expect
    .poll(() => phaseOf(battleId), { timeout: 2 * MIN, intervals: [1_000] })
    .toMatch(/^(reveal|voting|results)$/);
  if (phaseOf(battleId) === 'reveal') await expectSameSpotlight(players);
  await deadlineSkip(battleId);
  for (const p of players) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: 2 * MIN });
  }
  await expect
    .poll(
      () =>
        sql(
          `select count(*) from public.builds where battle_id = '${battleId}' and status in ('shipped', 'auto_shipped') and capture_status = 'pending'`,
        ),
      { timeout: 3 * MIN, intervals: [1_000] },
    )
    .toBe('0');
  endLastLook(battleId);
  for (const p of players) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: MIN });
  }
  const row = await expectTerminal(battleId, { phase: 'destroyed', shipped });
  // Everyone who did not ship had autosaved (the 30 s loop or the final autosave).
  for (const b of row.builds) {
    expect(b.status, b.builder).toBe(shipped[b.builder] ? 'shipped' : 'auto_shipped');
  }
  expectNoPageErrors(players);
  for (const p of players) await p.context.close();
});

// ─── Everyone gone at T-0 ─────────────────────────────────────────────────────────────

test('all clients closed at T-0: pg_cron alone ends BUILD, auto-ships the autosaves, runs REVEAL and VOTING, captures and reaches RESULTS @chaos-2', async ({
  browser,
}, info) => {
  test.setTimeout(6 * MIN);
  const gus = await newPlayer(browser, info, 'Gus Gone');
  const hal = await newPlayer(browser, info, 'Hal Gone');
  const ivy = await newPlayer(browser, info, 'Ivy Shipped');
  const all = [gus, hal, ivy];
  const code = await gather(all);
  const battleId = await startBattle(code, all, 60);

  await writeApp(ivy.page, 'Ivy Shipped', 'rgb(255, 193, 7)');
  await ship(ivy.page, 'Ivy Shipped');
  await writeApp(gus.page, 'Gus Autosaved', 'rgb(63, 81, 181)');
  await autosaveNow(gus.page);
  // Ivy and Gus are done (shipped, autosaved): their network goes now, well before T-0.
  // (T-021: cutting all three only after Hal's final autosave left too little margin once:
  // Gus's deadline nudge, sent a few ms before the cut on a client clock estimate a hair
  // early, reached the server 72 ms after T-0 and was logged as his action.)
  await Promise.all([gus, ivy].map((p) => p.context.setOffline(true)));
  // Hal edits once the 30 s autosave loop has run: only the final autosave (3 s before
  // the deadline, timed by the client from the server clock) can carry this edit.
  await expect
    .poll(() => serverRemainingS(battleId), { timeout: MIN, intervals: [500] })
    .toBeLessThan(20);
  await writeApp(hal.page, 'Hal Final Autosave', 'rgb(233, 30, 99)');
  const halId = userOf(battleId, hal.name);
  await expect
    .poll(() => ephemeralText(`${battleId}/${halId}/autosave/source.json`), {
      timeout: 30_000,
      intervals: [250],
    })
    .toContain('Hal Final Autosave');
  const savedAtRemainingS = serverRemainingS(battleId);
  expect(savedAtRemainingS).toBeGreaterThan(0.5);
  expect(savedAtRemainingS).toBeLessThan(3.5);

  // Every client goes before T-0: nobody can nudge the battle any more. The network goes
  // first (instant), then the contexts close: a graceful close of three pages takes
  // 2.5–3 s here, more than the ~2.7 s the final autosave leaves (measured with and without
  // T-020), so closing alone raced T-0.
  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.setOffline(true)));
  expect(serverRemainingS(battleId), 'every client was cut off before T-0').toBeGreaterThan(0);
  await Promise.all(all.map((p) => p.context.close()));

  // pg_cron (sweep_deadlines every 5 s): BUILDING → SHIPPING → (15 s grace) → REVEAL, one
  // slot per build → VOTING → RESULTS. Nobody votes (nobody is there), so no early end:
  // the slots' and the vote's deadlines are moved to now instead of waiting 4 minutes.
  await expect.poll(() => phaseOf(battleId), { timeout: MIN, intervals: [1_000] }).toBe('reveal');
  await deadlineSkip(battleId);
  expect(phaseOf(battleId)).toBe('results');
  // Every transition had no actor: nobody but the sweeper was there.
  expect(
    sql(`select string_agg((payload ->> 'to') || ':' || coalesce(actor_id::text, 'system'), ',' order by version)
           from public.battle_events
          where battle_id = '${battleId}' and type = 'phase'
            and payload ->> 'from' in ('building', 'shipping', 'reveal', 'voting')`),
  ).toBe('shipping:system,reveal:system,reveal:system,reveal:system,voting:system,results:system');
  const builds = battleRow(battleId).builds;
  expect(builds.find((b) => b.builder === gus.name)?.status).toBe('auto_shipped');
  expect(builds.find((b) => b.builder === hal.name)?.status).toBe('auto_shipped');
  expect(builds.find((b) => b.builder === ivy.name)).toMatchObject({
    status: 'shipped',
    name: 'Ivy Shipped',
  });
  // The jobs function screenshots all three.
  await expect
    .poll(
      () =>
        sql(
          `select string_agg(capture_status::text, ',') from public.builds where battle_id = '${battleId}'`,
        ),
      { timeout: 2 * MIN, intervals: [1_000] },
    )
    .toBe('captured,captured,captured');

  endLastLook(battleId);
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).toBe('destroyed');
  await expectTerminal(battleId, { phase: 'destroyed', shipped: { [ivy.name]: 'Ivy Shipped' } });
});

// ─── Abandoned ────────────────────────────────────────────────────────────────────────

test('abandoned: no roster player for 5 min; a returning player finds the battle abandoned @chaos-1', async ({
  browser,
}, info) => {
  test.setTimeout(4 * MIN);
  const jo = await newPlayer(browser, info, 'Jo Returns');
  const kai = await newPlayer(browser, info, 'Kai Gone');
  const code = await gather([jo, kai]);
  const battleId = await startBattle(code, [jo, kai], 300);
  await writeApp(kai.page, 'Kai Shipped', 'rgb(0, 188, 212)');
  await ship(kai.page, 'Kai Shipped');
  expectNoPageErrors([jo, kai]);

  // Both tabs close; Jo keeps her browser (her session), Kai is gone for good.
  await jo.page.close();
  await kai.context.close();
  // Five minutes without a heartbeat from any roster player (shortened).
  sql(`update public.room_members set last_seen_at = now() - interval '6 minutes'
        where room_id = (select room_id from public.battles where id = '${battleId}')`);
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).toBe('abandoned');
  expect(
    sql(
      `select coalesce(actor_id::text, 'system') || ':' || (payload ->> 'reason') from public.battle_events where battle_id = '${battleId}' and type = 'phase' order by version desc limit 1`,
    ),
  ).toBe('system:no_presence');

  // Jo comes back: the room is open again and the lobby says what happened.
  const page = await jo.context.newPage();
  page.on('pageerror', (e) => jo.errors.push(e.message));
  await page.goto(`/r/${code}`);
  await expect(page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
  const last = page.getByTestId('last-battle');
  await expect(last).toHaveAttribute('data-phase', 'abandoned');
  await expect(last).toContainText('abandoned');
  await expect(last).toContainText('Kai Shipped');
  await expect(page.getByTestId('last-battle-link')).toHaveCount(0);
  expect(jo.errors).toEqual([]);

  // Kai's shipped build is kept (no rank, no screenshot: nobody stayed for RESULTS).
  const row = await expectTerminal(battleId, {
    phase: 'abandoned',
    shipped: { [kai.name]: 'Kai Shipped' },
  });
  expect(row.builds.find((b) => b.builder === jo.name)?.status).toBe('draft');
  await jo.context.close();
});

// ─── Steady typing vs Realtime's presence limit ───────────────────────────────────────

test('a minute of steady typing keeps the room channel (Realtime closes channels above 5 presence messages per 30 s)', async ({
  browser,
}, info) => {
  test.setTimeout(4 * MIN);
  const pia = await newPlayer(browser, info, 'Pia Typist');
  const quinn = await newPlayer(browser, info, 'Quinn Watcher');
  // What the Realtime server tells Pia's page (it closes a channel over the limit).
  const serverErrors: string[] = [];
  pia.page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (/rate limit|"status":"error"/i.test(text)) serverErrors.push(text);
    });
  });
  const code = await gather([pia, quinn]);
  const battleId = await startBattle(code, [pia, quinn], 300);
  await openFile(pia.page, 'src/App.tsx');
  await pia.page.locator('[data-testid=code-editor] .cm-content').click();
  await pia.page.keyboard.press('ControlOrMeta+End');

  // A new line every ~1.5 s for 60 s: the activity (lines, typing) changes all the time.
  let reconnecting = 0;
  const until = Date.now() + 60_000;
  let n = 0;
  while (Date.now() < until) {
    n++;
    await pia.page.keyboard.type(`\n// line ${String(n)}`, { delay: 100 });
    reconnecting += await pia.page.getByTestId('reconnecting').count();
  }
  // Her line count (all files, as the activity counts them) once the edits are saved locally.
  let lines = 0;
  await expect
    .poll(async () => {
      const files = await storedFiles(pia.page, battleId);
      lines = Object.values(files).reduce(
        (sum, t) => sum + (t.length === 0 ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0)),
        0,
      );
      return files['src/App.tsx'] ?? '';
    })
    .toContain(`// line ${String(n)}`);
  expect(serverErrors, 'Realtime refused or closed something').toEqual([]);
  expect(reconnecting, 'Pia never lost the room channel').toBe(0);
  // Quinn sees Pia's latest line count (within the presence budget).
  await expect(progress(quinn.page, pia.name).getByTestId('activity')).toContainText(
    `${String(lines)} lines`,
    { timeout: 30_000 },
  );
  await expect(progress(quinn.page, pia.name)).toHaveAttribute('data-online', 'true');
  expectNoPageErrors([pia, quinn]);
  for (const p of [pia, quinn]) await p.context.close();
  sql(`update public.room_members set last_seen_at = now() - interval '6 minutes'
        where room_id = (select room_id from public.battles where id = '${battleId}')`);
  await expect.poll(() => phaseOf(battleId), { timeout: 30_000 }).toBe('abandoned');
  await expectTerminal(battleId, { phase: 'abandoned', shipped: {} });
});

// ─── Realtime loses the database feed ─────────────────────────────────────────────────

test('Realtime stops delivering the battle events mid-REVEAL (channels still subscribed): every page still follows the reveal, the vote and the results', async ({
  browser,
}, info) => {
  test.setTimeout(5 * MIN);
  const una = await newPlayer(browser, info, 'Una Host');
  const vic = await newPlayer(browser, info, 'Vic Deaf');
  const wes = await newPlayer(browser, info, 'Wes Deaf');
  const all = [una, vic, wes];
  // Battle events (broadcasts on the battle topic) each page receives once the feed is down.
  let counting = false;
  const battleFrames = all.map(() => 0);
  for (const [i, p] of all.entries()) {
    p.page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        const text = typeof f.payload === 'string' ? f.payload : f.payload.toString();
        if (counting && text.includes('realtime:battle:') && text.includes('"version"')) {
          battleFrames[i] = (battleFrames[i] ?? 0) + 1;
        }
      });
    });
  }
  const code = await gather(all);
  const battleId = await startBattle(code, all, 120);
  for (const [i, p] of all.entries()) {
    await ship(p.page, `${p.name} build`, { last: i === all.length - 1 });
  }
  await expect.poll(() => phaseOf(battleId), { timeout: MIN }).toBe('reveal');
  await expectSameSpotlight(all);
  const versionBefore = Number(sql(`select version from public.battles where id = '${battleId}'`));

  // From now on no battle broadcast reaches anyone (T-023: the local Realtime does this by
  // itself every 10 minutes; it made the 6- and 8-player tests fail now and then).
  dropRealtimeDatabaseFeed();
  expect(realtimeDatabaseFeedUp()).toBe(false);
  // A broadcast already on its way when the connection went down can still arrive (seen: a
  // capture event 0.6 s after the drop, T-024). Let it land before counting.
  await una.page.waitForTimeout(1_500);
  // And Realtime's own 5-minute timer must not bring the feed back mid-test (it did, 22 s
  // after the drop, whenever the test happened to run across that tick).
  const feedGuard = keepRealtimeDatabaseFeedDown();
  counting = true;
  // The jobs function screenshots the builds meanwhile: more versions nobody hears of, so
  // the host's Next is likely to go out with a stale version (resent by the controller).
  await expect
    .poll(
      () =>
        sql(
          `select count(*) from public.builds where battle_id = '${battleId}' and capture_status = 'pending'`,
        ),
      { timeout: MIN, intervals: [250] },
    )
    .toBe('0');

  // The host moves on: her own page and everyone else's learn it from the heartbeat's
  // battle version check (every 10 s), not from an event.
  const sentVersions: number[] = [];
  una.page.on('request', (r) => {
    if (r.url().endsWith('/rpc/reveal_next')) {
      sentVersions.push((r.postDataJSON() as { p_expected_version: number }).p_expected_version);
    }
  });
  await clickRouted(una.page.getByTestId('reveal-next'));
  for (const p of all) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', '1', {
      timeout: 25_000,
    });
  }
  // One click: sent once, or resent with the server's version when a capture made it stale.
  info.annotations.push({ type: 'reveal_next versions', description: sentVersions.join(',') });
  console.log(`reveal_next expected versions: ${sentVersions.join(', ')}`);
  expect(sentVersions.length).toBeGreaterThanOrEqual(1);
  expect(
    sql(
      `select count(*) from public.battle_events where battle_id = '${battleId}' and payload ->> 'reason' = 'host_next'`,
    ),
  ).toBe('1');
  await expectSameSpotlight(all);
  await clickRouted(una.page.getByTestId('skip-to-vote'));
  for (const p of all) {
    await expect(p.page.getByTestId('vote-stage')).toBeVisible({ timeout: 25_000 });
  }
  const buildOf = (name: string) =>
    sql(
      `select id from public.builds where battle_id = '${battleId}' and builder_id = '${userOf(battleId, name)}'`,
    );
  for (const [i, p] of all.entries()) {
    const pick = buildOf((all[(i + 1) % all.length] ?? una).name);
    for (const cat of ['overall', 'rule', 'style', 'chaos']) {
      const last = i === all.length - 1 && cat === 'chaos';
      const option = p.page.locator(
        `[data-testid=vote-category][data-category=${cat}] [data-testid=vote-option][data-build="${pick}"]`,
      );
      // The last pick of the last ballot ends VOTING at once.
      if (last) await option.click();
      else await vote(p.page, cat, pick);
    }
  }
  for (const p of all) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: 25_000 });
  }
  // Still no feed: the pages kept up without a single battle event.
  const restarts = await feedGuard.stop();
  info.annotations.push({ type: 'Realtime feed restarts undone', description: String(restarts) });
  expect(realtimeDatabaseFeedUp()).toBe(false);
  expect(battleFrames).toEqual([0, 0, 0]);
  expect(
    Number(sql(`select version from public.battles where id = '${battleId}'`)),
  ).toBeGreaterThanOrEqual(versionBefore + 3); // next, skip, …, results

  endLastLook(battleId);
  for (const p of all) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
  }
  await expectTerminal(battleId, {
    phase: 'destroyed',
    shipped: Object.fromEntries(all.map((p) => [p.name, `${p.name} build`])),
  });
  expectNoPageErrors(all);
  for (const p of all) await p.context.close();
});

// ─── 8 players: the largest party ─────────────────────────────────────────────────────

test('8 players, a full party battle: everyone ships, the reveal of 8 builds, everyone votes, ranked results, destroy, back in the lobby', async ({
  browser,
}, info) => {
  test.setTimeout(8 * MIN);
  const players: Player[] = [];
  for (let i = 1; i <= 8; i++) players.push(await newPlayer(browser, info, `Octo ${String(i)}`));
  const [host] = players;
  if (!host) throw new Error('no host');
  const code = await gather(players);
  await expect(host.page.getByTestId('player-count')).toHaveText('8/8 players');
  const battleId = await startBattle(code, players, 240);

  // Everyone ships the template as it is (the editor and the bundler run in 8 tabs).
  for (const [i, p] of players.entries()) {
    await ship(p.page, `${p.name} build`, { last: i === players.length - 1 });
  }
  await expect.poll(() => phaseOf(battleId), { timeout: MIN }).toBe('reveal');
  const order = sql(
    `select array_to_string(reveal_order, ',') from public.battles where id = '${battleId}'`,
  ).split(',');
  expect(order).toHaveLength(8);
  // 8 builds: round(clamp(300 / 8, 30, 60)) = 38 s per slot.
  expect(
    Number(
      sql(
        `select extract(epoch from phase_ends_at - phase_started_at)::int from public.battles where id = '${battleId}'`,
      ),
    ),
  ).toBe(38);
  await expectSameSpotlight(players);
  await clickRouted(host.page.getByTestId('reveal-next'));
  for (const p of players) {
    await expect(p.page.getByTestId('reveal-stage')).toHaveAttribute('data-index', '1');
    await expect(p.page.getByTestId('reveal-position')).toHaveText('Build 2 of 8');
  }
  await expectSameSpotlight(players);
  await clickRouted(host.page.getByTestId('skip-to-vote'));

  // Everyone votes in every category; Best Build: everyone picks the first build in the
  // reveal order (its builder picks the second one).
  for (const p of players) {
    await expect(p.page.getByTestId('vote-stage')).toBeVisible({ timeout: 30_000 });
  }
  const builderOf = (buildId: string) =>
    sql(
      `select p.display_name from public.builds b join public.battle_players p on p.battle_id = b.battle_id and p.user_id = b.builder_id where b.id = '${buildId}'`,
    );
  const first = order[0] ?? '';
  const second = order[1] ?? '';
  for (const [i, p] of players.entries()) {
    const pick = builderOf(first) === p.name ? second : first;
    for (const cat of ['overall', 'rule', 'style', 'chaos']) {
      const last = i === players.length - 1 && cat === 'chaos';
      if (last) {
        // The last pick of the last ballot ends VOTING at once.
        await p.page
          .locator(
            `[data-testid=vote-category][data-category=${cat}] [data-testid=vote-option][data-build="${pick}"]`,
          )
          .click();
      } else {
        await vote(p.page, cat, pick);
      }
    }
  }
  for (const p of players) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: MIN });
    await expect(p.page.getByTestId('ranked-build')).toHaveCount(8);
  }
  expect(
    sql(
      `select payload ->> 'reason' from public.battle_events where battle_id = '${battleId}' and type = 'phase' and payload ->> 'from' = 'voting'`,
    ),
  ).toBe('all_voted');
  await expect(host.page.locator(`[data-testid=ranked-build][data-winner=true]`)).toHaveAttribute(
    'data-total-votes',
    '28',
  ); // 7 voters × 4 categories
  expect(
    JSON.parse(sql(`select vote_counts::text from public.builds where id = '${first}'`)),
  ).toEqual({ overall: 7, rule: 7, style: 7, chaos: 7 });

  await expect
    .poll(
      () =>
        sql(
          `select count(*) from public.builds where battle_id = '${battleId}' and capture_status = 'pending'`,
        ),
      { timeout: 3 * MIN, intervals: [1_000] },
    )
    .toBe('0');
  endLastLook(battleId);
  for (const p of players) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: MIN });
  }
  await expectTerminal(battleId, {
    phase: 'destroyed',
    shipped: Object.fromEntries(players.map((p) => [p.name, `${p.name} build`])),
  });
  expectNoPageErrors(players);
  for (const p of players) await p.context.close();
});

// ─── A full room ──────────────────────────────────────────────────────────────────────

test('a full room: the 9th player spectates; with every spectator slot taken, room_full @chaos-1', async ({
  browser,
}, info) => {
  test.setTimeout(4 * MIN);
  const players: Player[] = [];
  for (let i = 1; i <= 9; i++) {
    players.push(await newPlayer(browser, info, `Guest ${String(i)}`));
  }
  const [host, second, ...rest] = players;
  const ninth = players.at(-1);
  if (!host || !second || !ninth) throw new Error('players missing');
  const code = await createRoom(host);
  for (const p of [second, ...rest]) {
    await joinByLink(p, code);
    await expect(p.page.getByTestId('lobby')).toBeVisible();
  }
  await expect(host.page.getByTestId('player-count')).toHaveText('8/8 players');
  await expect(member(host.page, ninth.name)).toHaveAttribute('data-role', 'spectator');
  await expect(ninth.page.getByTestId('spectator-note')).toBeVisible();
  await expect(ninth.page.getByTestId('ready-toggle')).toHaveCount(0);

  // 19 more spectators (made up, as the pgTAP tests do): 20 is the cap.
  const roomId = sql(`select id from public.rooms where code = '${code}'`);
  const fake = `('18f00000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid`;
  sql(`insert into auth.users (id, is_anonymous) select ${fake}, true from generate_series(1, 19) n;
       insert into public.profiles (id, display_name) select ${fake}, 'fan ' || n from generate_series(1, 19) n;
       insert into public.room_members (room_id, user_id, role)
         select '${roomId}', ${fake}, 'spectator' from generate_series(1, 19) n`);
  try {
    const tenth = await newPlayer(browser, info, 'Guest 10');
    await joinByLink(tenth, code);
    await expect(
      tenth.page.locator('[data-testid=join-error] [data-code=room_full]'),
    ).toBeVisible();
    await expect(tenth.page.getByTestId('join-error')).toContainText('This room is full');
    expectNoPageErrors([...players, tenth]);
    await tenth.context.close();
  } finally {
    sql(`delete from public.room_members where room_id = '${roomId}' and user_id::text like '18f00000-%';
         delete from public.profiles where id::text like '18f00000-%';
         delete from auth.users where id::text like '18f00000-%'`);
  }
  // A player leaves: the spectator gets the free slot.
  await second.page.getByTestId('leave-room').click();
  await expect(member(host.page, ninth.name)).toHaveAttribute('data-role', 'player');
  await expect(ninth.page.getByTestId('ready-toggle')).toBeVisible();
  for (const p of players) await p.context.close();
});
