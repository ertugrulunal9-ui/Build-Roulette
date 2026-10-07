/**
 * Direct database access of the load test (never used by simulated clients):
 *
 * - `compressBattle`: right after `start_battle`, shortens the battle's phases. It merges
 *   the compressed durations into `battles.settings` (read by every later transition:
 *   `private.setting_interval`, `private.battle_reveal_slot`), moves the SPINNING deadline,
 *   and sets the challenge's time limit (BUILDING starts from it at SPINNING → BUILDING).
 *   This is the "time travel" the pgTAP tests and e2e scripts do, applied once per battle
 *   before anything depends on it, so clients see consistent deadlines in every event.
 * - samplers (pg_stat_activity, locks, pg_stat_database, the job queue) and the post-run
 *   queries (event timestamps, rows per battle, pg_stat_statements).
 */
import pg from 'pg';

export type Db = pg.Pool;

export function openDb(url: string, max = 2): Db {
  return new pg.Pool({ connectionString: url, max, application_name: 'br-loadtest' });
}

export async function compressBattle(
  db: Db,
  battleId: string,
  settings: Record<string, number>,
  buildS: number,
): Promise<{ drawnBuildS: number | null; ok: boolean }> {
  const res = await db.query<{ drawn: number | null }>(
    `with b as (
       update public.battles
          set settings = settings || $2::jsonb,
              phase_ends_at = phase_started_at + make_interval(secs => ($2::jsonb ->> 'spinning_s')::int)
        where id = $1 and phase = 'spinning'
        returning challenge_id),
     old as (
       select c.id, c.time_limit_seconds as drawn
         from public.challenges c join b on b.challenge_id = c.id),
     upd as (
       update public.challenges c set time_limit_seconds = $3
         from old where c.id = old.id
       returning c.id)
     select (select drawn from old) as drawn, (select count(*) from upd)::int as n`,
    [battleId, JSON.stringify(settings), buildS],
  );
  const row = res.rows[0] as { drawn: number | null; n?: number } | undefined;
  return { drawnBuildS: row?.drawn ?? null, ok: (row as { n: number } | undefined)?.n === 1 };
}

/** Event creation times (`created_at` = the transaction's `now()`), epoch ms. */
export async function eventTimes(
  db: Db,
  battleIds: string[],
  roomIds: string[],
): Promise<{ key: string; version: number; type: string; detail: string | null; ms: number }[]> {
  const res = await db.query<{
    key: string;
    version: number;
    type: string;
    detail: string | null;
    ms: number;
  }>(
    `select 'b:' || battle_id as key, version, type,
            case when type = 'phase' then coalesce(payload ->> 'from', '') || '>' || coalesce(payload ->> 'to', '') end as detail,
            extract(epoch from created_at) * 1000 as ms
       from public.battle_events where battle_id = any($1::uuid[])
     union all
     select 'r:' || room_id, version, type, payload ->> 'change' as detail,
            extract(epoch from created_at) * 1000
       from public.room_events where room_id = any($2::uuid[])`,
    [battleIds, roomIds],
  );
  return res.rows.map((r) => ({ ...r, ms: Number(r.ms as unknown) }));
}

export interface DbSample {
  t: number;
  /** pg_stat_activity of the app database, by "state/wait_event_type". */
  activity: Record<string, number>;
  waitingLocks: number;
  xactCommit: number;
  xactRollback: number;
  deadlocks: number;
  /** Job queue by "kind:status". */
  jobs: Record<string, number>;
  /** Battles created during the run, by phase. */
  phases: Record<string, number>;
}

export async function sampleDb(db: Db, since: Date): Promise<DbSample> {
  const [act, locks, stat, jobs, phases] = await Promise.all([
    db.query<{ k: string; n: number }>(
      `select coalesce(state, 'none') || '/' || coalesce(wait_event_type, '-') as k, count(*)::int as n
         from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
        group by 1`,
    ),
    db.query<{ n: number }>(`select count(*)::int as n from pg_locks where not granted`),
    db.query<{ c: string; r: string; d: string }>(
      `select xact_commit::text as c, xact_rollback::text as r, deadlocks::text as d
         from pg_stat_database where datname = current_database()`,
    ),
    db.query<{ k: string; n: number }>(
      `select kind || ':' || status as k, count(*)::int as n from public.jobs group by 1`,
    ),
    db.query<{ k: string; n: number }>(
      `select phase::text as k, count(*)::int as n from public.battles where created_at >= $1 group by 1`,
      [since],
    ),
  ]);
  const map = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  const s = stat.rows[0];
  return {
    t: Date.now(),
    activity: map(act.rows),
    waitingLocks: locks.rows[0]?.n ?? 0,
    xactCommit: Number(s?.c ?? 0),
    xactRollback: Number(s?.r ?? 0),
    deadlocks: Number(s?.d ?? 0),
    jobs: map(jobs.rows),
    phases: map(phases.rows),
  };
}

export async function resetStatements(db: Db): Promise<boolean> {
  try {
    await db.query('select pg_stat_statements_reset()');
    return true;
  } catch {
    return false;
  }
}

export interface StatementRow {
  query: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  rows: number;
}

export async function topStatements(db: Db, limit = 15): Promise<StatementRow[]> {
  try {
    const res = await db.query<StatementRow>(
      `select left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query, calls::int,
              round(total_exec_time::numeric, 1)::float8 as total_ms,
              round(mean_exec_time::numeric, 2)::float8 as mean_ms, rows::int
         from pg_stat_statements
        where query not ilike '%pg_stat_statements%'
        order by total_exec_time desc limit $1`,
      [limit],
    );
    return res.rows;
  } catch {
    return [];
  }
}

/** Rows written per battle (the run's battles only), by table. */
export async function rowsPerBattle(
  db: Db,
  battleIds: string[],
  roomIds: string[],
): Promise<Record<string, number>> {
  const q = async (sql: string, params: unknown[]) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
  const b = [battleIds];
  const counts: Record<string, number> = {
    battles: battleIds.length,
    challenges: battleIds.length,
    battle_players: await q(
      `select count(*) as n from public.battle_players where battle_id = any($1::uuid[])`,
      b,
    ),
    builds: await q(`select count(*) as n from public.builds where battle_id = any($1::uuid[])`, b),
    battle_events: await q(
      `select count(*) as n from public.battle_events where battle_id = any($1::uuid[])`,
      b,
    ),
    votes: await q(`select count(*) as n from public.votes where battle_id = any($1::uuid[])`, b),
    awards: await q(
      `select count(*) as n from public.awards a join public.builds bu on bu.id = a.build_id where bu.battle_id = any($1::uuid[])`,
      b,
    ),
    jobs: await q(
      `select count(*) as n from public.jobs j where (j.kind = 'capture' and j.ref_id in (select id from public.builds where battle_id = any($1::uuid[])))
          or (j.kind = 'destroy' and j.ref_id = any($1::uuid[]))`,
      b,
    ),
    room_events: await q(
      `select count(*) as n from public.room_events where room_id = any($1::uuid[])`,
      [roomIds],
    ),
    'storage.objects (screenshots)': await q(
      `select count(*) as n from storage.objects where bucket_id = 'screenshots' and split_part(name, '/', 1) = any($1::text[])`,
      [battleIds],
    ),
    'storage.objects (ephemeral, left)': await q(
      `select count(*) as n from storage.objects where bucket_id = 'ephemeral-builds' and split_part(name, '/', 1) = any($1::text[])`,
      [battleIds],
    ),
  };
  return counts;
}

/** Screenshot bytes kept per battle (the permanent storage driver). */
export async function screenshotBytes(db: Db, battleIds: string[]): Promise<number> {
  const res = await db.query<{ n: string | null }>(
    `select sum((metadata ->> 'size')::bigint)::text as n from storage.objects
      where bucket_id = 'screenshots' and split_part(name, '/', 1) = any($1::text[])`,
    [battleIds],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function databaseSize(db: Db): Promise<number> {
  const res = await db.query<{ n: string }>(
    `select pg_database_size(current_database())::text as n`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Captures of the run's builds: status counts and created → captured latency. */
export async function captureOutcomes(
  db: Db,
  battleIds: string[],
): Promise<{ status: Record<string, number>; latencyMs: number[] }> {
  const res = await db.query<{ capture_status: string; ms: string | null }>(
    `select bu.capture_status::text as capture_status,
            extract(epoch from (bu.captured_at - b.shipping_ended_at)) * 1000 as ms
       from public.builds bu join public.battles b on b.id = bu.battle_id
      where bu.battle_id = any($1::uuid[]) and bu.status in ('shipped', 'auto_shipped')`,
    [battleIds],
  );
  const status: Record<string, number> = {};
  const latencyMs: number[] = [];
  for (const r of res.rows) {
    status[r.capture_status] = (status[r.capture_status] ?? 0) + 1;
    if (r.ms !== null) latencyMs.push(Number(r.ms));
  }
  return { status, latencyMs };
}
