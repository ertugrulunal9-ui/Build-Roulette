import { expect, test } from '@playwright/test';
import { screenshotPng } from '../scripts/measure-cpu/fixtures';
import { MockSupabase, startPagesDev, writePreviewVariant } from '../scripts/preview-variant';
import { watchCsp } from './csp';
import { STATIC_CARD } from './helpers';
import { crawl, one, type CrawlerView } from './link-preview';
import { anonymousUserId, assertUuid, publicScreenshotUrl, sql, uploadScreenshot } from './stack';

/**
 * Per-battle link previews (T-038): the Pages Function on `/battles/*` (out/_worker.js) as
 * `wrangler pages dev` runs it, against the real local stack (playwright.moderation.config.ts).
 *
 * - A crawler (a plain request, no script) gets the battle's own head: title, `og:*` with the
 *   rank-1 screenshot, `og:url` / canonical, `twitter:card`; user data in it is escaped.
 * - The page itself still renders in a browser, under the CSP.
 * - An unknown, not-yet-public or malformed id: a real 404, and the browser still shows the
 *   page's not-found view.
 * - Supabase slow or down: 200 with the shell's default head (fail open), on a variant of the
 *   site whose Function points at a stand-in (scripts/preview-variant.ts).
 * - Only `/battles/*` runs the Function.
 *
 * The takedown of rank 1 (the static card, no winner named on the next request) is checked in
 * the real moderation flow: moderation.spec.ts.
 */

// Names are user data and challenge texts deck data: a build name that tries to close the
// attribute and open a script, a builder name with markup and an entity, a challenge with
// quotes. All within the database's limits (48 / 24 characters).
const ATTACK = '"><script>alert(1)</script>';
const BUILDER = 'Ana <b>&amp;</b>';
const CHALLENGE = 'A "quoted" <timer> & co';

interface Fixture {
  battle: string;
  shotPath: string;
  runnerUpShot: string;
  notPublic: string;
}

let fx: Fixture;

test.beforeAll(async () => {
  const ana = assertUuid(await anonymousUserId());
  const bo = assertUuid(await anonymousUserId());
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const row = JSON.parse(
    sql(`
      with c as (
        insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
        values (${q(CHALLENGE)}, 'Only one button', 'Brutalist', 300) returning id),
      p as (
        insert into public.profiles (id, display_name)
        values ('${ana}', ${q(BUILDER)}), ('${bo}', 'Bo')
        on conflict (id) do nothing returning id),
      b as (
        insert into public.battles (challenge_id, host_id, settings, phase, version, finished_at,
                                    is_complete, building_started_at, building_ends_at,
                                    phase_ends_at, destroyed_at)
        select c.id, '${ana}', '{"mode":"multiplayer"}', 'destroyed', 9,
               now() - interval '3 minutes', true, now() - interval '9 minutes',
               now() - interval '4 minutes', null, now()
        from c returning id),
      r as (
        insert into public.battle_players (battle_id, user_id, display_name)
        select b.id, u.id, u.name from b,
          (values ('${ana}'::uuid, ${q(BUILDER)}), ('${bo}'::uuid, 'Bo')) u(id, name)
        returning battle_id),
      x as (
        insert into public.builds (battle_id, builder_id, name, status, shipped_at, completion_ms,
                                   final_rank, capture_status, total_votes)
        select b.id, u.id, u.name, 'shipped', now() - interval '5 minutes', u.ms, u.rank,
               'captured', u.votes
        from b, (values ('${ana}'::uuid, ${q(ATTACK)}, 150000, 1, 2),
                        ('${bo}'::uuid, 'Second Place', 210000, 2, 1)) u(id, name, ms, rank, votes)
        returning id, final_rank)
      select json_build_object(
        'battle', (select id from b),
        'top', (select id from x where final_rank = 1),
        'second', (select id from x where final_rank = 2))`),
  ) as { battle: string; top: string; second: string };
  const battle = assertUuid(row.battle);
  const shotPath = `${battle}/${assertUuid(row.top)}.png`;
  const runnerUpShot = `${battle}/${assertUuid(row.second)}.png`;
  await uploadScreenshot(shotPath, screenshotPng(3), 'image/png');
  await uploadScreenshot(runnerUpShot, screenshotPng(5), 'image/png');
  sql(`update public.builds set screenshot_path = case final_rank
         when 1 then '${shotPath}' else '${runnerUpShot}' end
       where battle_id = '${battle}'`);
  // A battle still being built: not public yet (get_public_battle: RESULTS or later).
  const notPublic = sql(`
    with c as (
      insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
      values ('Not public yet', 'Rule', 'Style', 300) returning id)
    insert into public.battles (challenge_id, host_id, settings, phase, version,
                                building_started_at, building_ends_at, phase_ends_at)
    select c.id, '${ana}', '{"mode":"solo"}', 'building', 2, now(),
           now() + interval '5 minutes', now() + interval '5 minutes'
    from c returning id`);
  fx = { battle, shotPath, runnerUpShot, notPublic: assertUuid(notPublic) };
});

/** The default head the shell carries (app/battles/page.tsx): what fail-open serves. */
function expectShellDefaults(view: CrawlerView): void {
  expect(view.titles).toEqual(['Battle results · Build Roulette']);
  expect(one(view, 'og:title')).toBe('Battle results');
  expect(one(view, 'og:image')).toMatch(STATIC_CARD);
  expect(one(view, 'twitter:card')).toBe('summary_large_image');
}

test('a crawler gets the battle’s own preview: title, og:*, the rank-1 screenshot, canonical', async ({
  request,
  baseURL,
}) => {
  const view = await crawl(request, `/battles/${fx.battle}`);
  expect(view.status).toBe(200);
  expect(view.headers['x-br-preview']).toBe('battle');
  expect(view.headers['content-type']).toMatch(/^text\/html/);
  // The `_headers` policy holds for the Function's answers too (it sets the same headers).
  expect(view.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(view.headers['content-security-policy']).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(view.headers['x-frame-options']).toBe('DENY');
  expect(view.headers['x-content-type-options']).toBe('nosniff');
  // Never cached: the next request reads Supabase again (a takedown shows at once).
  expect(view.headers['cache-control']).toMatch(/max-age=0|no-cache|no-store/);
  expect(view.headers['etag']).toBeUndefined();

  const name = `${ATTACK} by ${BUILDER}`;
  expect(view.titles).toEqual([`${name} · Build Roulette`]);
  expect(one(view, 'og:title')).toBe(name);
  expect(one(view, 'twitter:title')).toBe(name);
  const description = one(view, 'og:description');
  expect(description).toBe(
    `Winner: ${name}. BUILD: ${CHALLENGE} · RULE: Only one button · STYLE: Brutalist · 5 min`,
  );
  expect(one(view, 'description')).toBe(description);
  expect(one(view, 'twitter:description')).toBe(description);
  const image = publicScreenshotUrl(fx.shotPath);
  expect(one(view, 'og:image')).toBe(image);
  expect(one(view, 'twitter:image')).toBe(image);
  expect(one(view, 'og:image:width')).toBe('1280');
  expect(one(view, 'og:image:height')).toBe('800');
  expect(one(view, 'og:image:type')).toBe('image/png');
  expect(one(view, 'og:type')).toBe('article');
  expect(one(view, 'twitter:card')).toBe('summary_large_image');
  const url = `${baseURL ?? ''}/battles/${fx.battle}`;
  expect(one(view, 'og:url')).toBe(url);
  expect(view.canonical).toEqual([url]);
  expect(view.meta['robots']).toBeUndefined();
  // The shell's generic tags are gone, not left next to the battle's (`one` checks there is
  // a single value of each key).
  expect(view.meta['og:image:alt']).toEqual([`Screenshot of ${name}`]);
  // The data is escaped: the raw name never appears, so it opens no element.
  expect(view.html).not.toContain(ATTACK);
  expect(view.html).not.toContain('<b>&amp;</b>');
  expect(view.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  // The image a crawler then fetches is there.
  const shot = await request.get(image);
  expect(shot.status()).toBe(200);
  expect(shot.headers()['content-type']).toBe('image/png');
});

test('the page still renders in a browser, under the CSP, and runs nothing from the data', async ({
  page,
}) => {
  const csp = watchCsp(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const res = await page.goto(`/battles/${fx.battle}`);
  expect(res?.status()).toBe(200);
  const top = page.locator('[data-testid=public-build][data-rank="1"]');
  await expect(top.getByTestId('public-build-name')).toContainText(ATTACK);
  await expect(top).toHaveAttribute('data-winner', 'true');
  await expect(page).toHaveTitle(`${ATTACK} by ${BUILDER} · Build Roulette`);
  await expect(page.getByTestId('battle-title')).toHaveText(CHALLENGE);
  expect(dialogs).toEqual([]);
  expect(csp).toEqual([]);
});

test('an unknown or not-yet-public battle: a real 404, and the browser shows the not-found view', async ({
  request,
  page,
}) => {
  for (const id of ['00000000-0000-4000-8000-0000000038ff', fx.notPublic]) {
    const view = await crawl(request, `/battles/${id}`);
    expect(view.status, id).toBe(404);
    expect(view.headers['x-br-preview']).toBe('not-found');
    expect(view.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(view.titles).toEqual(['Battle not found · Build Roulette']);
    expect(one(view, 'og:title')).toBe('Battle not found');
    expect(one(view, 'robots')).toBe('noindex');
    expect(one(view, 'og:image')).toMatch(STATIC_CARD);
    expect(view.canonical).toEqual([]);

    const csp = watchCsp(page);
    const res = await page.goto(`/battles/${id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByTestId('battle-not-found')).toBeVisible();
    await expect(page).toHaveTitle('Battle not found · Build Roulette');
    expect(csp).toEqual([]);
  }
});

test('a malformed id: 404 at once, without asking Supabase, and the not-found view', async ({
  request,
  page,
}) => {
  for (const path of ['/battles/not-a-battle', '/battles/%22%3E%3Cscript%3Ealert(1)']) {
    const view = await crawl(request, path);
    expect(view.status, path).toBe(404);
    expect(view.headers['x-br-preview']).toBe('malformed');
    expect(view.titles).toEqual(['Battle not found · Build Roulette']);
    expect(view.html).not.toContain('<script>alert(1)');
  }
  const res = await page.goto('/battles/not-a-battle');
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('battle-not-found')).toBeVisible();
});

test('only /battles/* runs the Function', async ({ request }) => {
  for (const path of ['/', '/battles', '/u/x', '/r/K7QXM', '/play', '/nope', '/og-card.png']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()['x-br-preview'], path).toBeUndefined();
  }
  // A deeper path under /battles reaches the Function, which leaves it to Pages (the 404 page).
  const deep = await request.get(`/battles/${fx.battle}/extra`, { maxRedirects: 0 });
  expect(deep.status()).toBe(404);
  expect(deep.headers()['x-br-preview']).toBeUndefined();
});

test('Supabase slow or down: 200 with the shell’s default head (fail open)', async ({
  request,
}, info) => {
  const mock = new MockSupabase();
  await mock.start();
  const dir = info.outputPath('site-outage');
  await writePreviewVariant(dir, mock.url);
  const site = await startPagesDev(dir, 3197);
  try {
    const path = `${site.origin}/battles/${fx.battle}`;
    // Hangs: the Function gives up after 1.5 s and serves the plain shell.
    await mock.setMode('hang');
    const slow = await crawl(request, path);
    expect(slow.status).toBe(200);
    expect(slow.headers['x-br-preview']).toBe('fail-open; reason=timeout');
    expect(slow.ms).toBeGreaterThanOrEqual(1_400);
    expect(slow.ms).toBeLessThan(5_000);
    expectShellDefaults(slow);
    expect(slow.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Answers with an error.
    await mock.setMode('error');
    const failing = await crawl(request, path);
    expect(failing.status).toBe(200);
    expect(failing.headers['x-br-preview']).toBe('fail-open; reason=error');
    expectShellDefaults(failing);
    // Refuses connections.
    await mock.setMode('refuse');
    const down = await crawl(request, path);
    expect(down.status).toBe(200);
    expect(down.headers['x-br-preview']).toBe('fail-open; reason=error');
    expectShellDefaults(down);
    // A malformed id is still a 404: it never needed Supabase.
    const malformed = await crawl(request, `${site.origin}/battles/nope`);
    expect(malformed.status).toBe(404);
  } finally {
    await site.stop();
    await mock.stop();
  }
});
