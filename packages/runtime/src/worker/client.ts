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
 * - A start never hangs (T-039): the worker reports progress (`init-progress`: it runs, the
 *   esbuild.wasm response started, bytes arrived, the download is complete). A start with no
 *   progress for `initStallMs` (default 15 s) is stopped and retried once with a fresh
 *   worker. If the retry stalls too, `init()` rejects with a `BundlerInitTimeoutError`.
 * - A failed init (worker script failed to load, `createWorker` threw, esbuild-wasm failed,
 *   both starts stalled) terminates that worker and is not cached: the next `init()` /
 *   `build()` starts over with a fresh worker.
 */
import type { BuildResult, BundleInput } from '../types';
import type { InitStage, WorkerRequest, WorkerResponse } from './protocol';

export type { InitStage } from './protocol';

/**
 * A start with no progress for this long is stopped (T-039). esbuild.wasm is 13.6 MB (about
 * 3–4 MB compressed on the wire), so a slow link takes a while, but bytes keep arriving and
 * every chunk counts as progress. 15 s with not one byte, or a compile that does not finish
 * within 15 s of the last one (~0.2 s on a laptop), is a stall, not a slow network.
 */
export const DEFAULT_INIT_STALL_MS = 15_000;

/** Worker starts per `init()` when they stall: the first one and one automatic retry. */
export const INIT_ATTEMPTS = 2;

/** How one worker start ended (`onInitAttempt`). */
export interface InitAttemptReport {
  /** 1 for the first worker of an `init()`, 2 for the automatic retry after a stall. */
  attempt: number;
  outcome: 'ready' | 'stalled' | 'error';
  /** How far it got. */
  stage: InitStage;
  /** From this worker's creation to the outcome. */
  elapsedMs: number;
  /** Bytes of esbuild.wasm it received. */
  loadedBytes: number;
}

interface BundlerClientBaseOptions {
  /** URL of `esbuild.wasm` (served by the app origin, ideally preloaded during the lobby). */
  wasmUrl: string;
  /** Base URL of the esm.sh-compatible package CDN. */
  cdnBaseUrl: string;
  /**
   * A start with no progress for this long is stopped and retried once with a fresh worker.
   * Default `DEFAULT_INIT_STALL_MS` (15 s).
   */
  initStallMs?: number;
  /**
   * Called when a worker start ends: ready, stalled or failed (telemetry). Not called for a
   * start that `terminate()` cut short. Exceptions are ignored.
   */
  onInitAttempt?: (report: InitAttemptReport) => void;
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
  /**
   * `init()` -> esbuild-wasm ready, measured on the main thread: `new Worker()` to ready, plus
   * the stalled first start when it took a retry.
   */
  coldStartMs: number;
  /** Time spent inside the worker downloading and compiling/instantiating the wasm module. */
  wasmInitMs: number;
  /** Worker starts it took: 1, or 2 when the first one stalled. */
  attempts: number;
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

function formatMs(ms: number): string {
  return ms >= 1000 ? `${String(Math.round(ms / 1000))} s` : `${String(ms)} ms`;
}

/** Rejection reason of `init()` when every start stalled (T-039). */
export class BundlerInitTimeoutError extends Error {
  override readonly name = 'BundlerInitTimeoutError';
  constructor(
    /** Where the last start stalled. */
    readonly stage: InitStage,
    readonly stallMs: number,
    readonly attempts: number,
  ) {
    super(
      `${stage === 'compile' ? 'esbuild-wasm stopped while starting' : 'the download stalled'} ` +
        `(no progress for ${formatMs(stallMs)}, ${String(attempts)} attempts)`,
    );
  }
}

/** True for the rejection of an `init()` whose starts all stalled. */
export function isInitTimeout(e: unknown): e is BundlerInitTimeoutError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'BundlerInitTimeoutError'
  );
}

/**
 * What a player reads when the bundler could not start: the `bundler-init-failed`
 * diagnostic, and the app's failed state after a rejected `boot()`.
 */
export function bundlerStartFailureText(e: unknown): string {
  return `Couldn't start the bundler: ${e instanceof Error ? e.message : String(e)}`;
}

/** One `init()`: up to INIT_ATTEMPTS worker starts, settled once. */
interface InitRun {
  promise: Promise<BootTimings>;
  resolve: (t: BootTimings) => void;
  reject: (reason: Error) => void;
  started: number;
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
  /** The current init; null before the first init, after a failure and after terminate. */
  private run: InitRun | null = null;
  /** Fires when the current worker start shows no progress for `initStallMs`. */
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.run) return this.run.promise;
    let resolve!: (t: BootTimings) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<BootTimings>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const run: InitRun = { promise, resolve, reject, started: performance.now() };
    this.run = run;
    this.startWorker(run, 1);
    return promise;
  }

  async build(input: BundleInput): Promise<BuildResult> {
    const init = this.init();
    const run = this.run;
    await init;
    const worker = this.worker;
    // terminate() (and possibly a new init) ran while this call waited for init.
    if (this.run !== run || run === null || !worker) throw new BundlerAbortError();
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
    const run = this.run;
    this.run = null;
    this.stopWorker();
    const reason = new BundlerAbortError();
    run?.reject(reason); // no-op when init had already resolved
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  /** Starts worker number `attempt` of `run`, with its stall timer. */
  private startWorker(run: InitRun, attempt: number): void {
    const started = performance.now();
    const stallMs = this.opts.initStallMs ?? DEFAULT_INIT_STALL_MS;
    let stage: InitStage = 'worker';
    let loaded = 0;
    let ready = false;
    let worker: Worker | null = null;
    // This start is still the one that counts: `run` is unsettled and `worker` is its worker.
    const current = () => this.run === run && this.worker === worker;
    const report = (outcome: InitAttemptReport['outcome']) => {
      try {
        this.opts.onInitAttempt?.({
          attempt,
          outcome,
          stage,
          elapsedMs: performance.now() - started,
          loadedBytes: loaded,
        });
      } catch {
        // Telemetry never breaks the bundler.
      }
    };
    const fail = (reason: Error) => {
      // Already settled (terminate() or a second error) or superseded: nothing to do.
      if (!current()) return;
      report('error');
      this.run = null;
      this.stopWorker();
      run.reject(reason);
    };
    const stalled = () => {
      if (!current()) return;
      report('stalled');
      this.stopWorker();
      if (attempt < INIT_ATTEMPTS) {
        this.startWorker(run, attempt + 1);
        return;
      }
      this.run = null;
      run.reject(new BundlerInitTimeoutError(stage, stallMs, attempt));
    };
    const armStallTimer = () => {
      this.clearStallTimer();
      this.stallTimer = setTimeout(stalled, stallMs);
    };

    try {
      worker = this.opts.createWorker
        ? this.opts.createWorker()
        : new Worker(this.opts.workerUrl, { type: 'module' });
    } catch (e) {
      fail(toError(e));
      return;
    }
    const w = worker;
    this.worker = w;
    w.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
      if (this.worker !== w) return; // a terminated worker's late message
      const msg = e.data;
      switch (msg.type) {
        case 'init-progress':
          if (ready) break;
          stage = msg.stage;
          loaded = msg.loaded;
          armStallTimer();
          break;
        case 'init-done':
          if (ready) break;
          ready = true;
          this.clearStallTimer();
          report('ready');
          run.resolve({
            coldStartMs: performance.now() - run.started,
            wasmInitMs: msg.wasmInitMs,
            attempts: attempt,
          });
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
    w.addEventListener('error', (e) => {
      // Before init-done this means the worker script failed to load or crashed while
      // starting. Afterwards, the worker reports build errors as build results itself.
      if (!ready) fail(new Error(`bundler worker failed: ${e.message}`));
    });
    armStallTimer();
    try {
      w.postMessage({ type: 'init', wasmUrl: this.opts.wasmUrl } satisfies WorkerRequest);
    } catch (e) {
      fail(toError(e));
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private stopWorker(): void {
    this.clearStallTimer();
    this.worker?.terminate();
    this.worker = null;
  }
}
