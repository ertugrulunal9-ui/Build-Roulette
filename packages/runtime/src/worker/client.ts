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
 * - A start never hangs (T-039, T-041): the worker reports progress (`init-progress`: it
 *   runs, the esbuild.wasm response started, bytes arrived, the download is complete).
 *   Until the last byte, a start with no progress for `initStallMs` (default 15 s) is
 *   stopped; after it (the compile stage, where no more progress comes), a start that is not
 *   ready within `initCompileMs` (default 60 s) is. Either is retried once with a fresh
 *   worker. If the retry stalls too, `init()` rejects with a `BundlerInitTimeoutError`. Both
 *   limits count page-awake time (`AwakeClock`): time the page itself did not run is not a
 *   stall of the start.
 * - A failed init (worker script failed to load, `createWorker` threw, esbuild-wasm failed,
 *   both starts stalled) terminates that worker and is not cached: the next `init()` /
 *   `build()` starts over with a fresh worker.
 */
import type { BuildResult, BundleInput } from '../types';
import { AwakeClock } from './awake-clock';
import type { InitStage, WorkerRequest, WorkerResponse } from './protocol';

export type { InitStage } from './protocol';

/**
 * Until the last byte of esbuild.wasm, a start with no progress for this long is stopped
 * (T-039). esbuild.wasm is 13.6 MB (about 3–4 MB compressed on the wire), so a slow link takes
 * a while, but bytes keep arriving and every chunk counts as progress. 15 s without one byte
 * is a stall, not a slow network.
 */
export const DEFAULT_INIT_STALL_MS = 15_000;

/**
 * After the last byte, how long esbuild-wasm may take to get ready (T-041). This stage sends
 * no progress: V8 finishes compiling the module, then `esbuild.initialize` instantiates it and
 * runs Go's runtime start, which blocks the worker's thread the whole time (measured), so not
 * even a worker heartbeat could show that it moves. Nothing in it waits for the network, so
 * it never stalls like a download does; it only gets slow when the CPU is short. Measured
 * (docs/03, "Bundler start"): 0.1–0.4 s alone, at most 0.9 s for 8 concurrent starts next to
 * 8 busy loops on 4 vCPUs, at most 2.9 s for 8 starts squeezed onto 1 CPU next to 4–12 busy
 * loops. 60 s is 20 times the worst of those: it only stops a start that cannot finish (a
 * wedged worker), and still fails visibly within about 2 minutes.
 */
export const DEFAULT_INIT_COMPILE_MS = 60_000;

/** Worker starts per `init()` when they stall: the first one and one automatic retry. */
export const INIT_ATTEMPTS = 2;

/** While a start runs, the page-awake clock ticks this often (and the limits are checked). */
export const INIT_TICK_MS = 250;

/**
 * One tick adds at most this much page-awake time. A tick that comes later shows that the
 * page itself did not run meanwhile (the renderer got no CPU at all); that time is not counted
 * against the start, whose worker did not run either. A busy page under CPU contention runs
 * its timers up to a few hundred ms late, which still counts in full.
 */
export const INIT_MAX_TICK_CREDIT_MS = 1_000;

/** How one worker start ended (`onInitAttempt`). */
export interface InitAttemptReport {
  /** 1 for the first worker of an `init()`, 2 for the automatic retry after a stall. */
  attempt: number;
  outcome: 'ready' | 'stalled' | 'error';
  /** How far it got. */
  stage: InitStage;
  /** From this worker's creation to the outcome. */
  elapsedMs: number;
  /**
   * Page-awake time in `elapsedMs` (T-041): `elapsedMs` minus the time the page itself did
   * not run. The limits are measured in this time.
   */
  awakeMs: number;
  /** Bytes of esbuild.wasm it received. */
  loadedBytes: number;
}

interface BundlerClientBaseOptions {
  /** URL of `esbuild.wasm` (served by the app origin, ideally preloaded during the lobby). */
  wasmUrl: string;
  /** Base URL of the esm.sh-compatible package CDN. */
  cdnBaseUrl: string;
  /**
   * Until the last byte of esbuild.wasm, a start with no progress for this long (page-awake
   * time) is stopped and retried once with a fresh worker. Default `DEFAULT_INIT_STALL_MS`
   * (15 s).
   */
  initStallMs?: number;
  /**
   * After the last byte, a start that is not ready within this long (page-awake time) is
   * stopped and retried once with a fresh worker. Default `DEFAULT_INIT_COMPILE_MS` (60 s).
   */
  initCompileMs?: number;
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
    /** The limit it went over: `initStallMs`, or `initCompileMs` for stage `compile`. */
    readonly stallMs: number,
    readonly attempts: number,
  ) {
    super(
      stage === 'compile'
        ? `esbuild-wasm stopped while starting (not ready ${formatMs(stallMs)} after the download, ${String(attempts)} attempts)`
        : `the download stalled (no progress for ${formatMs(stallMs)}, ${String(attempts)} attempts)`,
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
  /** The current worker start's tick: advances its awake clock and checks its limits. */
  private startTicker: ReturnType<typeof setInterval> | null = null;
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

  /**
   * Starts worker number `attempt` of `run`, with its limits: `initStallMs` without progress
   * until the last byte, then `initCompileMs` to get ready, both in page-awake time.
   */
  private startWorker(run: InitRun, attempt: number): void {
    const started = performance.now();
    const stallMs = this.opts.initStallMs ?? DEFAULT_INIT_STALL_MS;
    const compileMs = this.opts.initCompileMs ?? DEFAULT_INIT_COMPILE_MS;
    const clock = new AwakeClock(started, INIT_MAX_TICK_CREDIT_MS);
    let stage: InitStage = 'worker';
    let loaded = 0;
    let ready = false;
    /** Awake time of the last progress (or of the worker's creation). */
    let progressAwake = 0;
    let worker: Worker | null = null;
    // This start is still the one that counts: `run` is unsettled and `worker` is its worker.
    const current = () => this.run === run && this.worker === worker;
    const limit = () => (stage === 'compile' ? compileMs : stallMs);
    const report = (outcome: InitAttemptReport['outcome']) => {
      try {
        const now = performance.now();
        this.opts.onInitAttempt?.({
          attempt,
          outcome,
          stage,
          elapsedMs: now - started,
          awakeMs: clock.at(now),
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
      run.reject(new BundlerInitTimeoutError(stage, limit(), attempt));
    };
    const tick = () => {
      if (clock.tick(performance.now()) - progressAwake >= limit()) stalled();
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
          progressAwake = clock.at(performance.now());
          break;
        case 'init-done':
          if (ready) break;
          ready = true;
          this.stopStartTicker();
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
    this.stopStartTicker();
    this.startTicker = setInterval(tick, INIT_TICK_MS);
    try {
      w.postMessage({ type: 'init', wasmUrl: this.opts.wasmUrl } satisfies WorkerRequest);
    } catch (e) {
      fail(toError(e));
    }
  }

  private stopStartTicker(): void {
    if (this.startTicker !== null) clearInterval(this.startTicker);
    this.startTicker = null;
  }

  private stopWorker(): void {
    this.stopStartTicker();
    this.worker?.terminate();
    this.worker = null;
  }
}
