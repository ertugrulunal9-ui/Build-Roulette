import { afterEach, describe, expect, it } from 'vitest';
import { BUCKET_EPHEMERAL, BUCKET_SCREENSHOTS } from '../src/backend';
import type { CaptureConfig } from '../src/capture-job';
import { sharpImaging } from '../src/image';
import { createLogger, silentLogger } from '../src/log';
import { RenderError, type RenderRequest } from '../src/renderer';
import { WorkerRunner } from '../src/runner';
import { BATTLE, BUILD, FakeBackend, FakeRenderer, USER, imageWithBlock, rendered } from './fakes';

const CONFIG: CaptureConfig = {
  shellCaptureUrl: 'https://shell.test/v1/capture',
  hmacSecret: 'runner-secret-0123456789abcdef0123456789abcdef',
  pkgCdnUrl: 'https://pkg.test',
  signedUrlTtlSeconds: 120,
  captureTimeoutMs: 20_000,
  viewport: { width: 1280, height: 800 },
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await sleep(5);
  }
}

function capturable(backend: FakeBackend, id = BUILD): void {
  backend.addBuild({ id });
  backend.put(BUCKET_EPHEMERAL, `${BATTLE}/${USER}/bundle.js`, 'x');
  backend.addJob('capture', id);
}

/** A renderer that hangs until its request is aborted. */
function hangingRenderer(): FakeRenderer {
  return new FakeRenderer(
    (req: RenderRequest) =>
      new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => {
          reject(new RenderError('aborted', 'stopped'));
        });
      }),
  );
}

let runner: WorkerRunner | null = null;
afterEach(async () => {
  await runner?.stop();
  runner = null;
});

describe('WorkerRunner', () => {
  it('drain(): processes jobs until claim_job has nothing, in order', async () => {
    const backend = new FakeBackend();
    const png = await imageWithBlock(
      64,
      40,
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255, left: 0, top: 0, width: 32, height: 40 },
    );
    capturable(backend);
    backend.phases.set(BATTLE, 'destroyed');
    backend.addJob('destroy', BATTLE);
    const renderer = new FakeRenderer(() => Promise.resolve(rendered(png)));
    runner = new WorkerRunner({
      backend,
      renderer,
      imaging: sharpImaging,
      capture: CONFIG,
      log: silentLogger,
    });
    const captures = await runner.drain('capture');
    expect(captures.map((c) => c.outcome.result)).toEqual(['captured']);
    const destroys = await runner.drain('destroy');
    expect(destroys.map((c) => c.outcome.result)).toEqual(['destroyed']);
    expect(await runner.drain('capture')).toEqual([]);
  });

  it('runs takedown jobs (T-024), and start() polls all three kinds by default', async () => {
    const backend = new FakeBackend();
    backend.addBuild({ taken_down_at: new Date().toISOString() });
    backend.put(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.webp`, 'shot');
    backend.addJob('takedown', BUILD);
    runner = new WorkerRunner(
      {
        backend,
        renderer: hangingRenderer(),
        imaging: sharpImaging,
        capture: CONFIG,
        log: silentLogger,
      },
      { idleMinMs: 10, shutdownGraceMs: 0 },
    );
    runner.start();
    await waitFor(() => backend.callsTo('completeTakedown').length === 1, 1000);
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.webp`)).toBeUndefined();
    const kinds = new Set(backend.callsTo('claimJob').map(([k]) => k));
    expect([...kinds].sort()).toEqual(['capture', 'destroy', 'takedown']);
  });

  it('a job that runs past jobTimeoutMs is aborted and given back with fail_job', async () => {
    const backend = new FakeBackend();
    capturable(backend);
    runner = new WorkerRunner(
      {
        backend,
        renderer: hangingRenderer(),
        imaging: sharpImaging,
        capture: CONFIG,
        log: silentLogger,
      },
      { jobTimeoutMs: 50 },
    );
    const [first] = await runner.drain('capture', 1);
    expect(first?.outcome).toEqual({
      result: 'retry',
      attempts: 1,
      reason: 'aborted: job timeout after 50 ms',
    });
  });

  it('polls with exponential backoff while idle, and resets after a job', async () => {
    const backend = new FakeBackend();
    runner = new WorkerRunner(
      {
        backend,
        renderer: hangingRenderer(),
        imaging: sharpImaging,
        capture: CONFIG,
        log: silentLogger,
      },
      { idleMinMs: 10, idleMaxMs: 40, kinds: ['destroy'] },
    );
    runner.start();
    await sleep(200);
    const claims = backend.callsTo('claimJob').length;
    // 10 + 20 + 40 + 40 + 40 … ms: about 6 claims in 200 ms, far fewer than without backoff.
    expect(claims).toBeGreaterThanOrEqual(3);
    expect(claims).toBeLessThanOrEqual(9);

    backend.phases.set(BATTLE, 'destroyed');
    backend.addJob('destroy', BATTLE);
    await waitFor(() => backend.callsTo('completeDestroy').length === 1, 1000);
  });

  it('claim errors are logged and backed off, not fatal', async () => {
    const backend = new FakeBackend();
    backend.failAlways.set('claimJob', new Error('PostgREST down'));
    const lines: string[] = [];
    runner = new WorkerRunner(
      {
        backend,
        renderer: hangingRenderer(),
        imaging: sharpImaging,
        capture: CONFIG,
        log: createLogger({ write: (l) => lines.push(l) }),
      },
      { idleMinMs: 10, idleMaxMs: 20, kinds: ['capture'] },
    );
    runner.start();
    await waitFor(() => backend.callsTo('claimJob').length >= 3);
    const err = JSON.parse(lines.find((l) => l.includes('claim.failed')) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(err).toMatchObject({ level: 'error', msg: 'claim.failed', error: 'PostgREST down' });
  });

  it('runs captureConcurrency capture loops in parallel (default 1)', async () => {
    const backend = new FakeBackend();
    for (let i = 0; i < 3; i++)
      capturable(backend, `33333333-3333-4333-8333-33333333333${String(i)}`);
    const renderer = hangingRenderer();
    runner = new WorkerRunner(
      { backend, renderer, imaging: sharpImaging, capture: CONFIG, log: silentLogger },
      { captureConcurrency: 2, idleMinMs: 10, kinds: ['capture'], shutdownGraceMs: 0 },
    );
    runner.start();
    await waitFor(() => renderer.requests.length === 2);
    await sleep(50);
    expect(renderer.requests.length).toBe(2);
    expect(
      () =>
        new WorkerRunner(
          { backend, renderer, imaging: sharpImaging, capture: CONFIG, log: silentLogger },
          { captureConcurrency: 0 },
        ),
    ).toThrow();
  });

  it('stop(): lets a job in flight finish within the grace period', async () => {
    const backend = new FakeBackend();
    capturable(backend);
    const png = await imageWithBlock(
      64,
      40,
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255, left: 0, top: 0, width: 32, height: 40 },
    );
    let started = false;
    const renderer = new FakeRenderer(async () => {
      started = true;
      await sleep(100);
      return rendered(png);
    });
    runner = new WorkerRunner(
      { backend, renderer, imaging: sharpImaging, capture: CONFIG, log: silentLogger },
      { idleMinMs: 10, kinds: ['capture'], shutdownGraceMs: 5000 },
    );
    runner.start();
    await waitFor(() => started);
    await runner.stop();
    expect(backend.callsTo('completeCapture')).toEqual([
      [BUILD, 'captured', `${BATTLE}/${BUILD}.webp`],
    ]);
    expect(backend.callsTo('failJob')).toEqual([]);
    const claimsAfterStop = backend.callsTo('claimJob').length;
    await sleep(50);
    expect(backend.callsTo('claimJob').length).toBe(claimsAfterStop);
  });

  it('stop(): after the grace period the job is aborted and given back (fail_job)', async () => {
    const backend = new FakeBackend();
    capturable(backend);
    const renderer = hangingRenderer();
    runner = new WorkerRunner(
      { backend, renderer, imaging: sharpImaging, capture: CONFIG, log: silentLogger },
      { idleMinMs: 10, kinds: ['capture'], shutdownGraceMs: 30 },
    );
    runner.start();
    await waitFor(() => renderer.requests.length === 1);
    const t0 = Date.now();
    await runner.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(backend.callsTo('failJob')).toEqual([[1, 'aborted: worker shutting down']]);
    expect(backend.jobs[0]?.status).toBe('queued');
  });
});
