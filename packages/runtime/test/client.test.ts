import { describe, expect, it } from 'vitest';
import type { BundleInput } from '../src/types';
import { BundlerClient, type BundlerClientOptions } from '../src/worker/client';
import { FakeWorker, settledWithin } from './fake-worker';

const INPUT: BundleInput = {
  files: { 'src/main.ts': 'console.log(1)' },
  manifest: { entry: 'src/main.ts', dependencies: {} },
  mode: 'dev',
};

function clientWith(...workers: FakeWorker[]): { client: BundlerClient; spawned: FakeWorker[] } {
  const spawned: FakeWorker[] = [];
  const client = new BundlerClient({
    wasmUrl: '/esbuild.wasm',
    cdnBaseUrl: 'https://pkg.example.net',
    createWorker: () => {
      const w = workers[spawned.length];
      if (!w) throw new Error('no more fake workers');
      spawned.push(w);
      return w.asWorker();
    },
  });
  return { client, spawned };
}

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
