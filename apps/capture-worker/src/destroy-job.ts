/**
 * One destroy job (docs/03 §3.6, docs/05 §5.5): delete `ephemeral-builds/{battle}/**`
 * through the Storage API (SQL deletes of storage.objects are blocked by a trigger and would
 * leave the files behind), check that nothing is left, then `complete_destroy(battle)`,
 * which stamps `source_destroyed_at` / `destroyed_at`.
 *
 * Guard rails: the battle id must be a canonical UUID (never an empty or `/` prefix), and
 * nothing is deleted unless the battle really is DESTROYED or ABANDONED.
 */
import { BUCKET_EPHEMERAL, type Backend, type Job } from './backend';
import { errorMessage, type Logger } from './log';
import { battlePrefix } from './paths';

export interface DestroyDeps {
  backend: Backend;
  log: Logger;
}

export type DestroyOutcome =
  | { result: 'destroyed'; deleted: number }
  | { result: 'retry'; reason: string; attempts: number }
  | { result: 'failed'; reason: string }
  | { result: 'error'; reason: string };

const DELETE_BATCH = 100;
const MAX_DEPTH = 4; // {battle}/{uid}/autosave/{file}
const MAX_OBJECTS = 10_000;

/** Every object name under `prefix` (which ends with `/`), depth-first. */
export async function listRecursive(
  backend: Backend,
  bucket: string,
  prefix: string,
  depth = 0,
  out: string[] = [],
): Promise<string[]> {
  if (depth > MAX_DEPTH)
    throw new Error(`folder nesting deeper than ${String(MAX_DEPTH)} under ${prefix}`);
  for (const entry of await backend.list(bucket, prefix)) {
    if (!entry.name || entry.name.includes('/') || entry.name === '.' || entry.name === '..') {
      throw new Error(`unexpected entry name ${JSON.stringify(entry.name)} under ${prefix}`);
    }
    if (entry.isFolder) {
      await listRecursive(backend, bucket, `${prefix}${entry.name}/`, depth + 1, out);
    } else {
      out.push(`${prefix}${entry.name}`);
    }
    if (out.length > MAX_OBJECTS)
      throw new Error(`more than ${String(MAX_OBJECTS)} objects under ${prefix}`);
  }
  return out;
}

async function giveUpOrRetry(
  backend: Backend,
  job: Job,
  reason: string,
  log: Logger,
): Promise<DestroyOutcome> {
  try {
    const after = await backend.failJob(job.id, reason);
    if (after.status === 'failed') {
      log.warn('destroy.gave_up', { reason, attempts: after.attempts });
      return { result: 'failed', reason };
    }
    log.info('destroy.retry', { reason, attempts: after.attempts, runAfter: after.run_after });
    return { result: 'retry', reason, attempts: after.attempts };
  } catch (e) {
    log.error('destroy.fail_job_failed', { reason, error: errorMessage(e) });
    return { result: 'error', reason: `${reason}; fail_job: ${errorMessage(e)}` };
  }
}

/** Runs one claimed destroy job to an outcome. Never throws. */
export async function processDestroyJob(
  deps: DestroyDeps,
  job: Job,
  signal: AbortSignal,
): Promise<DestroyOutcome> {
  const { backend } = deps;
  const log = deps.log.child({
    job: job.id,
    kind: 'destroy',
    battle: job.ref_id,
    attempt: job.attempts,
  });
  try {
    const prefix = battlePrefix(job.ref_id);
    const phase = await backend.getBattlePhase(job.ref_id);
    if (phase !== 'destroyed' && phase !== 'abandoned') {
      return await giveUpOrRetry(
        backend,
        job,
        `battle is ${phase ?? 'missing'}, not destroyed`,
        log,
      );
    }
    const names = await listRecursive(backend, BUCKET_EPHEMERAL, prefix);
    let deleted = 0;
    for (let i = 0; i < names.length; i += DELETE_BATCH) {
      signal.throwIfAborted();
      deleted += (await backend.remove(BUCKET_EPHEMERAL, names.slice(i, i + DELETE_BATCH))).length;
    }
    const left = await listRecursive(backend, BUCKET_EPHEMERAL, prefix);
    if (left.length > 0) {
      return await giveUpOrRetry(
        backend,
        job,
        `${String(left.length)} objects left after delete`,
        log,
      );
    }
    signal.throwIfAborted();
    await backend.completeDestroy(job.ref_id);
    log.info('destroy.done', { listed: names.length, deleted });
    return { result: 'destroyed', deleted };
  } catch (e) {
    const reason = signal.aborted
      ? `aborted: ${errorMessage(signal.reason)}`
      : `unexpected: ${errorMessage(e)}`;
    log.error('destroy.error', { reason });
    return giveUpOrRetry(backend, job, reason, log);
  }
}
