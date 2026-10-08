-- Build Roulette (T-030, M5): the operations health signals for the admins (the "Health"
-- section of /admin and the runbooks in docs/runbooks/).
--
-- Admin RPC (authenticated AND public.is_admin(); everyone else gets not_admin, anon has
-- no EXECUTE):
--   admin_ops_health(grace_s default 30)  → jsonb, read-only:
--     battles  overdue battles by phase (past phase_ends_at by more than grace_s): count,
--              stuck (not just RESULTS waiting for its screenshots), oldest age and id;
--              battles DESTROYED whose files are not deleted yet; running battles by phase
--     jobs     per kind (capture, destroy, takedown): queued, running, ready to claim,
--              running with an expired lease, oldest pending age, done and failed in the
--              last hour, failed in the last 24 h, the latest failure
--     captures outcome of the capture jobs that finished in the last 24 h
--     cron     pg_cron jobs with their last run, runs and failures in the last hour, the
--              latest failure (from cron.job_run_details; `available: false` without it)
--     ttl      what the 24 h TTL sweep should have handled: battles older than 24 h whose
--              files are not deleted, ephemeral-builds objects older than 24 h, and objects
--              of battles already destroyed
--
-- Nothing here is per player: no names, no user ids. Every query is bounded by an index or
-- by a small set (the ephemeral bucket only holds running battles), so the admin page can
-- call it on every load. The grace defaults to 30 s: sweep_deadlines runs every 5 s, so a
-- battle overdue by more than a few sweeps is not moving on its own.

-- ─── Indexes for the windows ──────────────────────────────────────────────
-- "done / failed in the last hour" per kind (the jobs table keeps every finished job).
create index jobs_kind_updated_idx on public.jobs (kind, updated_at desc);
-- Battles whose files are not deleted yet: the TTL sweep's own scan (every 10 min) and the
-- health check. Small: running battles plus destroys in flight.
create index battles_not_destroyed_idx on public.battles (created_at) where destroyed_at is null;

create function public.admin_ops_health(p_grace_s int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_grace    interval := make_interval(secs => least(greatest(coalesce(p_grace_s, 30), 0), 3600));
  v_battles  jsonb;
  v_jobs     jsonb;
  v_captures jsonb;
  v_cron     jsonb;
  v_ttl      jsonb;
begin
  perform private.require_admin();

  -- ── Battles ──
  with active as (
    select b.id, b.phase, b.phase_ends_at, b.phase_started_at,
           -- RESULTS legitimately outlives its last look while a final build's screenshot is
           -- pending, until the capture deadline (docs/04 §4.3).
           coalesce(b.phase = 'results'
                    and exists (select 1 from public.builds bu
                                where bu.battle_id = b.id
                                  and bu.status in ('shipped', 'auto_shipped')
                                  and bu.capture_status = 'pending')
                    and now() <= b.shipping_ended_at
                                 + private.setting_interval(b.settings, 'capture_deadline_s'),
                    false) as waiting
    from public.battles b
    where b.phase not in ('destroyed', 'abandoned')
  ),
  overdue as (
    select a.phase,
           count(*)::int                                   as n,
           count(*) filter (where not a.waiting)::int      as stuck,
           count(*) filter (where a.waiting)::int          as waiting,
           min(a.phase_ends_at)                            as oldest_end,
           (array_agg(a.id order by a.phase_ends_at))[1]   as oldest_id
    from active a
    where a.phase_ends_at < now() - v_grace
    group by a.phase
  )
  select jsonb_build_object(
    'grace_s', extract(epoch from v_grace)::int,
    'running', coalesce((select jsonb_object_agg(x.phase, x.n)
                         from (select a.phase, count(*)::int as n from active a group by a.phase) x),
                        '{}'::jsonb),
    'overdue_total', coalesce((select sum(o.n) from overdue o), 0)::int,
    'stuck_total', coalesce((select sum(o.stuck) from overdue o), 0)::int,
    'overdue', coalesce((select jsonb_agg(jsonb_build_object(
                           'phase', o.phase,
                           'count', o.n,
                           'stuck', o.stuck,
                           'waiting_for_captures', o.waiting,
                           'oldest_overdue_s', floor(extract(epoch from now() - o.oldest_end))::int,
                           'oldest_battle_id', o.oldest_id) order by o.oldest_end)
                         from overdue o), '[]'::jsonb),
    'destroy_pending', (
      select jsonb_build_object(
               'count', count(*)::int,
               'oldest_s', floor(extract(epoch from now() - min(b.phase_started_at)))::int,
               'oldest_battle_id', (array_agg(b.id order by b.phase_started_at))[1])
      from public.battles b
      where b.destroyed_at is null
        and b.phase in ('destroyed', 'abandoned')
        and b.phase_started_at < now() - v_grace))
  into v_battles;

  -- ── Jobs ──
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', k.kind,
           'queued', (select count(*) from public.jobs j
                      where j.kind = k.kind and j.status = 'queued')::int,
           'running', (select count(*) from public.jobs j
                       where j.kind = k.kind and j.status = 'running')::int,
           'ready', (select count(*) from public.jobs j
                     where j.kind = k.kind and j.status in ('queued', 'running')
                       and j.run_after <= now() and j.attempts < 5)::int,
           'lease_expired', (select count(*) from public.jobs j
                             where j.kind = k.kind and j.status = 'running'
                               and j.run_after <= now())::int,
           'oldest_pending_s', (select floor(extract(epoch from now() - min(j.created_at)))::int
                                from public.jobs j
                                where j.kind = k.kind and j.status in ('queued', 'running')),
           'oldest_pending_ref', (select j.ref_id from public.jobs j
                                  where j.kind = k.kind and j.status in ('queued', 'running')
                                  order by j.created_at limit 1),
           'done_last_hour', (select count(*) from public.jobs j
                              where j.kind = k.kind and j.status = 'done'
                                and j.updated_at > now() - interval '1 hour')::int,
           'failed_last_hour', (select count(*) from public.jobs j
                                where j.kind = k.kind and j.status = 'failed'
                                  and j.updated_at > now() - interval '1 hour')::int,
           'failed_last_day', (select count(*) from public.jobs j
                               where j.kind = k.kind and j.status = 'failed'
                                 and j.updated_at > now() - interval '24 hours')::int,
           'last_failure', (select jsonb_build_object('at', j.updated_at, 'ref_id', j.ref_id,
                                                      'error', left(j.last_error, 300))
                            from public.jobs j
                            where j.kind = k.kind and j.status = 'failed'
                            order by j.updated_at desc limit 1))
           order by k.kind), '[]'::jsonb)
  into v_jobs
  from unnest(enum_range(null::public.job_kind)) as k(kind);

  -- ── Captures of the last 24 h (the capture jobs that finished, and what they stored) ──
  select jsonb_build_object(
           'captured', count(*) filter (where bu.capture_status = 'captured')::int,
           'fallback', count(*) filter (where bu.capture_status = 'fallback')::int,
           'failed', count(*) filter (where bu.capture_status = 'failed')::int)
  into v_captures
  from public.jobs j
  join public.builds bu on bu.id = j.ref_id
  where j.kind = 'capture'
    and j.status in ('done', 'failed')
    and j.updated_at > now() - interval '24 hours';

  -- ── pg_cron ──
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    v_cron := jsonb_build_object('available', false, 'jobs', '[]'::jsonb);
  else
    begin
      select jsonb_build_object('available', true, 'jobs', coalesce(jsonb_agg(x.j order by x.name), '[]'::jsonb))
      into v_cron
      from (
        select cj.jobname as name, jsonb_build_object(
                 'name', cj.jobname,
                 'schedule', cj.schedule,
                 'active', cj.active,
                 'last_run', (select jsonb_build_object(
                                       'start', d.start_time,
                                       'status', d.status,
                                       'duration_ms', floor(extract(epoch from d.end_time - d.start_time) * 1000)::int)
                              from cron.job_run_details d
                              where d.jobid = cj.jobid
                              order by d.runid desc limit 1),
                 'runs_last_hour', (select count(*) from cron.job_run_details d
                                    where d.jobid = cj.jobid
                                      and d.start_time > now() - interval '1 hour')::int,
                 'failed_last_hour', (select count(*) from cron.job_run_details d
                                      where d.jobid = cj.jobid and d.status = 'failed'
                                        and d.start_time > now() - interval '1 hour')::int,
                 'last_failure', (select jsonb_build_object('at', d.start_time,
                                                            'message', left(d.return_message, 300))
                                  from cron.job_run_details d
                                  where d.jobid = cj.jobid and d.status = 'failed'
                                  order by d.runid desc limit 1)) as j
        from cron.job cj
      ) x;
    exception when others then
      -- E.g. the function owner cannot read the cron schema on some deployment.
      v_cron := jsonb_build_object('available', false, 'jobs', '[]'::jsonb, 'error', sqlerrm);
    end;
  end if;

  -- ── TTL leftovers ──
  select jsonb_build_object(
    'battles_past_ttl', (select count(*) from public.battles b
                         where b.destroyed_at is null
                           and b.created_at < now() - interval '24 hours')::int,
    'oldest_battle_past_ttl_id', (select b.id from public.battles b
                                  where b.destroyed_at is null
                                    and b.created_at < now() - interval '24 hours'
                                  order by b.created_at limit 1),
    'ephemeral_objects', (select count(*) from storage.objects o
                          where o.bucket_id = 'ephemeral-builds')::int,
    'ephemeral_objects_past_ttl', (select count(*) from storage.objects o
                                   where o.bucket_id = 'ephemeral-builds'
                                     and o.created_at < now() - interval '24 hours')::int,
    'oldest_ephemeral_object_s', (select floor(extract(epoch from now() - min(o.created_at)))::int
                                  from storage.objects o
                                  where o.bucket_id = 'ephemeral-builds'),
    -- Files of a battle whose destroy already finished (they should not exist).
    'ephemeral_objects_of_destroyed', (
      select count(*) from storage.objects o
      join public.battles b on b.id::text = split_part(o.name, '/', 1)
      where o.bucket_id = 'ephemeral-builds'
        and b.destroyed_at is not null)::int)
  into v_ttl;

  return jsonb_build_object(
    'generated_at', now(),
    'battles', v_battles,
    'jobs', v_jobs,
    'captures_last_day', v_captures,
    'cron', v_cron,
    'ttl', v_ttl);
end;
$$;

revoke all on function public.admin_ops_health(int) from public, anon;
grant execute on function public.admin_ops_health(int) to authenticated;
