/**
 * What the /admin Health section flags (T-030): the signals of `admin_ops_health` read
 * against the thresholds the runbooks use (docs/runbooks/). Pure, unit-tested.
 */
import type { OpsHealth } from './types';

export type Runbook =
  | 'stuck-battle'
  | 'capture-backlog'
  | 'supabase-outage'
  | 'removed-content-still-visible'
  | 'takedown-abuse';

export interface HealthFinding {
  area: 'battles' | 'jobs' | 'cron' | 'ttl';
  text: string;
  runbook: Runbook;
}

/** A pending job older than this is a backlog (a capture normally takes seconds). */
export const JOB_BACKLOG_S = 300;
/** DESTROYED but the files are still there after this long. */
export const DESTROY_LAG_S = 600;
/** How stale a sweep's last run may be (its schedule plus slack). */
export const SWEEP_MAX_AGE_S: Record<string, number> = {
  'br-sweep-deadlines': 60,
  'br-sweep-ttl': 20 * 60,
};

function age(iso: string, now: number): number {
  return Math.round((now - Date.parse(iso)) / 1000);
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return '–';
  if (seconds < 90) return `${String(seconds)} s`;
  if (seconds < 90 * 60) return `${String(Math.round(seconds / 60))} min`;
  if (seconds < 48 * 3600) return `${String(Math.round(seconds / 3600))} h`;
  return `${String(Math.round(seconds / 86400))} d`;
}

/** Everything that needs a look, worst first; empty when all is well. */
export function assessHealth(h: OpsHealth, now: number = Date.now()): HealthFinding[] {
  const out: HealthFinding[] = [];
  const b = h.battles;
  if (b.stuck_total > 0) {
    const oldest = [...b.overdue].sort((x, y) => y.oldest_overdue_s - x.oldest_overdue_s)[0];
    out.push({
      area: 'battles',
      text: `${String(b.stuck_total)} battle${b.stuck_total === 1 ? '' : 's'} past the deadline and not moving${
        oldest ? ` (oldest: ${oldest.phase}, ${formatAge(oldest.oldest_overdue_s)} overdue)` : ''
      }`,
      runbook: 'stuck-battle',
    });
  }
  if (b.destroy_pending.count > 0 && (b.destroy_pending.oldest_s ?? 0) > DESTROY_LAG_S) {
    out.push({
      area: 'battles',
      text: `${String(b.destroy_pending.count)} finished battle(s) whose files are not deleted yet (oldest ${formatAge(b.destroy_pending.oldest_s)})`,
      runbook: 'capture-backlog',
    });
  }
  for (const j of h.jobs) {
    if (j.failed_last_hour > 0) {
      out.push({
        area: 'jobs',
        text: `${j.kind}: ${String(j.failed_last_hour)} job(s) failed for good in the last hour`,
        runbook: j.kind === 'takedown' ? 'takedown-abuse' : 'capture-backlog',
      });
    }
    if ((j.oldest_pending_s ?? 0) > JOB_BACKLOG_S) {
      out.push({
        area: 'jobs',
        text: `${j.kind}: ${String(j.queued + j.running)} pending, the oldest for ${formatAge(j.oldest_pending_s)}`,
        runbook: j.kind === 'takedown' ? 'takedown-abuse' : 'capture-backlog',
      });
    }
    if (j.lease_expired > 0) {
      out.push({
        area: 'jobs',
        text: `${j.kind}: ${String(j.lease_expired)} running job(s) whose worker stopped reporting`,
        runbook: 'capture-backlog',
      });
    }
  }
  if (!h.cron.available) {
    out.push({
      area: 'cron',
      text: 'pg_cron run history is not readable',
      runbook: 'stuck-battle',
    });
  } else {
    for (const c of h.cron.jobs) {
      if (!c.active) {
        out.push({ area: 'cron', text: `${c.name} is not active`, runbook: 'stuck-battle' });
      }
      if (c.failed_last_hour > 0) {
        out.push({
          area: 'cron',
          text: `${c.name}: ${String(c.failed_last_hour)} failed run(s) in the last hour`,
          runbook: 'supabase-outage',
        });
      }
      const maxAge = SWEEP_MAX_AGE_S[c.name];
      if (maxAge !== undefined && (!c.last_run || age(c.last_run.start, now) > maxAge)) {
        out.push({
          area: 'cron',
          text: `${c.name} has not run for ${c.last_run ? formatAge(age(c.last_run.start, now)) : 'ever'}`,
          runbook: 'stuck-battle',
        });
      }
    }
  }
  const t = h.ttl;
  if (
    t.battles_past_ttl > 0 ||
    t.ephemeral_objects_past_ttl > 0 ||
    t.ephemeral_objects_of_destroyed > 0
  ) {
    out.push({
      area: 'ttl',
      text: `TTL leftovers: ${String(t.battles_past_ttl)} battle(s) older than 24 h not destroyed, ${String(t.ephemeral_objects_past_ttl)} file(s) older than 24 h, ${String(t.ephemeral_objects_of_destroyed)} file(s) of destroyed battles`,
      runbook: 'capture-backlog',
    });
  }
  return out;
}
