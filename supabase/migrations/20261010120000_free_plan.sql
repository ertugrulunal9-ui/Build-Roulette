-- Build Roulette (T-036): running on Supabase Free (docs/08-free-tier.md §6).
--
-- ─── 1. Keep-alive against the 7-day pause ────────────────────────────────
-- Supabase pauses a Free project that gets no "user database activity" for a week. Our
-- own pg_cron jobs are not user activity (and do nothing to wake a paused project), so a
-- scheduled GitHub Actions workflow (.github/workflows/keep-alive.yml) calls
--   POST /rest/v1/rpc/keep_alive   (the public anon/publishable key)
-- once a day: a request through the Data API that reads and writes the database.
-- `public.keep_alive()` records the ping (at most one write a minute, one row), answers
-- {ok, at}, and answers {ok: false, read_only: true} when the database is read-only (the
-- Free plan's answer to a database over 500 MB): the workflow fails loudly on it, as on a
-- paused project (HTTP 540). Anon may call it; it reveals nothing and writes one row.
--
-- ─── 2. Usage against the plan (the "Plan usage" part of /admin → Health) ──
-- `private.ops_settings` (one row, edit with SQL; docs/runbooks/free-plan-quotas.md) holds
-- the plan's limits and the warning threshold:
--   storage_limit_bytes   1 GB file storage on Free  (1e9: the smaller reading of "GB")
--   database_limit_bytes  500 MB database size on Free, read-only beyond it (5e8)
--   usage_warn_pct        80
--   mau_limit             50,000 monthly active users on Free
-- `admin_ops_health()` gains `usage` (private.ops_usage()):
--   storage   bytes and objects per bucket (sum of storage.objects metadata.size, the size
--             Supabase bills) against storage_limit_bytes
--   database  sum(pg_database_size) over every database of the cluster (the figure of
--             Supabase's database-size docs) against database_limit_bytes, plus the ten
--             largest relations (partitions folded into their table)
--   auth      users who signed in this calendar month (a lower bound of MAU: a token refresh
--             also counts as activity for Supabase) against mau_limit
--   keep_alive the last ping and whether it is older than keep_alive_max_age_s (36 h)
--   retention the event-log settings below and the oldest event kept
-- Results are permanent: nothing here deletes a screenshot.
--
-- ─── 3. Retention of the event logs ───────────────────────────────────────
-- `private.prune_event_logs()`, daily (pg_cron 'br-event-logs-prune'), deletes in batches:
--   * battle_events older than event_log_retention_days (30) of battles that are over
--     (DESTROYED or ABANDONED). The admin's battle log of such a battle is then empty; the
--     battle, its roster, builds, votes, awards, ranks and screenshot stay;
--   * room_events older than event_log_retention_days (rooms themselves are purged 7 days
--     after they close, T-016);
--   * finished capture and destroy jobs (done or failed) older than job_retention_days (7).
--     Takedown jobs are kept: a failed one is what /admin retries, and they are rare.
-- Nothing else reads these rows (the broadcast triggers fire on insert; the sync engine uses
-- versions and snapshots, never the logs).
--
-- The admin_ops_health of T-030 (20261008150000_ops_health.sql) becomes
-- private.ops_health_signals unchanged; the public function calls it and adds `usage`.

-- ─── Settings ─────────────────────────────────────────────────────────────
create table private.ops_settings (
  id                        boolean primary key default true check (id),
  storage_limit_bytes       bigint not null default 1000000000 check (storage_limit_bytes > 0),
  database_limit_bytes      bigint not null default 500000000 check (database_limit_bytes > 0),
  usage_warn_pct            int not null default 80 check (usage_warn_pct between 1 and 100),
  mau_limit                 int not null default 50000 check (mau_limit > 0),
  keep_alive_max_age_s      int not null default 129600 check (keep_alive_max_age_s >= 3600),
  event_log_retention_days  int not null default 30 check (event_log_retention_days >= 1),
  job_retention_days        int not null default 7 check (job_retention_days >= 2),
  updated_at                timestamptz not null default now()
);
insert into private.ops_settings default values;
revoke all on private.ops_settings from public, anon, authenticated, service_role;

-- ─── Keep-alive ───────────────────────────────────────────────────────────
create table private.keep_alive (
  id            boolean primary key default true check (id),
  last_ping_at  timestamptz,
  pings         bigint not null default 0
);
insert into private.keep_alive default values;
revoke all on private.keep_alive from public, anon, authenticated, service_role;

create function public.keep_alive()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  begin
    -- At most one write a minute, whoever calls.
    update private.keep_alive
       set last_ping_at = now(), pings = pings + 1
     where id and (last_ping_at is null or last_ping_at < now() - interval '1 minute');
  exception when read_only_sql_transaction then
    return jsonb_build_object('ok', false, 'read_only', true, 'at', now());
  end;
  return jsonb_build_object('ok', true, 'read_only', false, 'at', now());
end;
$$;

revoke all on function public.keep_alive() from public, authenticated, service_role;
grant execute on function public.keep_alive() to anon;

-- ─── Usage ────────────────────────────────────────────────────────────────
create function private.ops_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s              private.ops_settings;
  v_buckets      jsonb;
  v_storage      bigint;
  v_db           bigint := 0;
  v_unreadable   int := 0;
  v_largest      jsonb;
  v_mau          int;
  v_keep         jsonb;
  v_retention    jsonb;
  d              record;
  pct            numeric;
begin
  select * into s from private.ops_settings where id;

  -- Storage: what Supabase bills is the objects' size (storage.objects.metadata.size).
  select coalesce(jsonb_agg(jsonb_build_object('bucket', x.bucket, 'objects', x.n, 'bytes', x.bytes)
                            order by x.bytes desc, x.bucket), '[]'::jsonb),
         coalesce(sum(x.bytes), 0)::bigint
    into v_buckets, v_storage
  from (select bk.id as bucket,
               count(o.id)::int as n,
               coalesce(sum(case when o.metadata ->> 'size' ~ '^[0-9]{1,18}$'
                                 then (o.metadata ->> 'size')::bigint else 0 end), 0)::bigint as bytes
        from storage.buckets bk
        left join storage.objects o on o.bucket_id = bk.id
        group by bk.id) x;

  -- Database size as Supabase's docs compute it: every database of the cluster.
  for d in select datname from pg_catalog.pg_database loop
    begin
      v_db := v_db + pg_catalog.pg_database_size(d.datname);
    exception when others then
      v_unreadable := v_unreadable + 1;
    end;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('relation', x.rel, 'bytes', x.bytes)
                            order by x.bytes desc), '[]'::jsonb)
    into v_largest
  from (select n.nspname || '.' || r.relname as rel,
               sum(pg_catalog.pg_total_relation_size(c.oid))::bigint as bytes
        from pg_catalog.pg_class c
        join pg_catalog.pg_class r on r.oid = coalesce(pg_catalog.pg_partition_root(c.oid), c.oid)
        join pg_catalog.pg_namespace n on n.oid = r.relnamespace
        where c.relkind in ('r', 'm')
          and n.nspname not in ('pg_catalog', 'information_schema')
        group by 1
        order by 2 desc
        limit 10) x;

  select count(*)::int into v_mau
  from auth.users u
  where coalesce(u.last_sign_in_at, u.created_at) >= date_trunc('month', now());

  select jsonb_build_object(
           'last_ping_at', k.last_ping_at,
           'age_s', floor(extract(epoch from now() - k.last_ping_at))::int,
           'pings', k.pings,
           'max_age_s', s.keep_alive_max_age_s,
           'stale', k.last_ping_at is null
                    or k.last_ping_at < now() - make_interval(secs => s.keep_alive_max_age_s))
    into v_keep
  from private.keep_alive k where k.id;

  v_retention := jsonb_build_object(
    'event_log_days', s.event_log_retention_days,
    'job_days', s.job_retention_days,
    'oldest_battle_event_at', (select e.created_at from public.battle_events e order by e.id limit 1),
    'oldest_room_event_at', (select e.created_at from public.room_events e order by e.id limit 1));

  return jsonb_build_object(
    'warn_pct', s.usage_warn_pct,
    'storage', jsonb_build_object(
      'limit_bytes', s.storage_limit_bytes,
      'used_bytes', v_storage,
      'used_pct', round(100.0 * v_storage / s.storage_limit_bytes, 1),
      'warning', 100.0 * v_storage / s.storage_limit_bytes >= s.usage_warn_pct,
      'buckets', v_buckets),
    'database', jsonb_build_object(
      'limit_bytes', s.database_limit_bytes,
      'used_bytes', v_db,
      'this_database_bytes', pg_catalog.pg_database_size(current_database()),
      'unreadable_databases', v_unreadable,
      'used_pct', round(100.0 * v_db / s.database_limit_bytes, 1),
      'warning', 100.0 * v_db / s.database_limit_bytes >= s.usage_warn_pct,
      'largest', v_largest),
    'auth', jsonb_build_object(
      'limit', s.mau_limit,
      'signed_in_this_month', v_mau,
      'used_pct', round(100.0 * v_mau / s.mau_limit, 1),
      'warning', 100.0 * v_mau / s.mau_limit >= s.usage_warn_pct),
    'keep_alive', v_keep,
    'retention', v_retention);
end;
$$;

revoke all on function private.ops_usage() from public, anon, authenticated, service_role;

-- ─── admin_ops_health: T-030's signals plus `usage` ───────────────────────
alter function public.admin_ops_health(int) set schema private;
alter function private.admin_ops_health(int) rename to ops_health_signals;
revoke all on function private.ops_health_signals(int) from public, anon, authenticated, service_role;

create function public.admin_ops_health(p_grace_s int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return private.ops_health_signals(p_grace_s) || jsonb_build_object('usage', private.ops_usage());
end;
$$;

revoke all on function public.admin_ops_health(int) from public, anon, service_role;
grant execute on function public.admin_ops_health(int) to authenticated;

-- ─── Retention of the event logs ──────────────────────────────────────────
-- Returns what it deleted: {battle_events, room_events, jobs}. Batches of 5,000 rows, at most
-- 200 batches per table and run (a backlog is worked off over a few days, never in one long
-- transaction).
create function private.prune_event_logs()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s          private.ops_settings;
  v_events   timestamptz;
  v_jobs     timestamptz;
  v_batch    constant int := 5000;
  n          int;
  i          int;
  v_be       int := 0;
  v_re       int := 0;
  v_j        int := 0;
begin
  select * into s from private.ops_settings where id;
  v_events := now() - make_interval(days => s.event_log_retention_days);
  v_jobs := now() - make_interval(days => s.job_retention_days);

  for i in 1..200 loop
    delete from public.battle_events e
     where e.id in (select e2.id
                    from public.battle_events e2
                    join public.battles b on b.id = e2.battle_id
                    where e2.created_at < v_events
                      and b.phase in ('destroyed', 'abandoned')
                    limit v_batch);
    get diagnostics n = row_count;
    v_be := v_be + n;
    exit when n < v_batch;
  end loop;

  for i in 1..200 loop
    delete from public.room_events e
     where e.id in (select e2.id from public.room_events e2
                    where e2.created_at < v_events
                    limit v_batch);
    get diagnostics n = row_count;
    v_re := v_re + n;
    exit when n < v_batch;
  end loop;

  for i in 1..200 loop
    delete from public.jobs j
     where j.id in (select j2.id from public.jobs j2
                    where j2.kind in ('capture', 'destroy')
                      and j2.status in ('done', 'failed')
                      and j2.updated_at < v_jobs
                    limit v_batch);
    get diagnostics n = row_count;
    v_j := v_j + n;
    exit when n < v_batch;
  end loop;

  return jsonb_build_object('battle_events', v_be, 'room_events', v_re, 'jobs', v_j);
end;
$$;

revoke all on function private.prune_event_logs() from public, anon, authenticated, service_role;

-- pg_cron, like 20261004120500_sweeps_and_cron.sql (skipped where pg_cron is missing).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed: event logs are not pruned on a schedule';
    return;
  end if;
  perform cron.schedule('br-event-logs-prune', '41 4 * * *', 'select private.prune_event_logs()');
end;
$$;
