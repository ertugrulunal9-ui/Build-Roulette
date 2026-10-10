import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleInput } from '../src/types';
import { AwakeClock } from '../src/worker/awake-clock';
import {
  BundlerClient,
  DEFAULT_INIT_COMPILE_MS,
  DEFAULT_INIT_STALL_MS,
  INIT_MAX_TICK_CREDIT_MS,
  type BundlerClientOptions,
  type InitAttemptReport,
} from '../src/worker/client';
import { FakeWorker, settledWithin, useStartTimers } from './fake-worker';

const INPUT: BundleInput = {
  files: { 'src/main.ts': 'console.log(1)' },
  manifest: { entry: 'src/main.ts', dependencies: {} },
  mode: 'dev',
};

type ClientHooks = Pick<BundlerClientOptions, 'initStallMs' | 'initCompileMs' | 'onInitAttempt'>;

function clientWithOptions(
  hooks: ClientHooks,
  ...workers: FakeWorker[]
): { client: BundlerClient; spawned: FakeWorker[] } {
  const spawned: FakeWorker[] = [];
  const client = new BundlerClient({
    wasmUrl: '/esbuild.wasm',
    cdnBaseUrl: 'https://pkg.example.net',
    ...hooks,
    createWorker: () => {
      const w = workers[spawned.length];
      if (!w) throw new Error('no more fake workers');
      spawned.push(w);
      return w.asWorker();
    },
  });
  return { client, spawned };
}

function clientWith(...workers: FakeWorker[]): { client: BundlerClient; spawned: FakeWorker[] } {
  return clientWithOptions({}, ...workers);
}

/** How a promise has settled so far (for fake timers, where `settledWithin` cannot wait). */
function observe<T>(p: Promise<T>): {
  status: 'pending' | 'fulfilled' | 'rejected';
  value?: T;
  reason?: unknown;
} {
  const s: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown } = {
    status: 'pending',
  };
  p.then(
    (value) => {
      s.status = 'fulfilled';
      s.value = value;
    },
    (reason: unknown) => {
      s.status = 'rejected';
      s.reason = reason;
    },
  );
  return s;
}

const MB = 1024 * 1024;

describe('BundlerClient start timeout (T-039)', () => {
  beforeEach(() => {
    useStartTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a start with no progress is stopped after 15 s and retried once with a fresh worker', async () => {
    const reports: InitAttemptReport[] = [];
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      new FakeWorker('manual'),
      new FakeWorker('ok'),
    );
    const init = observe(client.init());
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS - 1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.terminated).toBe(false);
    expect(init.status).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(spawned[0]?.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.posted).toEqual([{ type: 'init', wasmUrl: '/esbuild.wasm' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 2, wasmInitMs: 1 } });
    expect(init.value?.coldStartMs).toBeGreaterThanOrEqual(0);
    expect(reports.map((r) => [r.attempt, r.outcome, r.stage])).toEqual([
      [1, 'stalled', 'worker'],
      [2, 'ready', 'worker'],
    ]);
    // The fresh worker is the one that builds.
    await expect(client.build(INPUT)).resolves.toMatchObject({ ok: true });
    expect(spawned[1]?.posted.map((m) => m.type)).toEqual(['init', 'build']);
  });

  it('when the retry stalls too, init() and waiting builds reject with a timeout; the next init() starts over', async () => {
    const reports: InitAttemptReport[] = [];
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      new FakeWorker('manual'),
      new FakeWorker('manual'),
      new FakeWorker('ok'),
    );
    const init = observe(client.init());
    const build = observe(client.build(INPUT));
    await vi.advanceTimersByTimeAsync(2 * DEFAULT_INIT_STALL_MS - 1);
    expect(init.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    for (const p of [init, build]) {
      expect(p.status).toBe('rejected');
      expect(p.reason).toMatchObject({
        name: 'BundlerInitTimeoutError',
        message: 'the download stalled (no progress for 15 s, 2 attempts)',
        stage: 'worker',
        attempts: 2,
      });
    }
    expect(spawned).toHaveLength(2);
    expect(spawned.every((w) => w.terminated)).toBe(true);
    expect(reports.map((r) => r.outcome)).toEqual(['stalled', 'stalled']);
    // No third worker on its own: a failed init is not cached, the next call starts over.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(2);
    await expect(client.init()).resolves.toMatchObject({ attempts: 1 });
    expect(spawned).toHaveLength(3);
  });

  it('progress keeps a slow download going; only a gap of 15 s without progress is a stall', async () => {
    const reports: InitAttemptReport[] = [];
    const slow = new FakeWorker('manual');
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      slow,
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    slow.emit({ type: 'init-progress', stage: 'download', loaded: 0 });
    // 13.6 MB over two minutes: a chunk every 10 s.
    for (let i = 1; i <= 12; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      slow.emit({ type: 'init-progress', stage: 'download', loaded: i * 1.1 * MB });
    }
    expect(spawned).toHaveLength(1);
    expect(init.status).toBe('pending');
    // Then the bytes stop.
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS);
    expect(slow.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(reports).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'stalled',
        stage: 'download',
        loadedBytes: 12 * 1.1 * MB,
      }),
    ]);
    // The retry gets as far as compiling and stops there (for the compile limit, T-041): the
    // error names that.
    spawned[1]?.emit({ type: 'init-progress', stage: 'compile', loaded: 13.6 * MB });
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_COMPILE_MS);
    expect(init).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'BundlerInitTimeoutError',
        message:
          'esbuild-wasm stopped while starting (not ready 60 s after the download, 2 attempts)',
        stage: 'compile',
        stallMs: DEFAULT_INIT_COMPILE_MS,
      },
    });
  });

  it('a slow start that finishes is ready on the first worker', async () => {
    const slow = new FakeWorker('manual');
    const { client, spawned } = clientWith(slow);
    const init = observe(client.init());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS - 1000);
      slow.emit({ type: 'init-progress', stage: 'download', loaded: i * MB });
    }
    slow.emit({ type: 'init-done', wasmInitMs: 70_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 1 } });
    // The stall timer is gone with the start: nothing fires later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(1);
    expect(slow.terminated).toBe(false);
  });

  it('initStallMs sets the stall timeout', async () => {
    const { client, spawned } = clientWithOptions(
      { initStallMs: 2000 },
      new FakeWorker('manual'),
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    await vi.advanceTimersByTimeAsync(4000);
    expect(spawned).toHaveLength(2);
    expect(init).toMatchObject({
      status: 'rejected',
      reason: { message: 'the download stalled (no progress for 2 s, 2 attempts)' },
    });
  });

  it('terminate() while waiting for the stall settles everything and starts no retry', async () => {
    const reports: InitAttemptReport[] = [];
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      new FakeWorker('manual'),
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    const build = observe(client.build(INPUT));
    await vi.advanceTimersByTimeAsync(10_000);
    client.terminate();
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(build).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.terminated).toBe(true);
    expect(reports).toEqual([]);
  });

  it('terminate() during the automatic retry settles everything', async () => {
    const reports: InitAttemptReport[] = [];
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      new FakeWorker('manual'),
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    const build = observe(client.build(INPUT));
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS + 5000);
    expect(spawned).toHaveLength(2);
    client.terminate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(init).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(build).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(spawned).toHaveLength(2);
    expect(spawned.every((w) => w.terminated)).toBe(true);
    expect(reports.map((r) => r.outcome)).toEqual(['stalled']);
  });

  it("the stalled worker's late messages and errors are ignored", async () => {
    const first = new FakeWorker('manual');
    const second = new FakeWorker('manual');
    const { client } = clientWith(first, second);
    const init = observe(client.init());
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS);
    first.emit({ type: 'init-done', wasmInitMs: 1 });
    first.emitError('late error');
    first.emit({ type: 'init-progress', stage: 'download', loaded: 1 });
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS - 1);
    expect(init.status).toBe('pending');
    second.emit({ type: 'init-done', wasmInitMs: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 2, wasmInitMs: 2 } });
  });

  it('an init error is reported and not retried automatically (the next init() retries)', async () => {
    const reports: InitAttemptReport[] = [];
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      new FakeWorker('fail'),
      new FakeWorker('ok'),
    );
    await expect(client.init()).rejects.toThrow('esbuild-wasm failed to initialize: wasm 404');
    expect(spawned).toHaveLength(1);
    expect(reports).toEqual([expect.objectContaining({ attempt: 1, outcome: 'error' })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(1);
  });

  it('a throwing onInitAttempt does not break the start', async () => {
    const { client } = clientWithOptions(
      {
        onInitAttempt: () => {
          throw new Error('telemetry broke');
        },
      },
      new FakeWorker('manual'),
      new FakeWorker('ok'),
    );
    const init = observe(client.init());
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 2 } });
  });
});

// T-041: after the last byte no progress comes (V8 finishes the compile, then esbuild's
// initialize blocks the worker's thread), so the 15 s stall limit would cut off a compile that
// a starved CPU makes slow. The compile stage has its own, generous limit.
describe('BundlerClient compile limit (T-041)', () => {
  beforeEach(() => {
    useStartTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The worker sends its first bytes, then the last one after `downloadMs`. */
  async function downloadThenCompile(w: FakeWorker, downloadMs = 1000): Promise<void> {
    w.emit({ type: 'init-progress', stage: 'download', loaded: 0 });
    await vi.advanceTimersByTimeAsync(downloadMs);
    w.emit({ type: 'init-progress', stage: 'compile', loaded: 13.6 * MB });
  }

  it('a compile stage of 40 s (no progress after the last byte) is not a stall', async () => {
    const reports: InitAttemptReport[] = [];
    const slow = new FakeWorker('manual');
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      slow,
      new FakeWorker('ok'),
    );
    const init = observe(client.init());
    await downloadThenCompile(slow);
    await vi.advanceTimersByTimeAsync(40_000);
    // The pre-T-041 client stopped it at 15 s and started a second worker.
    expect(spawned).toHaveLength(1);
    expect(slow.terminated).toBe(false);
    expect(init.status).toBe('pending');
    slow.emit({ type: 'init-done', wasmInitMs: 41_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 1 } });
    expect(reports).toEqual([
      {
        attempt: 1,
        outcome: 'ready',
        stage: 'compile',
        elapsedMs: 41_000,
        awakeMs: 41_000,
        loadedBytes: 13.6 * MB,
      },
    ]);
  });

  it('a compile stage that never ends is stopped after 60 s and retried once, then init() fails', async () => {
    const reports: InitAttemptReport[] = [];
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      new FakeWorker('manual'),
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    const first = spawned[0];
    if (!first) throw new Error('no worker');
    await downloadThenCompile(first);
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_COMPILE_MS - 1);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    const second = spawned[1];
    if (!second) throw new Error('no retry');
    await downloadThenCompile(second);
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_COMPILE_MS);
    expect(init).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'BundlerInitTimeoutError',
        message:
          'esbuild-wasm stopped while starting (not ready 60 s after the download, 2 attempts)',
        stage: 'compile',
        stallMs: DEFAULT_INIT_COMPILE_MS,
        attempts: 2,
      },
    });
    expect(reports.map((r) => [r.attempt, r.outcome, r.stage, r.elapsedMs])).toEqual([
      [1, 'stalled', 'compile', 1000 + DEFAULT_INIT_COMPILE_MS],
      [2, 'stalled', 'compile', 1000 + DEFAULT_INIT_COMPILE_MS],
    ]);
  });

  it('initCompileMs sets the compile limit', async () => {
    const { client, spawned } = clientWithOptions(
      { initCompileMs: 5000 },
      new FakeWorker('manual'),
      new FakeWorker('manual'),
    );
    observe(client.init());
    const first = spawned[0];
    if (!first) throw new Error('no worker');
    await downloadThenCompile(first);
    await vi.advanceTimersByTimeAsync(4999);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(2);
  });

  it('until the last byte the stall limit still applies: 15 s without a byte is a stall', async () => {
    const reports: InitAttemptReport[] = [];
    const w = new FakeWorker('manual');
    const { client, spawned } = clientWithOptions(
      { onInitAttempt: (r) => reports.push(r) },
      w,
      new FakeWorker('manual'),
    );
    observe(client.init());
    w.emit({ type: 'init-progress', stage: 'download', loaded: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    w.emit({ type: 'init-progress', stage: 'download', loaded: 2 * MB });
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS - 1);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(reports).toEqual([
      expect.objectContaining({ outcome: 'stalled', stage: 'download', loadedBytes: 2 * MB }),
    ]);
  });

  it('the compile limit counts from the last byte, not from the start', async () => {
    // A slow download (2 min, bytes all along) and then a 50 s compile: neither is cut off.
    const slow = new FakeWorker('manual');
    const { client, spawned } = clientWith(slow);
    const init = observe(client.init());
    for (let i = 0; i < 12; i++) {
      slow.emit({ type: 'init-progress', stage: 'download', loaded: i * MB });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    slow.emit({ type: 'init-progress', stage: 'compile', loaded: 13.6 * MB });
    await vi.advanceTimersByTimeAsync(50_000);
    slow.emit({ type: 'init-done', wasmInitMs: 170_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 1 } });
    expect(spawned).toHaveLength(1);
  });
});

/** Blocks this thread (the "page") for `ms`: no timer and no message runs meanwhile. */
function freeze(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // A starved page: nothing of ours runs.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// T-041 (T-031's idea): the limits count page-awake time. When the page itself does not run
// (the renderer gets no CPU), its worker does not either, and a timer that fires late after
// such a freeze must not call it a stall. Real timers: the freeze really blocks the thread.
describe('BundlerClient limits count page-awake time (T-041)', () => {
  it('a 4 s freeze against a 3 s stall limit is not a stall; a real stall afterwards still is', async () => {
    const reports: InitAttemptReport[] = [];
    const w = new FakeWorker('manual');
    const { client, spawned } = clientWithOptions(
      { initStallMs: 3000, onInitAttempt: (r) => reports.push(r) },
      w,
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    w.emit({ type: 'init-progress', stage: 'download', loaded: 0 });
    freeze(4000);
    // The page runs again: the late tick counts at most INIT_MAX_TICK_CREDIT_MS. The
    // pre-T-041 client's 3 s timer fires right here instead.
    await sleep(600);
    expect(spawned).toHaveLength(1);
    expect(init.status).toBe('pending');

    // No progress while the page is awake: stopped after 3 s of awake time.
    const resumed = performance.now();
    await expect.poll(() => spawned.length, { timeout: 5000, interval: 50 }).toBe(2);
    const detectedAfter = performance.now() - resumed;
    expect(detectedAfter).toBeGreaterThan(3000 - INIT_MAX_TICK_CREDIT_MS - 700);
    expect(detectedAfter).toBeLessThan(3000);
    const [report] = reports;
    expect(report).toMatchObject({ attempt: 1, outcome: 'stalled', stage: 'download' });
    if (!report) throw new Error('no report');
    expect(report.awakeMs).toBeGreaterThanOrEqual(3000);
    expect(report.awakeMs).toBeLessThan(3600);
    // The wall clock includes the freeze, which was not counted.
    expect(report.elapsedMs - report.awakeMs).toBeGreaterThan(4000 - INIT_MAX_TICK_CREDIT_MS - 100);
    client.terminate();
  });

  it('a freeze during the compile stage is not counted against the compile limit', async () => {
    const w = new FakeWorker('manual');
    // Both limits at 2 s, so a wall-clock limit of either kind would fire after the freeze.
    const { client, spawned } = clientWithOptions(
      { initStallMs: 2000, initCompileMs: 2000 },
      w,
      new FakeWorker('manual'),
    );
    const init = observe(client.init());
    w.emit({ type: 'init-progress', stage: 'compile', loaded: 13.6 * MB });
    freeze(3000);
    await sleep(400);
    expect(spawned).toHaveLength(1);
    w.emit({ type: 'init-done', wasmInitMs: 3400 });
    await sleep(0);
    expect(init).toMatchObject({ status: 'fulfilled', value: { attempts: 1 } });
  });
});

describe('AwakeClock', () => {
  it('follows the real clock between timely ticks', () => {
    const clock = new AwakeClock(1000, 1000);
    expect(clock.tick(1250)).toBe(250);
    expect(clock.tick(1500)).toBe(500);
    expect(clock.at(1700)).toBe(700);
    expect(clock.tick(2400)).toBe(1400); // 900 ms late: a busy page, still counted
  });

  it('a late tick (the page did not run) adds at most the credit', () => {
    const clock = new AwakeClock(0, 1000);
    expect(clock.tick(250)).toBe(250);
    expect(clock.tick(17_250)).toBe(1250);
    expect(clock.tick(17_500)).toBe(1500);
  });

  it('readings between ticks are capped the same way and never go backwards', () => {
    const clock = new AwakeClock(0, 1000);
    expect(clock.at(500)).toBe(500);
    expect(clock.at(5000)).toBe(1000);
    expect(clock.tick(6000)).toBe(1000);
    expect(clock.at(5000)).toBe(1000); // a reading from before the tick: no step back
    expect(clock.at(6100)).toBe(1100);
  });
});

describe('BundlerClient.terminate()', () => {
  it('rejects a pending init() with an AbortError instead of leaving it hanging', async () => {
    const { client } = clientWith(new FakeWorker('manual'));
    const init = client.init();
    client.terminate();
    const r = await settledWithin(init);
    expect(r).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
  });

  it('rejects a build that is still waiting for init()', async () => {
    const { client } = clientWith(new FakeWorker('manual'));
    const build = client.build(INPUT);
    client.terminate();
    expect(await settledWithin(build)).toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError' },
    });
  });

  it('rejects in-flight builds with an AbortError', async () => {
    const worker = new FakeWorker('ok', 'manual');
    const { client } = clientWith(worker);
    await client.init();
    const build = client.build(INPUT);
    await Promise.resolve();
    expect(worker.posted.map((m) => m.type)).toEqual(['init', 'build']);
    client.terminate();
    expect(worker.terminated).toBe(true);
    expect(await settledWithin(build)).toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError', message: 'Bundler terminated.' },
    });
  });

  it('can init again after terminate (fresh worker)', async () => {
    const { client, spawned } = clientWith(new FakeWorker('manual'), new FakeWorker('ok'));
    const first = client.init();
    client.terminate();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.init()).resolves.toMatchObject({ wasmInitMs: 1 });
    expect(spawned).toHaveLength(2);
    await expect(client.build(INPUT)).resolves.toMatchObject({ ok: true });
  });
});

describe('BundlerClient init failures', () => {
  it('a failed init is retried by the next init() with a fresh worker', async () => {
    const { client, spawned } = clientWith(new FakeWorker('fail'), new FakeWorker('ok'));
    await expect(client.init()).rejects.toThrow('esbuild-wasm failed to initialize: wasm 404');
    expect(spawned[0]?.terminated).toBe(true);
    await expect(client.init()).resolves.toMatchObject({ wasmInitMs: 1 });
    expect(spawned).toHaveLength(2);
  });

  it('a worker that fails to load (error event) rejects init, and init retries', async () => {
    const broken = new FakeWorker('manual');
    const { client, spawned } = clientWith(broken, new FakeWorker('ok'));
    const init = client.init();
    broken.emitError('404 bundler.worker.js');
    await expect(init).rejects.toThrow('bundler worker failed: 404 bundler.worker.js');
    await expect(client.init()).resolves.toBeDefined();
    expect(spawned).toHaveLength(2);
  });

  it('createWorker throwing rejects init (and init retries)', async () => {
    let calls = 0;
    const client = new BundlerClient({
      wasmUrl: '/esbuild.wasm',
      cdnBaseUrl: 'https://pkg.example.net',
      createWorker: () => {
        calls++;
        if (calls === 1) throw new Error('blocked by CSP');
        return new FakeWorker('ok').asWorker();
      },
    });
    await expect(client.init()).rejects.toThrow('blocked by CSP');
    await expect(client.init()).resolves.toBeDefined();
  });
});

describe('BundlerClientOptions', () => {
  it('needs either workerUrl or createWorker (runtime check for untyped callers)', () => {
    expect(
      () =>
        new BundlerClient({
          wasmUrl: '/esbuild.wasm',
          cdnBaseUrl: 'https://pkg.example.net',
        } as unknown as BundlerClientOptions),
    ).toThrow('BundlerClient: pass either workerUrl or createWorker');
  });

  it('types: workerUrl is optional with createWorker, and the two are exclusive', () => {
    const withFactory: BundlerClientOptions = {
      wasmUrl: '/esbuild.wasm',
      cdnBaseUrl: 'https://pkg.example.net',
      createWorker: () => new FakeWorker('ok').asWorker(),
    };
    const withUrl: BundlerClientOptions = {
      wasmUrl: '/esbuild.wasm',
      cdnBaseUrl: 'https://pkg.example.net',
      workerUrl: '/bundler.worker.js',
    };
    // @ts-expect-error neither workerUrl nor createWorker
    const neither: BundlerClientOptions = { wasmUrl: '/x.wasm', cdnBaseUrl: 'https://x' };
    // @ts-expect-error workerUrl is unused (and so rejected) when createWorker is given
    const both: BundlerClientOptions = {
      wasmUrl: '/x.wasm',
      cdnBaseUrl: 'https://x',
      workerUrl: '/bundler.worker.js',
      createWorker: () => new FakeWorker('ok').asWorker(),
    };
    expect([withFactory, withUrl, neither, both]).toHaveLength(4);
  });
});
