import { describe, expect, it } from 'vitest';
import { assessHealth, formatAge, formatBytes } from './health';
import type { OpsHealth, OpsUsage } from './types';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const BATTLE = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';

function job(kind: 'capture' | 'destroy' | 'takedown'): OpsHealth['jobs'][number] {
  return {
    kind,
    queued: 0,
    running: 0,
    ready: 0,
    lease_expired: 0,
    oldest_pending_s: null,
    oldest_pending_ref: null,
    done_last_hour: 3,
    failed_last_hour: 0,
    failed_last_day: 0,
    last_failure: null,
  };
}

function healthy(): OpsHealth {
  return {
    generated_at: new Date(NOW).toISOString(),
    battles: {
      grace_s: 30,
      running: { building: 2 },
      overdue_total: 0,
      stuck_total: 0,
      overdue: [],
      destroy_pending: { count: 0, oldest_s: null, oldest_battle_id: null },
    },
    jobs: [job('capture'), job('destroy'), job('takedown')],
    captures_last_day: { captured: 10, fallback: 1, failed: 0 },
    cron: {
      available: true,
      jobs: [
        {
          name: 'br-sweep-deadlines',
          schedule: '5 seconds',
          active: true,
          last_run: { start: ago(4), status: 'succeeded', duration_ms: 6 },
          runs_last_hour: 720,
          failed_last_hour: 0,
          last_failure: null,
        },
        {
          name: 'br-sweep-ttl',
          schedule: '*/10 * * * *',
          active: true,
          last_run: { start: ago(300), status: 'succeeded', duration_ms: 9 },
          runs_last_hour: 6,
          failed_last_hour: 0,
          last_failure: null,
        },
      ],
    },
    ttl: {
      battles_past_ttl: 0,
      oldest_battle_past_ttl_id: null,
      ephemeral_objects: 12,
      ephemeral_objects_past_ttl: 0,
      oldest_ephemeral_object_s: 600,
      ephemeral_objects_of_destroyed: 0,
    },
  };
}

/** The plan usage of a young Free project (T-036): far from every limit, pinged today. */
function usage(): OpsUsage {
  return {
    warn_pct: 80,
    storage: {
      limit_bytes: 1e9,
      used_bytes: 120e6,
      used_pct: 12,
      warning: false,
      buckets: [
        { bucket: 'screenshots', objects: 1800, bytes: 110e6 },
        { bucket: 'ephemeral-builds', objects: 40, bytes: 10e6 },
      ],
    },
    database: {
      limit_bytes: 5e8,
      used_bytes: 80e6,
      this_database_bytes: 45e6,
      unreadable_databases: 0,
      used_pct: 16,
      warning: false,
      largest: [{ relation: 'public.battle_events', bytes: 4e6 }],
    },
    auth: { limit: 50_000, signed_in_this_month: 900, used_pct: 1.8, warning: false },
    keep_alive: {
      last_ping_at: ago(3600),
      age_s: 3600,
      pings: 30,
      max_age_s: 129_600,
      stale: false,
    },
    retention: {
      event_log_days: 30,
      job_days: 7,
      oldest_battle_event_at: ago(29 * 86400),
      oldest_room_event_at: null,
    },
  };
}

describe('assessHealth', () => {
  it('all clear for a healthy system', () => {
    expect(assessHealth(healthy(), NOW)).toEqual([]);
    expect(assessHealth({ ...healthy(), usage: usage() }, NOW)).toEqual([]);
  });

  it('flags plan usage at the warning threshold and a keep-alive that stopped (T-036)', () => {
    const u = usage();
    u.storage = { ...u.storage, used_bytes: 812e6, used_pct: 81.2, warning: true };
    u.storage.buckets = [{ bucket: 'screenshots', objects: 13_000, bytes: 800e6 }];
    u.database = { ...u.database, used_bytes: 410e6, used_pct: 82, warning: true };
    u.auth = { ...u.auth, signed_in_this_month: 41_000, used_pct: 82, warning: true };
    u.keep_alive = { ...u.keep_alive, last_ping_at: ago(3 * 86400), age_s: 3 * 86400, stale: true };
    const findings = assessHealth({ ...healthy(), usage: u }, NOW);
    expect(findings.map((f) => [f.area, f.runbook])).toEqual([
      ['usage', 'free-plan-quotas'],
      ['usage', 'free-plan-quotas'],
      ['usage', 'free-plan-quotas'],
      ['usage', 'free-plan-quotas'],
    ]);
    expect(findings.map((f) => f.text)).toEqual([
      'Storage: 812.0 MB of 1.00 GB (81.2 %), screenshots 800.0 MB',
      'Database: 410.0 MB of 500.0 MB (82 %); Supabase Free turns read-only above its limit',
      'Monthly active users: at least 41000 of 50000 (82 %)',
      'No keep-alive ping for 3 d: the Free project pauses after 7 days without activity',
    ]);
  });

  it('says how to set up a keep-alive that never pinged', () => {
    const u = usage();
    u.keep_alive = { last_ping_at: null, age_s: null, pings: 0, max_age_s: 129_600, stale: true };
    const [finding] = assessHealth({ ...healthy(), usage: u }, NOW);
    expect(finding?.text).toMatch(/never pinged: set up the GitHub workflow \(DEPLOY\.md §8\)/);
  });

  it('flags stuck battles (not RESULTS waiting for its screenshots)', () => {
    const h = healthy();
    h.battles.overdue = [
      {
        phase: 'results',
        count: 3,
        stuck: 0,
        waiting_for_captures: 3,
        oldest_overdue_s: 120,
        oldest_battle_id: BATTLE,
      },
    ];
    h.battles.overdue_total = 3;
    expect(assessHealth(h, NOW)).toEqual([]);
    h.battles.overdue.push({
      phase: 'building',
      count: 1,
      stuck: 1,
      waiting_for_captures: 0,
      oldest_overdue_s: 3600,
      oldest_battle_id: BATTLE,
    });
    h.battles.stuck_total = 1;
    expect(assessHealth(h, NOW)).toEqual([
      {
        area: 'battles',
        text: '1 battle past the deadline and not moving (oldest: building, 60 min overdue)',
        runbook: 'stuck-battle',
      },
    ]);
  });

  it('flags a capture backlog, failed jobs and dead workers', () => {
    const h = healthy();
    const capture = h.jobs[0];
    if (!capture) throw new Error('fixture');
    capture.queued = 40;
    capture.oldest_pending_s = 900;
    capture.failed_last_hour = 2;
    capture.lease_expired = 1;
    expect(assessHealth(h, NOW).map((f) => [f.area, f.runbook])).toEqual([
      ['jobs', 'capture-backlog'],
      ['jobs', 'capture-backlog'],
      ['jobs', 'capture-backlog'],
    ]);
  });

  it('flags sweeps that stopped or fail, and TTL leftovers', () => {
    const h = healthy();
    const deadlines = h.cron.jobs[0];
    if (!deadlines) throw new Error('fixture');
    deadlines.last_run = { start: ago(600), status: 'succeeded', duration_ms: 5 };
    const ttl = h.cron.jobs[1];
    if (!ttl) throw new Error('fixture');
    ttl.failed_last_hour = 1;
    h.ttl.ephemeral_objects_past_ttl = 4;
    const findings = assessHealth(h, NOW);
    expect(findings.map((f) => f.text)).toEqual([
      'br-sweep-deadlines has not run for 10 min',
      'br-sweep-ttl: 1 failed run(s) in the last hour',
      'TTL leftovers: 0 battle(s) older than 24 h not destroyed, 4 file(s) older than 24 h, 0 file(s) of destroyed battles',
    ]);
    h.cron = { available: false, jobs: [] };
    expect(assessHealth(h, NOW).some((f) => f.area === 'cron')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('uses decimal units, as Supabase states its limits', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(61_234)).toBe('61.2 kB');
    expect(formatBytes(500e6)).toBe('500.0 MB');
    expect(formatBytes(1e9)).toBe('1.00 GB');
  });
});

describe('formatAge', () => {
  it('picks a readable unit', () => {
    expect(formatAge(null)).toBe('–');
    expect(formatAge(45)).toBe('45 s');
    expect(formatAge(600)).toBe('10 min');
    expect(formatAge(7200)).toBe('2 h');
    expect(formatAge(5 * 86400)).toBe('5 d');
  });
});
