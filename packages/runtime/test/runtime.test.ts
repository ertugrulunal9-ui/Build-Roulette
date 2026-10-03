import { afterEach, describe, expect, it } from 'vitest';
import { EsmBrowserRuntime } from '../src/runtime';
import type { BuildResult } from '../src/types';
import { FakeWorker, flush, settledWithin, trackUnhandledRejections } from './fake-worker';

const FILES = { 'src/main.ts': 'console.log(1)' };
const MANIFEST = { entry: 'src/main.ts', dependencies: {} };

function runtimeWith(...workers: FakeWorker[]): { rt: EsmBrowserRuntime; spawned: FakeWorker[] } {
  const spawned: FakeWorker[] = [];
  const rt = new EsmBrowserRuntime({
    wasmUrl: '/esbuild.wasm',
    cdnBaseUrl: 'https://pkg.example.net',
    debounceMs: 0,
    createWorker: () => {
      const w = workers[spawned.length];
      if (!w) throw new Error('no more fake workers');
      spawned.push(w);
      return w.asWorker();
    },
  });
  return { rt, spawned };
}

let tracker: ReturnType<typeof trackUnhandledRejections> | null = null;
afterEach(() => {
  tracker?.stop();
  tracker = null;
});

describe('EsmBrowserRuntime lifecycle', () => {
  it('boot() racing destroy() settles (React StrictMode double effects)', async () => {
    const { rt } = runtimeWith(new FakeWorker('manual'));
    const boot = rt.boot({ files: FILES, manifest: MANIFEST });
    await rt.destroy();
    expect(await settledWithin(boot)).toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError' },
    });
  });

  it('boot() after destroy() rejects instead of starting a new worker', async () => {
    const { rt, spawned } = runtimeWith(new FakeWorker('ok'));
    await rt.destroy();
    await expect(rt.boot({ files: FILES, manifest: MANIFEST })).rejects.toThrow(
      'runtime destroyed',
    );
    expect(spawned).toHaveLength(0);
  });

  it('a debounced build after a failed init reports through onBuild, not as an unhandled rejection', async () => {
    tracker = trackUnhandledRejections();
    const { rt, spawned } = runtimeWith(new FakeWorker('fail'), new FakeWorker('fail'));
    const results: BuildResult[] = [];
    rt.onBuild((r) => results.push(r));
    await expect(rt.boot({ files: FILES, manifest: MANIFEST })).rejects.toThrow(
      'esbuild-wasm failed to initialize',
    );
    rt.writeFile('src/main.ts', 'console.log(2)');
    await expect.poll(() => results.length).toBe(1);
    await flush();
    expect(tracker.reasons).toEqual([]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'bundler-init-failed',
        text: 'The bundler could not start: esbuild-wasm failed to initialize: wasm 404',
      },
    ]);
    // The scheduled build tried a fresh init instead of reusing the rejected one.
    expect(spawned).toHaveLength(2);
  });

  it('a failed init is retried: the next build starts the bundler and builds', async () => {
    const { rt, spawned } = runtimeWith(new FakeWorker('fail'), new FakeWorker('ok'));
    await expect(rt.boot({ files: FILES, manifest: MANIFEST })).rejects.toThrow();
    const results: BuildResult[] = [];
    rt.onBuild((r) => results.push(r));
    const r = await rt.build();
    expect(r).toMatchObject({ ok: true });
    expect(results).toEqual([r]);
    expect(spawned).toHaveLength(2);
  });

  it('an explicit build() after a failed init resolves with a diagnostic', async () => {
    const { rt } = runtimeWith(new FakeWorker('fail'), new FakeWorker('fail'));
    await expect(rt.boot({ files: FILES, manifest: MANIFEST })).rejects.toThrow();
    const r = await rt.build();
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe('bundler-init-failed');
  });

  it('destroy() during a debounced build neither hangs nor leaks a rejection or a result', async () => {
    tracker = trackUnhandledRejections();
    const worker = new FakeWorker('ok', 'manual');
    const { rt } = runtimeWith(worker);
    await rt.boot({ files: FILES, manifest: MANIFEST });
    const results: BuildResult[] = [];
    rt.onBuild((r) => results.push(r));
    rt.writeFile('src/main.ts', 'console.log(2)');
    await expect.poll(() => worker.posted.some((m) => m.type === 'build')).toBe(true);
    await rt.destroy();
    await flush();
    expect(tracker.reasons).toEqual([]);
    expect(results).toEqual([]);
  });

  it('an explicit build() in flight when destroy() runs rejects with an AbortError', async () => {
    const worker = new FakeWorker('ok', 'manual');
    const { rt } = runtimeWith(worker);
    await rt.boot({ files: FILES, manifest: MANIFEST });
    const build = rt.build();
    await expect.poll(() => worker.posted.some((m) => m.type === 'build')).toBe(true);
    await rt.destroy();
    expect(await settledWithin(build)).toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError' },
    });
  });
});
