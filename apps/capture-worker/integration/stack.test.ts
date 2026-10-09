/**
 * The capture and destroy workers against the REAL local Supabase stack (Auth, PostgREST,
 * Storage, pg_cron), the real shell capture page and real Chromium.
 *
 * Players (anonymous users) play solo battles through the HTTP APIs:
 *   alice  ships a React build (bundle.js + bundle.css)           → captured
 *   bob    ships a bundle that throws on load + a client thumb   → fallback
 *   carol  only autosaves (js + css); the deadline auto-ships it  → captured (autosave paths)
 *   dave   ships a throwing bundle without a thumb                → retry, then failed on the
 *                                                                    last attempt
 * Then every battle goes to DESTROYED and the destroy worker deletes the files. Finally a
 * moderator takes alice's build down (T-024) and the takedown worker deletes its screenshot.
 *
 *   pnpm --filter @br/capture-worker test:integration
 *
 * Commits data (users, battles, files), like supabase/scripts/e2e-solo.mjs: run it on a
 * stack you can reset. CAPTURE_TEST_SHOT_OUT=/path/shot.webp keeps alice's screenshot,
 * CAPTURE_TEST_LOG=/path/log.jsonl the worker's structured log.
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_EPHEMERAL, type Job } from '../src/backend';
import type { CaptureOutcome } from '../src/capture-job';
import { decodeRaw, isBlank, pixelStats, sharpImaging, type RawImage } from '../src/image';
import { createLogger } from '../src/log';
import { PlaywrightRenderer } from '../src/playwright-renderer';
import { WorkerRunner, type JobOutcome } from '../src/runner';
import {
  SECRET,
  buildReactBundle,
  colorClose,
  reactApp,
  startFixtures,
  type Fixtures,
} from './support';
import { OwnJobsBackend, Stack, loadStackEnv, sleep, type User } from './supabase-stack';

const ORANGE = { r: 255, g: 87, b: 34 };
const GREEN = { r: 0, g: 160, b: 80 };
const BLUE = { r: 33, g: 150, b: 243 };
const THROWING = `throw new Error('boom on load');\n`;

let stack: Stack;
let fx: Fixtures;
let renderer: PlaywrightRenderer;
let backend: OwnJobsBackend;
let runner: WorkerRunner;
const logs: string[] = [];

interface Player {
  user: User;
  battle: string;
  build: string;
}
const players: Record<'alice' | 'bob' | 'carol' | 'dave', Player | undefined> = {
  alice: undefined,
  bob: undefined,
  carol: undefined,
  dave: undefined,
};
function player(name: keyof typeof players): Player {
  const p = players[name];
  if (!p) throw new Error(`${name} was not set up (an earlier test failed)`);
  return p;
}

beforeAll(async () => {
  stack = new Stack(loadStackEnv());
  fx = await startFixtures([new URL(stack.env.API_URL).origin]);
  renderer = new PlaywrightRenderer();
  // Claims only this test's jobs: the shared queue may hold other scripts' leftovers.
  backend = new OwnJobsBackend(stack, {
    url: stack.env.API_URL,
    serviceKey: stack.env.SERVICE_ROLE_KEY,
  });
  runner = new WorkerRunner(
    {
      backend,
      renderer,
      imaging: sharpImaging,
      capture: {
        shellCaptureUrl: fx.shell.captureUrl,
        hmacSecret: SECRET,
        pkgCdnUrl: fx.cdn.url,
        signedUrlTtlSeconds: 120,
        captureTimeoutMs: 20_000,
        viewport: { width: 1280, height: 800 },
      },
      log: createLogger({ level: 'debug', write: (l) => logs.push(l) }),
    },
    { jobTimeoutMs: 90_000 },
  );
});

afterAll(async () => {
  await renderer.close();
  await fx.close();
  const logOut = process.env['CAPTURE_TEST_LOG'];
  if (logOut) writeFileSync(logOut, `${logs.join('\n')}\n`);
});

/**
 * Runs the capture worker once (drains this test's capture jobs that are due) and returns
 * the outcome for `build`.
 */
async function captureOnce(build: string): Promise<CaptureOutcome> {
  backend.own(build);
  const results: { job: Job; outcome: JobOutcome }[] = await runner.drain('capture');
  expect(results.map((r) => r.job.ref_id)).toEqual([build]);
  const mine = results.find((r) => r.job.ref_id === build);
  if (!mine)
    throw new Error(`the capture job of ${build} was not processed: ${JSON.stringify(results)}`);
  return mine.outcome as CaptureOutcome;
}

async function publicScreenshot(path: string): Promise<{ bytes: Uint8Array; img: RawImage }> {
  const res = await fetch(`${stack.env.API_URL}/storage/v1/object/public/screenshots/${path}`);
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect((await sharp(bytes).metadata()).format).toBe('webp');
  return { bytes, img: await decodeRaw(bytes) };
}

function buildRow(build: string): Record<string, string> {
  const row = stack.sql(
    `select json_build_object('status', status, 'capture_status', capture_status, 'screenshot_path', screenshot_path, 'source_destroyed_at', source_destroyed_at) from public.builds where id = '${build}'`,
  );
  return JSON.parse(row) as Record<string, string>;
}

function objectCount(battle: string): number {
  return Number(
    stack.sql(
      `select count(*) from storage.objects where bucket_id = '${BUCKET_EPHEMERAL}' and name like '${battle}/%'`,
    ),
  );
}

async function ship(
  user: User,
  battle: string,
  files: Record<string, [string | Uint8Array, string]>,
) {
  for (const [name, [content, type]] of Object.entries(files)) {
    await user.upload(`${battle}/${user.id}/${name}`, content, type);
  }
  const out = (await user.rpc('ship_build', {
    p_battle_id: battle,
    p_name: 'Capture test',
    p_stats: {},
  })) as { build: { id: string; status: string }; battle: { phase: string } };
  expect(out.build.status).toBe('shipped');
  expect(out.battle.phase).toBe('results');
  return out.build.id;
}

describe('capture + destroy workers on the local Supabase stack', () => {
  it('captures a shipped React build: WebP in screenshots, captured, colour and text visible', async () => {
    const user = await stack.signUp();
    const battle = await user.startBuilding();
    const react = await buildReactBundle(
      fx.cdn.url,
      reactApp({ title: 'Snack Overflow', background: 'rgb(255, 87, 34)', signalReady: true }),
    );
    const build = await ship(user, battle, {
      'source.json': [react.source, 'application/json'],
      'bundle.js': [react.js, 'text/javascript'],
      'bundle.css': [react.css, 'text/css'],
    });
    players.alice = { user, battle, build };

    const outcome = await captureOnce(build);
    expect(outcome).toMatchObject({ result: 'captured', ready: 'signal' });
    const row = buildRow(build);
    expect(row['capture_status']).toBe('captured');
    expect(row['screenshot_path']).toBe(`${battle}/${build}.webp`);

    const { bytes, img } = await publicScreenshot(`${battle}/${build}.webp`);
    expect([img.width, img.height]).toEqual([1280, 800]);
    const stats = pixelStats(img);
    expect(isBlank(stats)).toBe(false);
    expect(colorClose(stats.dominant, ORANGE, 16)).toBe(true);
    // The white 120 px title is on screen.
    let white = 0;
    for (let i = 0; i < img.data.length; i += 3) {
      if ((img.data[i] ?? 0) > 230 && (img.data[i + 1] ?? 0) > 230 && (img.data[i + 2] ?? 0) > 230)
        white++;
    }
    expect(white / (img.width * img.height)).toBeGreaterThan(0.01);
    const out = process.env['CAPTURE_TEST_SHOT_OUT'];
    if (out) writeFileSync(out, bytes);
  });

  it('falls back to the client thumbnail when the bundle throws on load', async () => {
    const user = await stack.signUp();
    const battle = await user.startBuilding();
    const thumb = await sharp({
      create: { width: 320, height: 200, channels: 3, background: GREEN },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 320, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 90,
        },
      ])
      .webp()
      .toBuffer();
    const build = await ship(user, battle, {
      'source.json': [
        JSON.stringify({ files: {}, manifest: { entry: 'x', dependencies: {} } }),
        'application/json',
      ],
      'bundle.js': [THROWING, 'text/javascript'],
      'thumb.webp': [new Uint8Array(thumb), 'image/webp'],
    });
    players.bob = { user, battle, build };

    const outcome = await captureOnce(build);
    expect(outcome.result).toBe('fallback');
    if (outcome.result === 'fallback') expect(outcome.reason).toContain('blank render');
    expect(buildRow(build)['capture_status']).toBe('fallback');
    const { img } = await publicScreenshot(`${battle}/${build}.webp`);
    expect([img.width, img.height]).toEqual([320, 200]);
    expect(colorClose(pixelStats(img).dominant, GREEN, 16)).toBe(true);
  });

  it('captures an auto_shipped build from its autosave, with its CSS', async () => {
    const user = await stack.signUp();
    const battle = await user.startBuilding();
    // The blue background comes only from the CSS file (autosave/bundle.css, T-014).
    const react = await buildReactBundle(
      fx.cdn.url,
      reactApp({ title: 'Autosaved', background: 'rgb(33, 150, 243)', signalReady: true }),
    );
    expect(react.css).toContain('background:#2196f3');
    await user.upload(
      `${battle}/${user.id}/autosave/source.json`,
      react.source,
      'application/json',
    );
    await user.upload(`${battle}/${user.id}/autosave/bundle.js`, react.js, 'text/javascript');
    await user.upload(`${battle}/${user.id}/autosave/bundle.css`, react.css, 'text/css');
    // BUILDING → SHIPPING (deadline passed) → RESULTS (grace passed): the autosave is shipped.
    stack.sql(`update public.battles set building_ends_at = now() - interval '20 seconds',
                 phase_ends_at = now() - interval '20 seconds' where id = '${battle}'`);
    let snap = await user.advance(battle);
    for (let i = 0; i < 3 && snap.battle.phase !== 'results'; i++) {
      stack.expirePhase(battle);
      snap = await user.advance(battle);
    }
    expect(snap.battle.phase).toBe('results');
    const build = snap.builds[0];
    expect(build?.status).toBe('auto_shipped');
    if (!build) return;
    players.carol = { user, battle, build: build.id };

    const outcome = await captureOnce(build.id);
    expect(outcome).toMatchObject({ result: 'captured', ready: 'signal' });
    const { img } = await publicScreenshot(`${battle}/${build.id}.webp`);
    expect(colorClose(pixelStats(img).dominant, BLUE, 16)).toBe(true);
  });

  it('without a thumbnail: retried with backoff, then failed on the last attempt', async () => {
    const user = await stack.signUp();
    const battle = await user.startBuilding();
    const build = await ship(user, battle, {
      'source.json': ['{}', 'application/json'],
      'bundle.js': [THROWING, 'text/javascript'],
    });
    players.dave = { user, battle, build };

    const first = await captureOnce(build);
    expect(first).toMatchObject({ result: 'retry', attempts: 1 });
    const job = JSON.parse(
      stack.sql(
        `select json_build_object('status', status, 'attempts', attempts, 'later', run_after > now() + interval '5 seconds', 'error', last_error) from public.jobs where kind = 'capture' and ref_id = '${build}'`,
      ),
    ) as { status: string; attempts: number; later: boolean; error: string };
    expect(job).toMatchObject({ status: 'queued', attempts: 1, later: true });
    expect(job.error).toContain('blank render');
    expect(job.error).not.toContain('token=');
    expect(buildRow(build)['capture_status']).toBe('pending');

    // Skip ahead to the 5th attempt, and past the backoff.
    stack.sql(
      `update public.jobs set attempts = 4, run_after = now() where kind = 'capture' and ref_id = '${build}'`,
    );
    const last = await captureOnce(build);
    expect(last.result).toBe('failed');
    expect(buildRow(build)['capture_status']).toBe('failed');
    expect(
      stack.sql(`select status from public.jobs where kind = 'capture' and ref_id = '${build}'`),
    ).toBe('failed');
  });

  it('destroys every battle: no objects left, destroyed_at and source_destroyed_at set', async () => {
    const all = (['alice', 'bob', 'carol', 'dave'] as const).map(player);
    for (const p of all) {
      expect(objectCount(p.battle)).toBeGreaterThan(0);
      stack.expirePhase(p.battle);
      let snap = await p.user.advance(p.battle);
      for (let i = 0; i < 20 && snap.battle.phase !== 'destroyed'; i++) {
        await sleep(250); // pg_cron may have advanced it first
        snap = await p.user.snapshot(p.battle);
      }
      expect(snap.battle.phase).toBe('destroyed');
      backend.own(p.battle);
    }
    const results = await runner.drain('destroy');
    expect(results.map((r) => r.job.ref_id).sort()).toEqual(all.map((p) => p.battle).sort());
    for (const p of all) {
      const mine = results.find((r) => r.job.ref_id === p.battle);
      expect(mine?.outcome.result, p.battle).toBe('destroyed');
      expect(objectCount(p.battle)).toBe(0);
      expect(await backend.list(BUCKET_EPHEMERAL, `${p.battle}/`)).toEqual([]);
      const snap = await p.user.snapshot(p.battle);
      expect(snap.battle.destroyed_at).not.toBeNull();
      expect(snap.builds[0]?.source_destroyed_at).not.toBeNull();
    }
    // The screenshots are permanent.
    const alice = player('alice');
    await publicScreenshot(`${alice.battle}/${alice.build}.webp`);
    expect(
      stack.sql(
        `select count(*) from public.jobs where kind = 'destroy' and ref_id in (${all
          .map((p) => `'${p.battle}'`)
          .join(',')}) and status = 'done'`,
      ),
    ).toBe('4');
  });

  it('a moderator takes a build down: hidden at once, then the takedown job deletes its screenshot', async () => {
    const alice = player('alice');
    const bob = player('bob');
    const shot = `${alice.battle}/${alice.build}.webp`;
    await publicScreenshot(shot);

    const mod = await stack.createAdmin();
    expect(await mod.rpc('is_admin')).toBe(true);
    expect(await alice.user.rpc('is_admin')).toBe(false);
    const td = (await mod.rpc('admin_take_down_build', {
      p_build_id: alice.build,
      p_note: 'capture integration',
    })) as { disqualified: boolean; retried: boolean };
    expect(td).toMatchObject({ disqualified: false, retried: false });

    // Hidden at once: the public results (anon key) show no name and no screenshot.
    const pub = await stack.request('POST', '/rest/v1/rpc/get_public_battle', {
      body: { p_battle_id: alice.battle },
    });
    expect(pub.status).toBe(200);
    expect((pub.body as { builds: unknown[] }).builds[0]).toMatchObject({
      id: alice.build,
      name: null,
      screenshot_path: null,
      taken_down: true,
      final_rank: 1,
    });

    // The file itself is still there until the worker runs.
    backend.own(alice.build);
    const results = await runner.drain('takedown');
    expect(results.map((r) => r.job.ref_id)).toEqual([alice.build]);
    expect(results[0]?.outcome).toEqual({ result: 'taken_down', deleted: 1 });

    const gone = await fetch(`${stack.env.API_URL}/storage/v1/object/public/screenshots/${shot}`);
    expect(gone.status).toBeGreaterThanOrEqual(400);
    expect(
      stack.sql(
        `select count(*) from storage.objects where bucket_id = 'screenshots' and name like '${alice.battle}/${alice.build}.%'`,
      ),
    ).toBe('0');
    expect(
      stack.sql(
        `select json_build_object('deleted', t.storage_deleted_at is not null, 'job', j.status)
           from private.build_takedowns t join public.jobs j on j.kind = 'takedown' and j.ref_id = t.build_id
          where t.build_id = '${alice.build}'`,
      ),
    ).toBe('{"deleted" : true, "job" : "done"}');
    // Nobody else's screenshot is touched.
    await publicScreenshot(`${bob.battle}/${bob.build}.webp`);
  });
});
