/**
 * The capture and destroy workers against the REAL local Supabase stack (Auth, PostgREST,
 * Storage, pg_cron), the real shell capture page and real Chromium.
 *
 * Players (anonymous users) play solo battles through the HTTP APIs:
 *   alice  ships a React build (bundle.js + bundle.css)           → captured
 *   bob    ships a bundle that throws on load + a client thumb   → fallback
 *   carol  only autosaves; the deadline auto-ships it             → captured (autosave paths)
 *   dave   ships a throwing bundle without a thumb                → retry, then failed on the
 *                                                                    last attempt
 * Then every battle goes to DESTROYED and the destroy worker deletes the files.
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
import { decodeRaw, isBlank, pixelStats, type RawImage } from '../src/image';
import { createLogger } from '../src/log';
import { PlaywrightRenderer } from '../src/playwright-renderer';
import { WorkerRunner, type JobOutcome } from '../src/runner';
import { SupabaseBackend } from '../src/supabase';
import {
  SECRET,
  buildReactBundle,
  colorClose,
  reactApp,
  startFixtures,
  type Fixtures,
} from './support';
import { Stack, loadStackEnv, sleep, type User } from './supabase-stack';

const ORANGE = { r: 255, g: 87, b: 34 };
const GREEN = { r: 0, g: 160, b: 80 };
const BLUE = { r: 33, g: 150, b: 243 };
const THROWING = `throw new Error('boom on load');\n`;

let stack: Stack;
let fx: Fixtures;
let renderer: PlaywrightRenderer;
let backend: SupabaseBackend;
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
  backend = new SupabaseBackend({ url: stack.env.API_URL, serviceKey: stack.env.SERVICE_ROLE_KEY });
  runner = new WorkerRunner(
    {
      backend,
      renderer,
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

/** Puts this build's capture job first in line (jobs left by other runs may exist). */
function prioritize(kind: 'capture' | 'destroy', ref: string): void {
  stack.sql(
    `update public.jobs set run_after = '-infinity' where kind = '${kind}' and ref_id = '${ref}' and status in ('queued', 'running')`,
  );
}

/** Runs the capture worker once (drains the queue) and returns the outcome for `build`. */
async function captureOnce(build: string): Promise<CaptureOutcome> {
  prioritize('capture', build);
  const results: { job: Job; outcome: JobOutcome }[] = await runner.drain('capture');
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

  it('captures an auto_shipped build from its autosave', async () => {
    const user = await stack.signUp();
    const battle = await user.startBuilding();
    const react = await buildReactBundle(
      fx.cdn.url,
      reactApp({
        title: 'Autosaved',
        background: 'rgb(33, 150, 243)',
        signalReady: true,
        inlineStyles: true,
      }),
    );
    expect(react.css).toBe('');
    await user.upload(
      `${battle}/${user.id}/autosave/source.json`,
      react.source,
      'application/json',
    );
    await user.upload(`${battle}/${user.id}/autosave/bundle.js`, react.js, 'text/javascript');
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

    // Skip ahead to the 5th attempt.
    stack.sql(`update public.jobs set attempts = 4 where kind = 'capture' and ref_id = '${build}'`);
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
      prioritize('destroy', p.battle);
    }
    const results = await runner.drain('destroy');
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
});
