/**
 * One takedown job (T-024, docs/02 R9): a moderator took a build down, so its permanent
 * screenshot must go. Delete `screenshots/{battle}/{build}.*` through the Storage API (SQL
 * cannot delete Storage objects: a trigger blocks it, and a row delete would leave the file
 * behind), check that nothing is left, then `complete_takedown(build)`.
 *
 * The build is already hidden everywhere by the time this runs (the admin RPC cleared its
 * name and screenshot path); this job removes the file itself, which stays reachable by
 * its public URL until then. SQL holds this job back while a capture of the same build is
 * still in flight, so the capture cannot upload after the delete.
 *
 * Guard rails: the ids must be canonical UUIDs (never an empty or `/` prefix), only names
 * that start with `{build}.` in the battle's folder are deleted, and nothing is deleted
 * unless the build really was taken down.
 */
import { BUCKET_SCREENSHOTS, type Backend, type Job } from './backend';
import { errorMessage, type Logger } from './log';
import { isScreenshotOf, screenshotPrefix } from './paths';

export interface TakedownDeps {
  backend: Backend;
  log: Logger;
}

export type TakedownOutcome =
  | { result: 'taken_down'; deleted: number }
  | { result: 'retry'; reason: string; attempts: number }
  | { result: 'failed'; reason: string }
  | { result: 'error'; reason: string };

async function giveUpOrRetry(
  backend: Backend,
  job: Job,
  reason: string,
  log: Logger,
): Promise<TakedownOutcome> {
  try {
    const after = await backend.failJob(job.id, reason);
    if (after.status === 'failed') {
      log.warn('takedown.gave_up', { reason, attempts: after.attempts });
      return { result: 'failed', reason };
    }
    log.info('takedown.retry', { reason, attempts: after.attempts, runAfter: after.run_after });
    return { result: 'retry', reason, attempts: after.attempts };
  } catch (e) {
    log.error('takedown.fail_job_failed', { reason, error: errorMessage(e) });
    return { result: 'error', reason: `${reason}; fail_job: ${errorMessage(e)}` };
  }
}

async function screenshotsOf(backend: Backend, battleId: string, buildId: string) {
  const prefix = screenshotPrefix(battleId);
  return (await backend.list(BUCKET_SCREENSHOTS, prefix))
    .filter((e) => !e.isFolder && isScreenshotOf(buildId, e.name))
    .map((e) => `${prefix}${e.name}`);
}

/** Runs one claimed takedown job to an outcome. Never throws. */
export async function processTakedownJob(
  deps: TakedownDeps,
  job: Job,
  signal: AbortSignal,
): Promise<TakedownOutcome> {
  const { backend } = deps;
  const log = deps.log.child({
    job: job.id,
    kind: 'takedown',
    build: job.ref_id,
    attempt: job.attempts,
  });
  try {
    const build = await backend.getBuild(job.ref_id);
    if (!build) return await giveUpOrRetry(backend, job, 'build is missing', log);
    if (!build.taken_down_at) {
      return await giveUpOrRetry(backend, job, 'build is not taken down', log);
    }
    const names = await screenshotsOf(backend, build.battle_id, build.id);
    signal.throwIfAborted();
    const deleted = (await backend.remove(BUCKET_SCREENSHOTS, names)).length;
    const left = await screenshotsOf(backend, build.battle_id, build.id);
    if (left.length > 0) {
      return await giveUpOrRetry(
        backend,
        job,
        `${String(left.length)} screenshots left after delete`,
        log,
      );
    }
    signal.throwIfAborted();
    await backend.completeTakedown(build.id);
    log.info('takedown.done', { listed: names.length, deleted });
    return { result: 'taken_down', deleted };
  } catch (e) {
    const reason = signal.aborted
      ? `aborted: ${errorMessage(signal.reason)}`
      : `unexpected: ${errorMessage(e)}`;
    log.error('takedown.error', { reason });
    return giveUpOrRetry(backend, job, reason, log);
  }
}
