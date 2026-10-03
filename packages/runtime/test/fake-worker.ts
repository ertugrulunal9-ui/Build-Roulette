/**
 * A scripted stand-in for the bundler Web Worker, so BundlerClient / EsmBrowserRuntime
 * lifecycles (init failures, terminate races) can be tested in Node without esbuild-wasm.
 */
import type { BuildResult } from '../src/types';
import type { WorkerRequest, WorkerResponse } from '../src/worker/protocol';

type InitBehavior = 'ok' | 'fail' | 'manual';
type BuildBehavior = 'ok' | 'manual';

export class FakeWorker {
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  private readonly messageListeners = new Set<(e: { data: WorkerResponse }) => void>();
  private readonly errorListeners = new Set<(e: { message: string }) => void>();

  constructor(
    private readonly init: InitBehavior,
    private readonly build: BuildBehavior = 'ok',
  ) {}

  addEventListener(type: 'message' | 'error', fn: (e: never) => void): void {
    if (type === 'message') this.messageListeners.add(fn as (e: { data: WorkerResponse }) => void);
    else this.errorListeners.add(fn as (e: { message: string }) => void);
  }

  postMessage(msg: WorkerRequest): void {
    if (this.terminated) throw new Error('postMessage on a terminated FakeWorker');
    this.posted.push(msg);
    // Answer asynchronously, like a real worker.
    queueMicrotask(() => {
      if (this.terminated) return;
      if (msg.type === 'init' && this.init === 'ok')
        this.emit({ type: 'init-done', wasmInitMs: 1 });
      if (msg.type === 'init' && this.init === 'fail')
        this.emit({ type: 'init-error', message: 'wasm 404' });
      if (msg.type === 'build' && this.build === 'ok')
        this.emit({ type: 'build-result', id: msg.id, result: okResult() });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: WorkerResponse): void {
    for (const fn of this.messageListeners) fn({ data: msg });
  }

  emitError(message: string): void {
    for (const fn of this.errorListeners) fn({ message });
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

export function okResult(): BuildResult {
  return {
    ok: true,
    js: 'console.log(1)',
    css: '',
    importMap: { imports: {} },
    diagnostics: [],
    durationMs: 1,
  };
}

/** Resolves with how `p` settled, or `'pending'` if it has not settled after `ms`. */
export async function settledWithin<T>(
  p: Promise<T>,
  ms = 100,
): Promise<
  { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | 'pending'
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => {
      resolve('pending');
    }, ms);
  });
  try {
    return await Promise.race([
      p.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Collects unhandled promise rejections while a test runs. */
export function trackUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  return {
    reasons,
    stop: () => {
      process.off('unhandledRejection', onRejection);
    },
  };
}

/** Lets pending microtasks, timers and unhandled-rejection detection run. */
export function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
