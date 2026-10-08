import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { APP_SERVER, bodyHash, cacheStatus, sMaxAge } from './cache';
import { anonymousUserId, assertUuid, seedAdmin, sql, uploadScreenshot } from './stack';

/**
 * ISR of the permanent pages (T-026) against the real local stack, on `next start`
 * (playwright.moderation.config.ts) or on the Workers preview (`E2E_APP_SERVER=workers`: the
 * OpenNext build with R2, D1 and the Durable Object queue emulated by wrangler):
 *
 * - a settled battle (DESTROYED, `destroyed_at` set): `/battles/[id]` and its OG image come
 *   from the cache on the second request, and keep doing so while the database changes
 *   underneath; so does the builder's history data (`/u/[id]`). An admin takedown then shows
 *   "Removed by moderators" on all three at once, and the fresh copy is cached again;
 * - a battle that is not public yet: its 404 is cached for seconds only, so the page shows up
 *   once the battle reaches RESULTS.
 *
 * A settled battle is cached for an hour, so nothing here can be explained by time passing.
 * The data is inserted with psql (like e2e/moderation.spec.ts) and committed.
 */

const ADMIN_EMAIL = `isr-${String(Date.now())}@moderation.e2e`;
const ADMIN_PASSWORD = `pw-${Math.random().toString(36).slice(2)}-Aa1`;

interface Fixture {
  battle: string;
  /** Rank 1, with a PNG screenshot (on the OG card). */
  iris: { user: string; build: string };
  juno: { user: string; build: string };
}

/** Two players' battle in `phase`; `destroyed` also stamps `destroyed_at` (settled). */
async function createBattle(phase: 'destroyed' | 'building', destroyed: boolean) {
  const iris = assertUuid(await anonymousUserId());
  const juno = assertUuid(await anonymousUserId());
  const live = phase === 'building';
  const row = JSON.parse(
    sql(`
      with c as (
        insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
        values ('A cache probe', 'Two colours only', 'Newspaper', 300) returning id),
      p as (
        insert into public.profiles (id, display_name)
        values ('${iris}', 'Iris'), ('${juno}', 'Juno')
        on conflict (id) do nothing returning id),
      b as (
        insert into public.battles (challenge_id, host_id, settings, phase, version, finished_at,
                                    is_complete, building_started_at, building_ends_at,
                                    phase_ends_at, destroyed_at)
        select c.id, '${iris}', '{"mode":"solo"}', '${phase}', 9,
               ${live ? 'null' : `now() - interval '2 minutes'`}, ${live ? 'false' : 'true'},
               now() - interval '6 minutes',
               ${live ? `now() + interval '10 minutes'` : `now() - interval '3 minutes'`},
               ${live ? `now() + interval '10 minutes'` : 'null'},
               ${destroyed ? 'now()' : 'null'}
        from c returning id),
      r as (
        insert into public.battle_players (battle_id, user_id, display_name)
        select b.id, u.id, u.name from b,
          (values ('${iris}'::uuid, 'Iris'), ('${juno}'::uuid, 'Juno')) u(id, name)
        returning battle_id),
      x as (
        insert into public.builds (battle_id, builder_id, name, status, shipped_at, completion_ms,
                                   final_rank, capture_status)
        select b.id, u.id, u.name, 'shipped', now() - interval '4 minutes', u.ms, u.rank, 'failed'
        from b, (values ('${iris}'::uuid, 'Probe One', 120000, 1),
                        ('${juno}'::uuid, 'Probe Two', 180000, 2)) u(id, name, ms, rank)
        returning id, builder_id)
      select json_build_object(
        'battle', (select id from b),
        'iris', (select id from x where builder_id = '${iris}'),
        'juno', (select id from x where builder_id = '${juno}'))`),
  ) as { battle: string; iris: string; juno: string };
  return {
    battle: assertUuid(row.battle),
    iris: { user: iris, build: assertUuid(row.iris) },
    juno: { user: juno, build: assertUuid(row.juno) },
  } satisfies Fixture;
}

/** Gives Iris's build a captured PNG screenshot, like the capture worker would. */
async function addScreenshot(browser: Browser, fx: Fixture): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(
    '<body style="margin:0;background:#0ea5e9;display:grid;place-items:center;height:100vh;font:900 120px system-ui;color:#fff">PROBE</body>',
  );
  const png = new Uint8Array(await page.screenshot({ type: 'png' }));
  await page.close();
  const path = `${fx.battle}/${fx.iris.build}.png`;
  await uploadScreenshot(path, png, 'image/png');
  sql(`update public.builds set capture_status = 'captured', screenshot_path = '${path}',
         captured_at = now() where id = '${fx.iris.build}'`);
}

/** GET, asserting a 2xx/4xx answer that carries nothing per-viewer. */
async function get(request: APIRequestContext, path: string) {
  const res = await request.get(path);
  expect(res.status(), `${path} on ${APP_SERVER}`).toBeLessThan(500);
  expect(res.headers()['set-cookie'], `${path} sets no cookie`).toBeUndefined();
  return res;
}

test('a settled battle is served from the cache until a takedown revalidates it', async ({
  browser,
  request,
}) => {
  const fx = await createBattle('destroyed', true);
  await addScreenshot(browser, fx);
  const battlePath = `/battles/${fx.battle}`;
  const ogPath = `${battlePath}/opengraph-image`;
  const historyPath = `/u/${fx.iris.user}`;

  // ─── First visits fill the cache; the second request is a hit ───────────────────
  const first = await get(request, battlePath);
  expect(first.status()).toBe(200);
  expect(await first.text()).toContain('Probe One');
  const second = await get(request, battlePath);
  expect(cacheStatus(second)).toBe('HIT');
  // Settled: an hour (SETTLED_BATTLE in lib/cache/policy.ts).
  expect(sMaxAge(second)).toBeGreaterThan(3500);

  const og1 = await get(request, ogPath);
  expect(og1.headers()['content-type']).toBe('image/png');
  const ogBefore = await bodyHash(og1);
  const og2 = await get(request, ogPath);
  expect(cacheStatus(og2)).toBe('HIT');
  expect(await bodyHash(og2)).toBe(ogBefore);

  const history1 = await get(request, historyPath);
  expect(await history1.text()).toContain('Probe One');
  // A dynamic page: rendered per request (only its data is cached), never stored whole.
  expect(cacheStatus(history1)).toBeNull();
  expect(history1.headers()['cache-control']).toContain('no-store');

  // ─── The database changes underneath: the cached copies do not ──────────────────
  sql(`update public.builds set name = name || ' (renamed)' where battle_id = '${fx.battle}'`);
  const cached = await get(request, battlePath);
  expect(cacheStatus(cached)).toBe('HIT');
  const cachedHtml = await cached.text();
  expect(cachedHtml).toContain('Probe One');
  expect(cachedHtml).not.toContain('(renamed)');
  expect(await bodyHash(await get(request, ogPath))).toBe(ogBefore);
  const cachedHistory = await (await get(request, historyPath)).text();
  expect(cachedHistory).toContain('Probe One');
  expect(cachedHistory).not.toContain('(renamed)');

  // ─── An admin takes Iris's build down (it is in the report queue) ───────────────
  sql(`insert into public.reports (build_id, reporter_id, reason, details)
       values ('${fx.iris.build}', '${fx.juno.user}', 'offensive', 'ISR e2e')`);
  seedAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
  const context = await browser.newContext();
  const admin = await context.newPage();
  await admin.goto('/admin/sign-in');
  await admin.getByTestId('admin-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('admin-password').fill(ADMIN_PASSWORD);
  await admin.getByTestId('admin-sign-in-submit').click();
  await expect(admin).toHaveURL(/\/admin$/);
  const item = admin.locator(`[data-testid=report-item][data-build="${fx.iris.build}"]`);
  await item.getByTestId('admin-take-down').click();
  await item.getByTestId('admin-take-down-confirm').click();
  await expect(admin.getByTestId('admin-flash')).toHaveAttribute('data-done', 'taken_down');
  await context.close();

  // ─── At once, on the very next request of each: fresh copies ────────────────────
  // The cached copies were an hour from being old (and an old copy would still be served
  // once more, stale-while-revalidate): only the takedown's tag revalidation explains fresh
  // content here. (The response may already be a HIT of the fresh copy: the admin page's
  // link to the battle can prefetch it right after the takedown.)
  const after = await get(request, battlePath);
  const afterHtml = await after.text();
  expect(afterHtml).toContain('Removed by moderators');
  expect(afterHtml).not.toContain('Probe One');
  // A full re-render from fresh data: Juno's rename shows up too.
  expect(afterHtml).toContain('Probe Two (renamed)');

  expect(await bodyHash(await get(request, ogPath))).not.toBe(ogBefore);

  const historyAfter = await (await get(request, historyPath)).text();
  expect(historyAfter).toContain('Removed by moderators');
  expect(historyAfter).not.toContain('Probe One');

  // ─── …and the fresh copies are cached again ─────────────────────────────────────
  const again = await get(request, battlePath);
  expect(cacheStatus(again)).toBe('HIT');
  expect(await again.text()).toContain('Removed by moderators');
  expect(cacheStatus(await get(request, ogPath))).toBe('HIT');
});

test('a battle that is not public yet is not cached as a 404 for good', async ({ request }) => {
  const fx = await createBattle('building', false);
  const battlePath = `/battles/${fx.battle}`;

  const missing = await get(request, battlePath);
  expect(missing.status()).toBe(404);
  const cachedMissing = await get(request, battlePath);
  expect(cachedMissing.status()).toBe(404);
  expect(cacheStatus(cachedMissing)).toBe('HIT');
  // Seconds, not the hour of a settled battle. (`next start` says so in s-maxage; OpenNext
  // sends `no-store` with every 404, whatever its own copy's lifetime.)
  if (APP_SERVER === 'next start') expect(sMaxAge(cachedMissing)).toBe(5);

  // The battle reaches RESULTS: the page shows up within seconds (one more request may
  // still get the cached 404 while it regenerates).
  sql(`update public.battles set phase = 'results', finished_at = now(), is_complete = true,
         building_ends_at = now() - interval '1 minute', phase_ends_at = now() + interval '1 hour'
       where id = '${fx.battle}'`);
  await expect
    .poll(async () => (await get(request, battlePath)).status(), {
      timeout: 30_000,
      intervals: [1_000],
    })
    .toBe(200);
  const live = await get(request, battlePath);
  expect(await live.text()).toContain('Probe One');
  // RESULTS can still change (screenshots, then destroyed_at): seconds again.
  expect(sMaxAge(live)).toBeLessThanOrEqual(5);
});
