/**
 * Error reporting for the worker (T-030): every `error` log line goes to Sentry when
 * `SENTRY_DSN` is set (off otherwise: the reporter is a no-op and nothing is sent).
 *
 * The error lines are the worker's own failures, never a build's: a claim that fails (the
 * database or the API is down), an unexpected exception in a job, a `fail_job` that does not
 * go through, a stop that fails. A render that fails because of the build's code is a
 * `warn` (`capture.render_unusable`) and stays in the logs.
 *
 * Each report is the log message, grouped by it (the fingerprint), with the reason or error
 * text scrubbed by @br/telemetry (signed URLs lose their tokens, user ids in storage paths
 * become `<id>`), and tags: the job kind and id, the attempt, and the build or battle id.
 * The same message is sent at most once a minute (a database outage makes every loop fail
 * every few seconds).
 */
import { createServerReporter, isUuid, type ErrorReporter } from '@br/telemetry';
import type { TelemetrySettings } from './config';
import type { LogFields } from './log';

/** At most one report per log message per this long. */
export const REPORT_INTERVAL_MS = 60_000;

export function workerReporter(
  settings: TelemetrySettings,
  fetchImpl?: typeof fetch,
): ErrorReporter {
  return createServerReporter({
    dsn: settings.sentryDsn,
    service: 'capture-worker',
    release: settings.release === undefined ? undefined : `capture-worker@${settings.release}`,
    environment: settings.environment,
    runtime: { name: 'node', version: process.version },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** The tags of a log line: job kind and id, attempt, build or battle id. */
export function logTags(fields: LogFields): Record<string, string | number> {
  const tags: Record<string, string | number> = {};
  const kind = text(fields['kind']);
  if (kind) tags['job_kind'] = kind;
  if (typeof fields['job'] === 'number') tags['job_id'] = fields['job'];
  if (typeof fields['attempt'] === 'number') tags['attempt'] = fields['attempt'];
  const ref = fields['ref'];
  const build = fields['build'] ?? (kind === 'destroy' ? undefined : ref);
  const battle = fields['battle'] ?? (kind === 'destroy' ? ref : undefined);
  if (isUuid(build)) tags['build_id'] = build;
  if (isUuid(battle)) tags['battle_id'] = battle;
  return tags;
}

/** The logger's `onError`: one Sentry message per error line (throttled per message). */
export function reportLogErrors(
  reporter: ErrorReporter,
  now: () => number = Date.now,
): (msg: string, fields: LogFields) => void {
  const last = new Map<string, number>();
  return (msg, fields) => {
    if (!reporter.enabled) return;
    const t = now();
    const prev = last.get(msg);
    if (prev !== undefined && t - prev < REPORT_INTERVAL_MS) return;
    last.set(msg, t);
    const detail = text(fields['reason']) ?? text(fields['error']);
    reporter.captureMessage(detail ? `${msg}: ${detail}` : msg, {
      level: 'error',
      fingerprint: ['capture-worker', msg],
      tags: logTags(fields),
    });
  };
}
