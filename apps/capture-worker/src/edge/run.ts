/**
 * One run of the `jobs` Edge Function (T-034): claim and process due jobs until the queue is
 * empty or the run's window is over. pg_cron starts a run every minute (only when a job is
 * due), so a run never polls: it ends as soon as nothing is left.
 *
 * - Round robin over the kinds (capture, destroy, takedown), one job each per round, so a
 *   capture backlog does not hold deletes back.
 * - New jobs are claimed only during `windowMs` (default 50 s, inside the 1-minute cron
 *   period, so runs rarely overlap; when they do, `claim_job`'s SKIP LOCKED keeps them apart).
 * - At `hardStopMs` (default 140 s, under Supabase Free's 150 s wall clock) jobs still in
 *   flight are aborted and handed back with `fail_job`. If the platform kills the run first
 *   (wall clock, the 2 s CPU limit), the job's 2-minute lease expires and the next run
 *   claims it again (`claim_job` hands out running jobs whose lease is over).
 */
import type { Backend, Job, JobKind } from '../backend';
import { errorMessage, type Logger } from '../log';
import type { JobOutcome, WorkerRunner } from '../runner';

export const RUN_KINDS: readonly JobKind[] = ['capture', 'destroy', 'takedown'];

export interface RunOptions {
  windowMs: number;
  hardStopMs: number;
  kinds?: readonly JobKind[];
}

export interface RunSummary {
  ms: number;
  stoppedBy: 'empty' | 'window' | 'claim-error';
  /** True when the hard stop aborted jobs in flight. */
  hardStopped: boolean;
  jobs: { id: number; kind: JobKind; ref: string; attempt: number; result: JobOutcome['result'] }[];
}

export interface RunDeps {
  backend: Pick<Backend, 'claimJob'>;
  runner: Pick<WorkerRunner, 'runJob' | 'abortInflight'>;
  log: Logger;
  now?: () => number;
}

export async function runJobs(deps: RunDeps, opts: RunOptions): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const kinds = opts.kinds ?? RUN_KINDS;
  const jobs: RunSummary['jobs'] = [];
  const state = { hardStopped: false };
  const hardStop = setTimeout(() => {
    state.hardStopped = true;
    deps.log.warn('run.hard_stop', { afterMs: now() - started });
    deps.runner.abortInflight('the function run reached its time limit');
  }, opts.hardStopMs);

  const record = (job: Job, outcome: JobOutcome) => {
    jobs.push({
      id: job.id,
      kind: job.kind,
      ref: job.ref_id,
      attempt: job.attempts,
      result: outcome.result,
    });
  };

  let stoppedBy: RunSummary['stoppedBy'] = 'empty';
  try {
    rounds: for (;;) {
      let claimed = 0;
      for (const kind of kinds) {
        if (now() - started >= opts.windowMs || state.hardStopped) {
          stoppedBy = 'window';
          break rounds;
        }
        let job: Job | null;
        try {
          job = await deps.backend.claimJob(kind);
        } catch (e) {
          deps.log.error('claim.failed', { kind, error: errorMessage(e) });
          stoppedBy = 'claim-error';
          break rounds;
        }
        if (!job) continue;
        claimed++;
        record(job, await deps.runner.runJob(job));
      }
      if (claimed === 0) break;
    }
  } finally {
    clearTimeout(hardStop);
  }
  return { ms: now() - started, stoppedBy, hardStopped: state.hardStopped, jobs };
}
