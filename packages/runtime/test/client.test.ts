import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleInput } from '../src/types';
import {
  BundlerClient,
  DEFAULT_INIT_STALL_MS,
  type BundlerClientOptions,
  type InitAttemptReport,
} from '../src/worker/client';
import { FakeWorker, settledWithin } from './fake-worker';

const INPUT: BundleInput = {
  files: { 'src/main.ts': 'console.log(1)' },
  manifest: { entry: 'src/main.ts', dependencies: {} },
  mode: 'dev',
};

type ClientHooks = Pick<BundlerClientOptions, 'initStallMs' | 'onInitAttempt'>;

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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    // The retry gets as far as compiling and stops there: the error names that.
    spawned[1]?.emit({ type: 'init-progress', stage: 'compile', loaded: 13.6 * MB });
    await vi.advanceTimersByTimeAsync(DEFAULT_INIT_STALL_MS);
    expect(init).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'BundlerInitTimeoutError',
        message: 'esbuild-wasm stopped while starting (no progress for 15 s, 2 attempts)',
        stage: 'compile',
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
