/**
 * Main-thread side of the bundler worker: spawns it, initializes esbuild-wasm, and turns
 * build requests into promises. Results of superseded builds are still delivered (callers
 * decide whether to use them); `latestId` lets them check.
 *
 * Lifecycle guarantees:
 * - `terminate()` settles everything that is pending: a running `init()` and every build
 *   (in flight or still waiting for init) reject with a `BundlerAbortError`
 *   (`name === 'AbortError'`). Nothing is left hanging, so `boot()` racing `destroy()`
 *   (React StrictMode runs effects twice) always settles.
 * - A failed init (worker script failed to load, `createWorker` threw, esbuild-wasm failed)
 *   terminates that worker and is not cached: the next `init()` / `build()` starts over with
 *   a fresh worker.
 */
import type { BuildResult, BundleInput } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

interface BundlerClientBaseOptions {
  /** URL of `esbuild.wasm` (served by the app origin, ideally preloaded during the lobby). */
  wasmUrl: string;
  /** Base URL of the esm.sh-compatible package CDN. */
  cdnBaseUrl: string;
}

/**
 * Exactly one way to create the worker: a URL of the bundled `bundler.worker` module, or a
 * factory (tests, or a bundler that needs the literal `new Worker(new URL(...))` to find
 * the worker entry, like Turbopack).
 */
export type BundlerClientOptions = BundlerClientBaseOptions &
  (
    | {
        /** URL of the bundled `bundler.worker` module (started as a module worker). */
        workerUrl: string | URL;
        createWorker?: never;
      }
    | {
        workerUrl?: never;
        /** Creates the bundler worker. */
        createWorker: () => Worker;
      }
  );

export interface BootTimings {
  /** `new Worker()` -> esbuild-wasm ready, measured on the main thread. */
  coldStartMs: number;
  /** Time spent inside the worker compiling/instantiating the wasm module. */
  wasmInitMs: number;
}

/** Rejection reason of `init()` / `build()` calls cut short by `terminate()`. */
export class BundlerAbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'Bundler terminated.') {
    super(message);
  }
}

/** True for the rejection of a call that `terminate()` cut short. */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

interface InitAttempt {
  promise: Promise<BootTimings>;
  reject: (reason: Error) => void;
}

interface PendingBuild {
  resolve: (r: BuildResult) => void;
  reject: (reason: Error) => void;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export class BundlerClient {
  private readonly opts: BundlerClientOptions;
  private worker: Worker | null = null;
  /** The current init attempt; null before the first init, after a failure and after terminate. */
  private attempt: InitAttempt | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingBuild>();
  latestId = 0;

  constructor(opts: BundlerClientOptions) {
    // The union type already requires this; the check is for untyped (JS) callers.
    const untyped = opts as { workerUrl?: unknown; createWorker?: unknown };
    if (typeof untyped.createWorker !== 'function' && untyped.workerUrl === undefined) {
      throw new TypeError('BundlerClient: pass either workerUrl or createWorker.');
    }
    this.opts = opts;
  }

  init(): Promise<BootTimings> {
    if (this.attempt) return this.attempt.promise;
    let resolveInit!: (t: BootTimings) => void;
    let rejectInit!: (reason: Error) => void;
    const promise = new Promise<BootTimings>((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });
    const attempt: InitAttempt = { promise, reject: rejectInit };
    this.attempt = attempt;

    const fail = (reason: Error) => {
      // Already settled (terminate() or a second error) or superseded: nothing to do.
      if (this.attempt !== attempt) return;
      this.attempt = null;
      this.stopWorker();
      rejectInit(reason);
    };

    const started = performance.now();
    let worker: Worker;
    try {
      worker = this.opts.createWorker
        ? this.opts.createWorker()
        : new Worker(this.opts.workerUrl, { type: 'module' });
    } catch (e) {
      fail(toError(e));
      return promise;
    }
    this.worker = worker;
    let ready = false;
    worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return; // a terminated worker's late message
      const msg = e.data;
      switch (msg.type) {
        case 'init-done':
          ready = true;
          resolveInit({ coldStartMs: performance.now() - started, wasmInitMs: msg.wasmInitMs });
          break;
        case 'init-error':
          fail(new Error(`esbuild-wasm failed to initialize: ${msg.message}`));
          break;
        case 'build-result': {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          p?.resolve(msg.result);
          break;
        }
      }
    });
    worker.addEventListener('error', (e) => {
      // Before init-done this means the worker script failed to load or crashed while
      // starting. Afterwards, the worker reports build errors as build results itself.
      if (!ready) fail(new Error(`bundler worker failed: ${e.message}`));
    });
    try {
      worker.postMessage({ type: 'init', wasmUrl: this.opts.wasmUrl } satisfies WorkerRequest);
    } catch (e) {
      fail(toError(e));
    }
    return promise;
  }

  async build(input: BundleInput): Promise<BuildResult> {
    const init = this.init();
    const attempt = this.attempt;
    await init;
    const worker = this.worker;
    // terminate() (and possibly a new init) ran while this call waited for init.
    if (this.attempt !== attempt || attempt === null || !worker) throw new BundlerAbortError();
    const id = this.nextId++;
    this.latestId = id;
    return new Promise<BuildResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({
        type: 'build',
        id,
        input,
        cdnBaseUrl: this.opts.cdnBaseUrl,
      } satisfies WorkerRequest);
    });
  }

  /**
   * Stops the worker. A pending `init()` and every pending `build()` reject with a
   * `BundlerAbortError`. The client can be used again: the next call starts a new worker.
   */
  terminate(): void {
    const attempt = this.attempt;
    this.attempt = null;
    this.stopWorker();
    const reason = new BundlerAbortError();
    attempt?.reject(reason); // no-op when init had already resolved
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
