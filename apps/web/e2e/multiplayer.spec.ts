import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { buildFrame, clickRouted, replaceEditorText } from './helpers';
import { sql } from './stack';

/**
 * Rooms end to end (playwright.multi.config.ts): several browser contexts, each one an
 * anonymous player, against the real local Supabase stack with Realtime and the capture
 * worker. Deadlines are forced with psql as the superuser, like the solo e2e.
 *
 * MULTI_SCREENSHOT_DIR=/some/dir also saves UI screenshots (t017-*.png).
 */

const SHOTS = process.env['MULTI_SCREENSHOT_DIR'];

interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

async function snap(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t017-${name}.png` });
}

/** A fresh browser context: its own storage, so its own anonymous user. */
async function newPlayer(browser: Browser, info: TestInfo, name: string): Promise<Player> {
  const baseURL = info.project.use.baseURL;
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { name, context, page, errors };
}

/** Opens the invite link and joins with `name` (no profile yet: the name prompt). */
async function joinByLink(p: Player, code: string): Promise<void> {
  await p.page.goto(`/r/${code}`);
  const input = p.page.getByTestId('display-name');
  await expect(input).not.toHaveValue(''); // a fun default
  await input.fill(p.name);
  await p.page.getByTestId('join-room').click();
}

const member = (page: Page, name: string) =>
  page.locator(`[data-testid=member][data-name="${name}"]`);
const progress = (page: Page, name: string) =>
  page.locator(`[data-testid=progress-player][data-name="${name}"]`);

async function openFile(page: Page, path: string): Promise<void> {
  await page.locator(`[data-testid=file-item][data-path="${path}"] > button`).first().click();
  await expect(page.getByTestId('active-file')).toHaveText(path);
}

/** SPIN is over and the template's first preview is up. */
async function waitForBuild(page: Page): Promise<void> {
  await expect(page.getByTestId('spin')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('build-stage')).toBeVisible();
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
    timeout: 30_000,
  });
}

async function writeApp(page: Page, title: string, background: string): Promise<void> {
  await openFile(page, 'src/App.tsx');
  await replaceEditorText(
    page,
    `export function App() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', background: '${background}', color: 'white' }}>
      <h1 className="e2e-title">${title}</h1>
    </main>
  );
}
`,
  );
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText(title);
}

async function ship(page: Page, name: string): Promise<void> {
  await page.getByTestId('ship-button').click();
  await page.getByTestId('build-name').fill(name);
  // The dialog is drawn over the cross-site preview iframe (see clickRouted).
  await clickRouted(page.getByTestId('confirm-ship'));
  // Shipped: the dialog closes; a banner says the build is locked.
  await expect(page.getByTestId('shipped-banner')).toContainText(`Shipped “${name}”`);
  await expect(page.getByTestId('ship-dialog')).toBeHidden();
}

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** The workspace text of `path` stored in this page's IndexedDB under `battle:{id}`. */
async function storedFile(page: Page, battleId: string, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ key, path }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('br-workspaces');
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = () => {
          reject(new Error('open failed'));
        };
      });
      const tx = db.transaction('workspaces', 'readonly');
      const value = await new Promise<unknown>((resolve) => {
        const r = tx.objectStore('workspaces').get(key);
        r.onsuccess = () => {
          resolve(r.result as unknown);
        };
      });
      db.close();
      const files = (value as { files?: Record<string, string> } | undefined)?.files;
      return files?.[path] ?? null;
    },
    { key: `battle:${battleId}`, path },
  );
}

const battleOf = (code: string) =>
  sql(`select current_battle_id from public.rooms where code = '${code}'`);
const phaseOf = (battleId: string) =>
  sql(`select phase from public.battles where id = '${battleId}'`);

test('a 3-player room: lobby → battle → ship and auto-ship → ranked results → destroy → rematch', async ({
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
  await writeApp(bob.page, 'Bob Turtle', 'rgb(30, 64, 175)');
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

  // ─── RESULTS: three ranked builds with real screenshots and the right awards ──────
  for (const p of [host, bob, cleo, dave]) {
    await expect(p.page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
    await expect(p.page.getByTestId('ranked-build')).toHaveCount(3);
  }
  const ids = Object.fromEntries(
    sql(
      `select string_agg(builder_id || '=' || p.display_name, ',') from public.builds b join public.battle_players p using (battle_id) where b.battle_id = '${battleId}' and p.user_id = b.builder_id`,
    )
      .split(',')
      .map((pair) => pair.split('=').reverse()),
  ) as Record<string, string>;
  const row = (page: Page, who: Player) =>
    page.locator(`[data-testid=ranked-build][data-builder="${ids[who.name] ?? 'missing'}"]`);
  for (const p of [host, dave]) {
    await expect(row(p.page, host)).toHaveAttribute('data-rank', '1');
    await expect(row(p.page, host)).toHaveAttribute('data-status', 'shipped');
    await expect(row(p.page, bob)).toHaveAttribute('data-rank', '2');
    await expect(row(p.page, bob)).toHaveAttribute('data-status', 'shipped');
    await expect(row(p.page, cleo)).toHaveAttribute('data-rank', '3');
    await expect(row(p.page, cleo)).toHaveAttribute('data-status', 'auto_shipped');
    await expect(row(p.page, cleo).getByTestId('status-badge')).toHaveText('Auto-shipped');
    await expect(row(p.page, host).getByTestId('award')).toHaveCount(2);
    await expect(row(p.page, host).locator('[data-award=speedrun]')).toBeVisible();
    await expect(row(p.page, host).locator('[data-award=fastest_ship]')).toBeVisible();
    await expect(row(p.page, bob).getByTestId('award')).toHaveCount(0);
    await expect(row(p.page, cleo).getByTestId('award')).toHaveCount(0);
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
  const reveal = (page: Page) =>
    page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe').locator('h1.e2e-title');
  await expect(reveal(host.page)).toHaveText('Ada Rocket');
  await expect(reveal(cleo.page)).toHaveText('Cleo Autosave');
  await expect(dave.page.locator('[data-testid=reveal-frame]')).toHaveCount(0);
  await snap(host.page, 'results');

  // ─── DESTROY for everyone, back in the lobby ──────────────────────────────────────
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
  for (const p of [host, bob, cleo, dave]) {
    await expect(p.page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
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
