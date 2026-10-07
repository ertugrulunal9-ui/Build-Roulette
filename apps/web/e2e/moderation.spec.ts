import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  anonymousUserId,
  assertUuid,
  publicScreenshotUrl,
  seedAdmin,
  sql,
  uploadScreenshot,
} from './stack';

/**
 * Moderation end to end (T-024) against the real local stack, with the capture worker
 * running (playwright.moderation.config.ts):
 *
 *   a player reports a build on /battles/[id] → the admin signs in at /admin, sees the
 *   report and takes the build down → the public page shows "Removed by moderators" and no
 *   screenshot → the capture worker's takedown job deletes the screenshot object.
 *
 * Plus: /admin is a plain 404 for a player (and without a session, and after a failed
 * sign-in), and a blocked display name gets the friendly error.
 *
 * The finished battle is inserted with psql (two builds with real PNG screenshots in the
 * public bucket), so the test does not need a whole game. MODERATION_SCREENSHOT_DIR=/dir
 * saves the UI screenshots (report dialog, admin queue, battle log, removed build).
 */

const SHOTS = process.env['MODERATION_SCREENSHOT_DIR'];
const ADMIN_EMAIL = `mod-${String(Date.now())}@moderation.e2e`;
const ADMIN_PASSWORD = `pw-${Math.random().toString(36).slice(2)}-Aa1`;

async function snap(page: Page, name: string, fullPage = false): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t024-${name}.png`, fullPage });
}

interface Fixture {
  battle: string;
  scam: { id: string; path: string };
  timer: { id: string; path: string };
}

/** A 1280×800 "screenshot" of a little page, rendered by the browser. */
async function renderShot(browser: Browser, html: string): Promise<Uint8Array> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(html);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return new Uint8Array(png);
}

async function createFixture(browser: Browser): Promise<Fixture> {
  const mallory = await anonymousUserId();
  const ana = await anonymousUserId();
  const row = JSON.parse(
    sql(`
      with c as (
        insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
        values ('A pomodoro timer', 'Only one button', 'Brutalist', 300) returning id),
      p as (
        insert into public.profiles (id, display_name)
        values ('${assertUuid(mallory)}', 'Mallory'), ('${assertUuid(ana)}', 'Ana')
        on conflict (id) do nothing returning id),
      b as (
        insert into public.battles (challenge_id, host_id, settings, phase, version, finished_at,
                                    is_complete, building_started_at, building_ends_at, phase_ends_at)
        select c.id, '${ana}', '{"mode":"multiplayer","reveal_vote":false}', 'results', 8, now(), true,
               now() - interval '6 minutes', now() - interval '1 minute', now() + interval '1 hour'
        from c returning id),
      r as (
        insert into public.battle_players (battle_id, user_id, display_name)
        select b.id, u.id, u.name from b,
          (values ('${mallory}'::uuid, 'Mallory'), ('${ana}'::uuid, 'Ana')) u(id, name)
        returning battle_id),
      x as (
        insert into public.builds (battle_id, builder_id, name, status, shipped_at, completion_ms,
                                   final_rank, capture_status)
        select b.id, u.id, u.name, 'shipped', now() - interval '2 minutes', u.ms, u.rank, 'captured'
        from b, (values ('${mallory}'::uuid, 'Free Gift Card', 150000, 1),
                        ('${ana}'::uuid, 'Pomodoro Pal', 210000, 2)) u(id, name, ms, rank)
        returning id, builder_id, battle_id)
      select json_build_object(
        'battle', (select id from b),
        'scam', (select id from x where builder_id = '${mallory}'),
        'timer', (select id from x where builder_id = '${ana}'))`),
  ) as { battle: string; scam: string; timer: string };
  const battle = assertUuid(row.battle);
  const fx: Fixture = {
    battle,
    scam: { id: assertUuid(row.scam), path: `${battle}/${row.scam}.png` },
    timer: { id: assertUuid(row.timer), path: `${battle}/${row.timer}.png` },
  };
  sql(`update public.builds set screenshot_path = case id
         when '${fx.scam.id}' then '${fx.scam.path}' else '${fx.timer.path}' end
       where battle_id = '${battle}'`);
  // A battle_events timeline like a real battle's (for the admin event log).
  sql(`insert into public.battle_events (battle_id, version, type, actor_id, payload, created_at) values
    ('${battle}', 1, 'phase', '${ana}', '{"from":null,"to":"spinning","mode":"multiplayer"}', now() - interval '7 minutes'),
    ('${battle}', 2, 'phase', null, '{"from":"spinning","to":"building"}', now() - interval '6 minutes'),
    ('${battle}', 3, 'ship', '${mallory}', '{"name":"Free Gift Card","completion_ms":150000}', now() - interval '4 minutes'),
    ('${battle}', 4, 'ship', '${ana}', '{"name":"Pomodoro Pal","completion_ms":210000}', now() - interval '3 minutes'),
    ('${battle}', 5, 'phase', null, '{"from":"building","to":"shipping","early":true}', now() - interval '3 minutes'),
    ('${battle}', 6, 'phase', null, '{"from":"shipping","to":"results"}', now() - interval '3 minutes'),
    ('${battle}', 7, 'capture', null, '{"build_id":"${fx.scam.id}","capture_status":"captured"}', now() - interval '2 minutes'),
    ('${battle}', 8, 'capture', null, '{"build_id":"${fx.timer.id}","capture_status":"captured"}', now() - interval '2 minutes')`);

  const scamShot = await renderShot(
    browser,
    `<body style="margin:0;font:600 28px system-ui;background:#fde047;display:grid;place-items:center;height:100vh">
       <div style="background:#fff;padding:48px;border-radius:24px;box-shadow:0 10px 40px #0003;text-align:center">
         <div style="font-size:72px">🎁</div><div style="font-size:56px;font-weight:900">FREE GIFT CARD</div>
         <div style="margin:16px 0">Log in with your email password to claim it!</div>
         <div style="border:3px solid #111;border-radius:12px;padding:12px 24px;color:#999">password</div>
       </div></body>`,
  );
  const timerShot = await renderShot(
    browser,
    `<body style="margin:0;font:700 32px system-ui;background:#111;color:#fff;display:grid;place-items:center;height:100vh">
       <div style="text-align:center"><div style="font-size:160px">🍅</div>
       <div style="font-size:120px;font-family:monospace">24:59</div>
       <div style="border:6px solid #fff;padding:16px 48px;margin-top:24px">START</div></div></body>`,
  );
  await uploadScreenshot(fx.scam.path, scamShot, 'image/png');
  await uploadScreenshot(fx.timer.path, timerShot, 'image/png');
  return fx;
}

function screenshotObjects(path: string): number {
  return Number(
    sql(
      `select count(*) from storage.objects where bucket_id = 'screenshots' and name = '${path}'`,
    ),
  );
}

test('report → admin takedown → "Removed by moderators" and the screenshot is deleted', async ({
  browser,
}) => {
  const fx = await createFixture(browser);
  expect(screenshotObjects(fx.scam.path)).toBe(1);

  // ─── A player reports the scam build on the public results page ─────────────────
  const player = await browser.newContext();
  const page = await player.newPage();
  await page.goto(`/battles/${fx.battle}`);
  const scamCard = page.locator(`[data-testid=public-build][data-build="${fx.scam.id}"]`);
  await expect(scamCard.getByTestId('public-build-name')).toContainText('Free Gift Card');
  await expect(scamCard.getByTestId('public-screenshot')).toBeVisible();
  await scamCard.getByTestId('report-build').click();
  // Every report button has its own dialog; the open one is the scam build's.
  const dialog = page.locator('dialog[open][data-testid=report-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('“Free Gift Card” by Mallory');
  await dialog.getByTestId('report-reason-phishing').check();
  await dialog
    .getByTestId('report-details')
    .fill('Asks for my email password to "claim" a gift card.');
  await snap(page, 'report-dialog');
  await dialog.getByTestId('report-submit').click();
  await expect(page.getByTestId('report-thanks')).toContainText('Thanks for the report');
  await page.getByTestId('report-close').click();
  await expect(scamCard.getByTestId('report-build')).toHaveText(/Reported/);
  expect(
    sql(`select reason || ':' || status from public.reports where build_id = '${fx.scam.id}'`),
  ).toBe('phishing:open');

  // ─── /admin is a plain 404 for that player (and for nobody signed in) ───────────
  const notFound = await page.goto('/admin');
  expect(notFound?.status()).toBe(404);
  await expect(page.getByText('This page could not be found.')).toBeVisible();
  await expect(page.getByText('Moderation')).toHaveCount(0);
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  expect((await strangerPage.goto('/admin'))?.status()).toBe(404);
  expect((await strangerPage.goto('/admin?q=K7QXM'))?.status()).toBe(404);
  await stranger.close();

  // ─── The admin signs in ─────────────────────────────────────────────────────────
  seedAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
  const mod = await browser.newContext();
  const admin = await mod.newPage();
  await admin.goto('/admin/sign-in');
  await admin.getByTestId('admin-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('admin-password').fill('wrong-password');
  await admin.getByTestId('admin-sign-in-submit').click();
  await expect(admin.getByTestId('admin-sign-in-error')).toBeVisible();
  expect((await admin.goto('/admin'))?.status()).toBe(404);
  await admin.goto('/admin/sign-in');
  await admin.getByTestId('admin-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('admin-password').fill(ADMIN_PASSWORD);
  await admin.getByTestId('admin-sign-in-submit').click();
  await expect(admin).toHaveURL(/\/admin$/);

  // ─── The report is in the queue ─────────────────────────────────────────────────
  const item = admin.locator(`[data-testid=report-item][data-build="${fx.scam.id}"]`);
  await expect(item.getByTestId('report-item-name')).toHaveText('Free Gift Card');
  await expect(item.getByTestId('report-item-reasons')).toContainText('Phishing or scam × 1');
  await expect(item.getByTestId('report-item-reports')).toContainText('to "claim" a gift card');
  await expect(item.getByTestId('report-item-screenshot')).toBeVisible();
  await snap(admin, 'admin-queue');

  // ─── Take it down ───────────────────────────────────────────────────────────────
  await item.getByTestId('admin-take-down').click();
  await item.getByTestId('admin-take-down-note').fill('Phishing form (e2e)');
  await item.getByTestId('admin-take-down-confirm').click();
  await expect(admin.getByTestId('admin-flash')).toHaveAttribute('data-done', 'taken_down');
  await expect(admin.locator(`[data-testid=report-item][data-build="${fx.scam.id}"]`)).toHaveCount(
    0,
  );
  await expect(
    admin.locator('[data-testid=admin-action][data-action=take_down_build]').first(),
  ).toContainText(ADMIN_EMAIL);

  // ─── The battle's event log ─────────────────────────────────────────────────────
  await admin.getByTestId('admin-lookup-input').fill(fx.battle);
  await admin.getByTestId('admin-lookup-submit').click();
  const log = admin.getByTestId('admin-battle-log');
  await expect(log).toHaveAttribute('data-battle', fx.battle);
  await expect(log.getByTestId('log-event')).toHaveCount(9);
  await expect(log.locator('[data-testid=log-event]').last()).toHaveAttribute(
    'data-type',
    'takedown',
  );
  await expect(
    log.locator(`[data-testid=admin-build][data-build="${fx.scam.id}"]`),
  ).toHaveAttribute('data-taken-down', 'true');
  await snap(admin, 'admin-battle-log', true);

  // ─── The public page: "Removed by moderators", no screenshot ────────────────────
  await page.goto(`/battles/${fx.battle}`);
  await expect(scamCard).toHaveAttribute('data-removed', 'true');
  await expect(scamCard.getByTestId('public-build-name')).toContainText('Removed by moderators');
  await expect(scamCard.getByTestId('public-build-name')).not.toContainText('Free Gift Card');
  await expect(scamCard.getByTestId('removed-build')).toBeVisible();
  await expect(scamCard.getByTestId('public-screenshot')).toHaveCount(0);
  await expect(scamCard.getByTestId('report-build')).toHaveCount(0);
  await expect(scamCard).toHaveAttribute('data-rank', '1'); // the results stay consistent
  await expect(page.getByTestId('public-screenshot')).toHaveCount(1); // Ana's is untouched
  await snap(page, 'removed-build');

  // ─── The capture worker deletes the screenshot object ───────────────────────────
  await expect.poll(() => screenshotObjects(fx.scam.path), { timeout: 60_000 }).toBe(0);
  expect(screenshotObjects(fx.timer.path)).toBe(1);
  const gone = await fetch(publicScreenshotUrl(fx.scam.path));
  expect(gone.status).toBeGreaterThanOrEqual(400);
  expect(
    sql(
      `select status || ':' || (select (storage_deleted_at is not null)::text from private.build_takedowns where build_id = '${fx.scam.id}')
         from public.jobs where kind = 'takedown' and ref_id = '${fx.scam.id}'`,
    ),
  ).toBe('done:true');

  await mod.close();
  await player.close();
});

test('a blocked display name gets the friendly error', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('create-room').click();
  await page.getByTestId('host-name').fill('Sh1t Lord');
  await page.getByTestId('create-room-submit').click();
  await expect(page.getByTestId('create-room-form').getByRole('alert')).toHaveText(
    'That name is not allowed here. Pick another one.',
  );
  await expect(page).toHaveURL(/\/$/);
  // An innocent name with a "bad" substring is fine (whole-word rule).
  await page.getByTestId('host-name').fill('Scunthorpe Fan');
  await page.getByTestId('create-room-submit').click();
  await expect(page).toHaveURL(/\/r\/[A-HJ-NP-Z2-9]{5}$/);

  await page.goto('/play');
  await page.getByTestId('display-name').fill('F u c k');
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toHaveText(
    'That name is not allowed here. Pick another one.',
  );
});
