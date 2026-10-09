/**
 * The self-hosted worker's polling loops: each loop calls `claim_job` and, when there is
 * nothing to do, sleeps with exponential backoff (idleMinMs → idleMaxMs, reset by the next
 * job). The `jobs` Edge Function (T-034, edge/run.ts) has no loops of its own: pg_cron starts
 * a run every minute, which claims jobs and calls `runJob` here until the queue is empty or
 * its time is up.
 *
 * - `captureConcurrency` capture loops (default 1), one destroy loop and one takedown loop
 *   (T-024: moderation takedowns delete a build's screenshot).
 * - Each job runs under its own AbortSignal that fires at `jobTimeoutMs`, well inside the
 *   2-minute lease, so a stuck job is given back (`fail_job`) before another worker could
 *   claim it.
 * - `stop()`: no new claims; jobs in flight get `shutdownGraceMs` to finish, then they are
 *   aborted, which makes them call `fail_job` ("aborted: worker shutting down") so the job
 *   is retried after its backoff instead of waiting for the lease to expire.
 */
import type { Backend, Job, JobKind } from './backend';
import type { CaptureBudget } from './budget';
import { processCaptureJob, type CaptureConfig, type CaptureOutcome } from './capture-job';
import { processDestroyJob, type DestroyOutcome } from './destroy-job';
import { processTakedownJob, type TakedownOutcome } from './takedown-job';
import type { CaptureImaging } from './imaging';
import { errorMessage, type Logger } from './log';
import type { Renderer } from './renderer';

export interface RunnerOptions {
  captureConcurrency: number;
  idleMinMs: number;
  idleMaxMs: number;
  jobTimeoutMs: number;
  shutdownGraceMs: number;
  /** Which loops `start()` runs. Default all three. */
  kinds?: readonly JobKind[];
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  captureConcurrency: 1,
  idleMinMs: 1000,
  idleMaxMs: 15_000,
  jobTimeoutMs: 90_000,
  shutdownGraceMs: 30_000,
};

export interface RunnerDeps {
  backend: Backend;
  renderer: Renderer;
  /** `sharpImaging` (worker) or `webpImaging` (Edge Function). */
  imaging: CaptureImaging;
  /** The daily Browser Rendering budget (Edge Function only). */
  budget?: CaptureBudget | undefined;
  capture: CaptureConfig;
  log: Logger;
}

export type JobOutcome = CaptureOutcome | DestroyOutcome | TakedownOutcome;

interface InFlight {
  job: Job;
  ctrl: AbortController;
}

export class WorkerRunner {
  private readonly opts: RunnerOptions;
  private stopping = false;
  private readonly stopCtrl = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly inflight = new Set<InFlight>();

  constructor(
    private readonly deps: RunnerDeps,
    opts: Partial<RunnerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_RUNNER_OPTIONS, ...opts };
    if (this.opts.captureConcurrency < 1) throw new Error('captureConcurrency must be >= 1');
  }

  /** Starts the polling loops. */
  start(): void {
    if (this.loops.length > 0) throw new Error('already started');
    const kinds = this.opts.kinds ?? ['capture', 'destroy', 'takedown'];
    if (kinds.includes('capture')) {
      for (let i = 0; i < this.opts.captureConcurrency; i++) {
        this.loops.push(this.loop('capture', i));
      }
    }
    if (kinds.includes('destroy')) this.loops.push(this.loop('destroy', 0));
    if (kinds.includes('takedown')) this.loops.push(this.loop('takedown', 0));
  }

  /**
   * Stops claiming, waits up to `shutdownGraceMs` for the jobs in flight, then aborts them
   * (they record the abort with `fail_job`) and waits for the loops to end.
   */
  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.stopCtrl.abort();
      this.deps.log.info('worker.stopping', { inflight: this.inflight.size });
    }
    const all = Promise.all(this.loops);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      all.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, this.opts.shutdownGraceMs);
      }),
    ]);
    clearTimeout(graceTimer);
    if (!finished) {
      this.deps.log.warn('worker.abandoning', { jobs: [...this.inflight].map((f) => f.job.id) });
      for (const f of this.inflight) f.ctrl.abort(new Error('worker shutting down'));
      await all;
    }
    this.deps.log.info('worker.stopped');
  }

  /**
   * Aborts every job in flight now; each records the abort with `fail_job` and is retried
   * after its backoff. The `jobs` Edge Function calls this before its wall-clock limit.
   */
  abortInflight(reason: string): void {
    for (const f of this.inflight) f.ctrl.abort(new Error(reason));
  }

  /**
   * Processes jobs of one kind until the queue has none ready (or `max` were processed).
   * For `--once` runs and tests; independent of `start()`.
   */
  async drain(kind: JobKind, max = 100): Promise<{ job: Job; outcome: JobOutcome }[]> {
    const out: { job: Job; outcome: JobOutcome }[] = [];
    while (out.length < max && !this.stopping) {
      const job = await this.deps.backend.claimJob(kind);
      if (!job) break;
      out.push({ job, outcome: await this.runJob(job) });
    }
    return out;
  }

  /** Runs one claimed job with its own timeout. Never throws. */
  async runJob(job: Job): Promise<JobOutcome> {
    const ctrl = new AbortController();
    const entry: InFlight = { job, ctrl };
    const timer = setTimeout(() => {
      ctrl.abort(new Error(`job timeout after ${String(this.opts.jobTimeoutMs)} ms`));
    }, this.opts.jobTimeoutMs);
    this.inflight.add(entry);
    const started = Date.now();
    const log = this.deps.log.child({ job: job.id, kind: job.kind, ref: job.ref_id });
    log.info('job.start', { attempt: job.attempts });
    try {
      const outcome =
        job.kind === 'capture'
          ? await processCaptureJob(
              {
                backend: this.deps.backend,
                renderer: this.deps.renderer,
                imaging: this.deps.imaging,
                budget: this.deps.budget,
                config: this.deps.capture,
                log: this.deps.log,
              },
              job,
              ctrl.signal,
            )
          : job.kind === 'destroy'
            ? await processDestroyJob(
                { backend: this.deps.backend, log: this.deps.log },
                job,
                ctrl.signal,
              )
            : await processTakedownJob(
                { backend: this.deps.backend, log: this.deps.log },
                job,
                ctrl.signal,
              );
      log.info('job.end', { result: outcome.result, ms: Date.now() - started });
      return outcome;
    } catch (e) {
      // process* never throw; this is a bug guard.
      log.error('job.crashed', { error: errorMessage(e) });
      return { result: 'error', reason: errorMessage(e) };
    } finally {
      clearTimeout(timer);
      this.inflight.delete(entry);
    }
  }

  private async loop(kind: JobKind, index: number): Promise<void> {
    const log = this.deps.log.child({ loop: `${kind}#${String(index)}` });
    let idle = this.opts.idleMinMs;
    while (!this.stopping) {
      let job: Job | null;
      try {
        job = await this.deps.backend.claimJob(kind);
      } catch (e) {
        log.error('claim.failed', { error: errorMessage(e), retryInMs: idle });
        await this.pause(idle);
        idle = Math.min(idle * 2, this.opts.idleMaxMs);
        continue;
      }
      if (!job) {
        await this.pause(idle);
        idle = Math.min(idle * 2, this.opts.idleMaxMs);
        continue;
      }
      idle = this.opts.idleMinMs;
      await this.runJob(job);
    }
  }

  /** Sleeps `ms`, or less when `stop()` is called. */
  private pause(ms: number): Promise<void> {
    if (this.stopCtrl.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.stopCtrl.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.stopCtrl.signal.addEventListener('abort', done, { once: true });
    });
  }
}
