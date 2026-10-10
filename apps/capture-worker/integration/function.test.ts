/**
 * The `jobs` Edge Function (T-034) for real: the local Edge Runtime (`supabase functions
 * serve`) runs supabase/functions/jobs, which calls the Browser Rendering stand-in
 * (src/stand-in.ts: Playwright Chromium on this machine), which opens the shell's signed
 * capture page, which loads the bundle from Storage; the WebP goes to the `screenshots`
 * bucket. Players play solo battles through the HTTP APIs, as in stack.test.ts.
 *
 *   alice  React build                         → captured (WebP 1280×800, budget counted)
 *   bob    throwing bundle + client thumbnail  → fallback (the page reports nothing painted)
 *   carol  budget spent                        → fallback, Browser Rendering not called
 *   dave   429 with a short Retry-After        → retried in the same run, captured
 *   erin   429 with a long Retry-After         → handed back twice, thumbnail on attempt 3
 *   frank  the function is killed mid-capture  → the lease expires, the next run captures
 *   then every battle is destroyed (files deleted), alice's build is taken down (screenshot
 *   deleted), and pg_cron's trigger (private.run_jobs_function → pg_net) runs the function
 *   with the cron secret from Vault.
 *
 *   pnpm --filter @br/capture-worker test:function
 *
 * Needs the stack WITH the Edge Runtime (`supabase start` without `edge-runtime` in -x) and
 * Playwright Chromium. Commits data like stack.test.ts. The function claims every due job of
 * the queue (no test-only filter in the product), so leftovers of other suites are processed
 * too; assertions only look at this test's builds.
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_EPHEMERAL } from '../src/backend';
import { decodeRaw, isBlank, pixelStats } from '../src/image';
import { snapshotRequestBody } from '../src/browser-rendering';
import { PlaywrightRenderer } from '../src/playwright-renderer';
import { startBrowserRenderingStandIn, type BrowserRenderingStandIn } from '../src/stand-in';
import { parseWebp } from '../src/webp';
import { serveFunction, type ServedFunction } from './function-support';
import { Stack, loadStackEnv, sleep, type User } from './supabase-stack';
import {
  SECRET,
  buildReactBundle,
  colorClose,
  reactApp,
  startFixtures,
  type Fixtures,
} from './support';

const ORANGE = { r: 255, g: 87, b: 34 };
const GREEN = { r: 0, g: 160, b: 80 };
const THROWING = `throw new Error('boom on load');\n`;
const ACCOUNT = 'local-test';
const TOKEN = `stand-in-token-${randomBytes(8).toString('hex')}`;
const CRON_SECRET = randomBytes(32).toString('hex');

let stack: Stack;
let fx: Fixtures;
let renderer: PlaywrightRenderer;
let standIn: BrowserRenderingStandIn;
let fn: ServedFunction;
let functionEnv: Record<string, string>;

interface Player {
  user: User;
  battle: string;
  build: string;
}
const players = new Map<string, Player>();
function player(name: string): Player {
  const p = players.get(name);
  if (!p) throw new Error(`${name} was not set up (an earlier test failed)`);
  return p;
}

interface Summary {
  run: string;
  stoppedBy: string;
  jobs: { kind: string; ref: string; attempt: number; result: string }[];
}

async function runOnce(): Promise<Summary> {
  const res = await fn.invoke({ wait: true });
  expect(res.status, `${JSON.stringify(res.body)}\n${fn.log().slice(-3000)}`).toBe(200);
  return res.body as Summary;
}

/** Runs the function until the jobs of `kind` for every ref were processed; their results. */
async function runForAll(kind: string, refs: string[], maxRuns = 5): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (let i = 0; i < maxRuns && results.size < refs.length; i++) {
    for (const j of (await runOnce()).jobs) {
      if (j.kind === kind && refs.includes(j.ref)) results.set(j.ref, j.result);
    }
  }
  if (results.size < refs.length) {
    throw new Error(
      `${kind} jobs not processed in ${String(maxRuns)} runs: ${refs.filter((r) => !results.has(r)).join(', ')}`,
    );
  }
  return results;
}

/** Runs the function until `ref`'s job of `kind` was processed; returns its result. */
async function runFor(kind: string, ref: string, maxRuns = 5): Promise<string> {
  return (await runForAll(kind, [ref], maxRuns)).get(ref) ?? '';
}

function job(kind: string, ref: string) {
  return JSON.parse(
    stack.sql(
      `select json_build_object('status', status, 'attempts', attempts, 'error', last_error,
         'leased', run_after > now()) from public.jobs where kind = '${kind}' and ref_id = '${ref}'`,
    ),
  ) as { status: string; attempts: number; error: string | null; leased: boolean };
}

function captureStatus(build: string): string {
  return stack.sql(`select capture_status from public.builds where id = '${build}'`);
}

interface BudgetRow {
  used_ms: number;
  reserved_ms: number;
  renders: number;
  refused: number;
  rate_limited: number;
}

function budget(): BudgetRow {
  const row = stack.sql(
    `select coalesce((select row_to_json(b) from private.browser_budget b
                       where day = (now() at time zone 'utc')::date), '{}')`,
  );
  const empty: BudgetRow = { used_ms: 0, reserved_ms: 0, renders: 0, refused: 0, rate_limited: 0 };
  return { ...empty, ...(JSON.parse(row) as Partial<BudgetRow>) };
}

/** Requests the stand-in got for this battle's build (the bundle URL carries the battle id). */
function requestsFor(battle: string) {
  return standIn.requests.filter(
    (r) => r.url !== null && decodeURIComponent(r.url).includes(battle),
  );
}

async function publicShot(path: string) {
  const res = await fetch(`${stack.env.API_URL}/storage/v1/object/public/screenshots/${path}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('image/webp');
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, info: parseWebp(bytes), img: await decodeRaw(bytes) };
}

async function ship(name: string, files: Record<string, [string | Uint8Array, string]>) {
  const user = await stack.signUp();
  const battle = await user.startBuilding();
  for (const [file, [content, type]] of Object.entries(files)) {
    await user.upload(`${battle}/${user.id}/${file}`, content, type);
  }
  const out = (await user.rpc('ship_build', {
    p_battle_id: battle,
    p_name: `Function ${name}`,
    p_stats: {},
  })) as { build: { id: string; status: string }; battle: { phase: string } };
  expect(out.build.status).toBe('shipped');
  const p = { user, battle, build: out.build.id };
  players.set(name, p);
  return p;
}

let thumbWebp: Uint8Array;
let reactFiles: Record<string, [string, string]>;

beforeAll(async () => {
  stack = new Stack(loadStackEnv());
  fx = await startFixtures([new URL(stack.env.API_URL).origin]);
  renderer = new PlaywrightRenderer();
  standIn = await startBrowserRenderingStandIn({ accountId: ACCOUNT, apiToken: TOKEN, renderer });
  functionEnv = {
    JOBS_CRON_SECRET: CRON_SECRET,
    CAPTURE_SHELL_URL: fx.shell.captureUrl,
    CAPTURE_HMAC_SECRET: SECRET,
    PKG_CDN_URL: fx.cdn.url,
    BROWSER_RENDERING_ACCOUNT_ID: ACCOUNT,
    BROWSER_RENDERING_API_TOKEN: TOKEN,
    BROWSER_RENDERING_API_URL: standIn.urlFor('host.docker.internal'),
    // Locally the browser reaches Storage on the public port, not as kong:8000.
    JOBS_PUBLIC_SUPABASE_URL: stack.env.API_URL,
    // No pacing against the stand-in (the free plan's 10 s is the default).
    BROWSER_RENDERING_MIN_INTERVAL_MS: '0',
    LOG_LEVEL: 'debug',
  };
  fn = await serveFunction({ apiUrl: stack.env.API_URL, env: functionEnv });
  // Today's budget starts clean (a row left by an earlier run would count).
  stack.sql(`delete from private.browser_budget where day = (now() at time zone 'utc')::date`);
  // Process what other suites left in the queue, so the runs below are about our jobs.
  for (let i = 0; i < 10; i++) if ((await runOnce()).jobs.length === 0) break;

  const react = await buildReactBundle(
    fx.cdn.url,
    reactApp({ title: 'Free Tier', background: 'rgb(255, 87, 34)', signalReady: true }),
  );
  reactFiles = {
    'source.json': [react.source, 'application/json'],
    'bundle.js': [react.js, 'text/javascript'],
    'bundle.css': [react.css, 'text/css'],
  };
  thumbWebp = new Uint8Array(
    await sharp({ create: { width: 640, height: 400, channels: 3, background: GREEN } })
      .composite([
        {
          input: await sharp({
            create: { width: 640, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 180,
        },
      ])
      .withMetadata({ exif: { IFD0: { Copyright: 'client says hi' } } })
      .webp()
      .toBuffer(),
  );
}, 240_000);

/** Browser time per capture as the stand-in measured it (docs/08-free-tier.md §5). */
const measured: string[] = [];

afterAll(async () => {
  if (measured.length > 0)
    console.info(`stand-in browser time per capture: ${measured.join('; ')}`);
  stack.sql(
    `delete from vault.secrets where name in ('br_jobs_function_url', 'br_jobs_cron_secret')`,
  );
  await fn.stop();
  await standIn.close();
  await renderer.close();
  await fx.close();
});

describe('the jobs Edge Function on the local stack', () => {
  it('refuses a call without the cron secret', async () => {
    expect((await fn.invoke({ secret: '' })).status).toBe(401);
    expect((await fn.invoke({ secret: 'x'.repeat(64) })).status).toBe(401);
    const get = await fetch(fn.url);
    expect(get.status).toBe(405);
  });

  it('captures a shipped React build: WebP 1280×800 in screenshots, the browser time counted', async () => {
    const before = budget();
    const alice = await ship('alice', reactFiles);
    expect(await runFor('capture', alice.build)).toBe('captured');
    expect(captureStatus(alice.build)).toBe('captured');
    expect(job('capture', alice.build)).toMatchObject({ status: 'done', attempts: 1 });

    const { info, img } = await publicShot(`${alice.battle}/${alice.build}.webp`);
    expect([info.width, info.height, info.lossless]).toEqual([1280, 800, false]);
    const stats = pixelStats(img);
    expect(isBlank(stats)).toBe(false);
    expect(colorClose(stats.dominant, ORANGE, 16)).toBe(true);

    // What the function asked Browser Rendering for: exactly the documented body.
    const reqs = requestsFor(alice.battle);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.status).toBe(200);
    measured.push(`ready signal: ${String(reqs[0]?.browserMs)} ms`);
    const after = budget();
    expect(after.renders - before.renders).toBe(1);
    expect(after.used_ms - before.used_ms).toBe(reqs[0]?.browserMs);
    expect(after.reserved_ms).toBe(0);
  });

  it('the request body is the one the unit tests pin (viewport, webp at 70, ready selector, cap)', () => {
    const body = snapshotRequestBody({
      url: 'https://x/v1/capture',
      viewport: { width: 1280, height: 800 },
    });
    expect(body).toMatchObject({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      waitForSelector: { selector: 'html[data-br-capture]', timeout: 6000 },
      bestAttempt: true,
      screenshotOptions: { type: 'webp', quality: 70 },
    });
  });

  it('a bundle that throws on load: the page reports nothing painted, the thumbnail is used', async () => {
    const bob = await ship('bob', {
      'source.json': ['{}', 'application/json'],
      'bundle.js': [THROWING, 'text/javascript'],
      'thumb.webp': [thumbWebp, 'image/webp'],
    });
    expect(await runFor('capture', bob.build)).toBe('fallback');
    expect(captureStatus(bob.build)).toBe('fallback');
    expect(requestsFor(bob.battle)).toHaveLength(1);
    measured.push(`no signal (6 s cap): ${String(requestsFor(bob.battle)[0]?.browserMs)} ms`);
    const { bytes, info, img } = await publicShot(`${bob.battle}/${bob.build}.webp`);
    expect([info.width, info.height]).toEqual([640, 400]);
    // Rebuilt container: the image only, the client's EXIF is gone.
    expect(info.chunks).toEqual(['VP8 ']);
    expect(new TextDecoder().decode(bytes)).not.toContain('client says hi');
    expect(colorClose(pixelStats(img).dominant, GREEN, 16)).toBe(true);
  });

  it('budget spent: falls back at once, without calling Browser Rendering', async () => {
    stack.sql(`insert into private.browser_budget (day, used_ms) values ((now() at time zone 'utc')::date, 570000)
               on conflict (day) do update set used_ms = 570000`);
    const before = budget();
    const carol = await ship('carol', { ...reactFiles, 'thumb.webp': [thumbWebp, 'image/webp'] });
    expect(await runFor('capture', carol.build)).toBe('fallback');
    expect(captureStatus(carol.build)).toBe('fallback');
    expect(requestsFor(carol.battle)).toHaveLength(0);
    expect(budget().refused - before.refused).toBe(1);
    expect(job('capture', carol.build).status).toBe('done');
    stack.sql(
      `update private.browser_budget set used_ms = 0 where day = (now() at time zone 'utc')::date`,
    );
  });

  it('REST 429 with a short Retry-After: waits and retries in the same run', async () => {
    standIn.inject({ status: 429, retryAfterS: 1 });
    const dave = await ship('dave', reactFiles);
    expect(await runFor('capture', dave.build)).toBe('captured');
    expect(requestsFor(dave.battle).map((r) => r.status)).toEqual([429, 200]);
    expect(job('capture', dave.build)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('REST 429 with a long Retry-After: handed back twice, then the thumbnail', async () => {
    const before = budget();
    standIn.inject({ status: 429, retryAfterS: 60 }, 3);
    const erin = await ship('erin', { ...reactFiles, 'thumb.webp': [thumbWebp, 'image/webp'] });
    expect(await runFor('capture', erin.build)).toBe('retry');
    expect(job('capture', erin.build)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(job('capture', erin.build).error).toContain('429');
    expect(captureStatus(erin.build)).toBe('pending');
    // Past the backoff (10 s, then 20 s).
    stack.sql(
      `update public.jobs set run_after = now() where kind = 'capture' and ref_id = '${erin.build}'`,
    );
    expect(await runFor('capture', erin.build)).toBe('retry');
    stack.sql(
      `update public.jobs set run_after = now() where kind = 'capture' and ref_id = '${erin.build}'`,
    );
    expect(await runFor('capture', erin.build)).toBe('fallback');
    expect(captureStatus(erin.build)).toBe('fallback');
    expect(requestsFor(erin.battle).map((r) => r.status)).toEqual([429, 429, 429]);
    expect(budget().rate_limited - before.rate_limited).toBe(3);
  });

  it('killed mid-capture: the job keeps its lease, then the next run captures it', async () => {
    standIn.inject({ hang: true });
    const frank = await ship('frank', reactFiles);
    const started = await fn.invoke({ wait: false });
    expect(started.status).toBe(202);
    for (let i = 0; i < 60 && requestsFor(frank.battle).length === 0; i++) await sleep(500);
    expect(requestsFor(frank.battle)).toHaveLength(1);
    expect(job('capture', frank.build)).toMatchObject({
      status: 'running',
      attempts: 1,
      leased: true,
    });

    // The platform kills the worker (wall clock, CPU limit, a deploy): nothing is reported.
    await fn.stop();
    fn = await serveFunction({ apiUrl: stack.env.API_URL, env: functionEnv });
    expect(job('capture', frank.build)).toMatchObject({
      status: 'running',
      attempts: 1,
      leased: true,
    });
    // Nothing to do while the lease runs.
    expect((await runOnce()).jobs.find((j) => j.ref === frank.build)).toBeUndefined();

    // The 2-minute lease expires; the next run claims the job again.
    stack.sql(`update public.jobs set run_after = now() - interval '1 second'
               where kind = 'capture' and ref_id = '${frank.build}'`);
    expect(await runFor('capture', frank.build)).toBe('captured');
    expect(job('capture', frank.build)).toMatchObject({ status: 'done', attempts: 2 });
    expect(captureStatus(frank.build)).toBe('captured');
  });

  it('destroys every battle: the function deletes the build files', async () => {
    const all = [...players.values()];
    for (const p of all) {
      expect(
        Number(
          stack.sql(
            `select count(*) from storage.objects where bucket_id = '${BUCKET_EPHEMERAL}' and name like '${p.battle}/%'`,
          ),
        ),
      ).toBeGreaterThan(0);
      stack.expirePhase(p.battle);
      let snap = await p.user.advance(p.battle);
      for (let i = 0; i < 20 && snap.battle.phase !== 'destroyed'; i++) {
        await sleep(250);
        snap = await p.user.snapshot(p.battle);
      }
      expect(snap.battle.phase).toBe('destroyed');
    }
    const results = await runForAll(
      'destroy',
      all.map((p) => p.battle),
    );
    for (const p of all) expect(results.get(p.battle), p.battle).toBe('destroyed');
    for (const p of all) {
      expect(
        Number(
          stack.sql(
            `select count(*) from storage.objects where bucket_id = '${BUCKET_EPHEMERAL}' and name like '${p.battle}/%'`,
          ),
        ),
      ).toBe(0);
      expect((await p.user.snapshot(p.battle)).battle.destroyed_at).not.toBeNull();
    }
  });

  it("a takedown: the function deletes the build's screenshot (and only that one)", async () => {
    const alice = player('alice');
    const bob = player('bob');
    const mod = await stack.createAdmin();
    await mod.rpc('admin_take_down_build', { p_build_id: alice.build, p_note: 'function test' });
    expect(await runFor('takedown', alice.build)).toBe('taken_down');
    const gone = await fetch(
      `${stack.env.API_URL}/storage/v1/object/public/screenshots/${alice.battle}/${alice.build}.webp`,
    );
    expect(gone.status).toBeGreaterThanOrEqual(400);
    await publicShot(`${bob.battle}/${bob.build}.webp`);
  });

  it("pg_cron's trigger: run_jobs_function posts to the function with the secret from Vault", async () => {
    // Nothing due, no secrets: nothing is sent.
    expect(stack.sql(`select coalesce(private.run_jobs_function()::text, 'null')`)).toBe('null');
    stack.sql(`delete from vault.secrets where name in ('br_jobs_function_url', 'br_jobs_cron_secret');
               select vault.create_secret('http://kong:8000/functions/v1/jobs', 'br_jobs_function_url');
               select vault.create_secret('${CRON_SECRET}', 'br_jobs_cron_secret')`);
    const gina = await ship('gina', reactFiles);
    const requestId = stack.sql(`select private.run_jobs_function()`);
    expect(requestId).toMatch(/^\d+$/);
    for (let i = 0; i < 120 && captureStatus(gina.build) === 'pending'; i++) await sleep(500);
    expect(captureStatus(gina.build)).toBe('captured');
    // pg_net got the function's 202 (the run went on in the background).
    for (let i = 0; i < 20; i++) {
      if (stack.sql(`select count(*) from net._http_response where id = ${requestId}`) === '1')
        break;
      await sleep(500);
    }
    expect(stack.sql(`select status_code from net._http_response where id = ${requestId}`)).toBe(
      '202',
    );
  });
});
