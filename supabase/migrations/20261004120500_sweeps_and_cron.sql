-- Build Roulette: deadline and TTL sweeps, scheduled with pg_cron.
--
--   sweep_deadlines()  every 5 s   advances overdue battles (the backstop for
--                                  client nudges, docs/04 §4.5) and gives up
--                                  on jobs whose last lease expired
--   sweep_ttl()        every 10 min  the 24 h hard TTL (docs/05 §5.6)
--
-- Both are service_role-callable too (manual runs, tests); pg_cron runs them
-- as the migration role.

-- Advances every non-terminal battle whose phase_ends_at has passed, one
-- subtransaction per battle, so one failing battle (e.g. a multiplayer
-- battle hitting `not_implemented`) cannot stop the others. Rows locked by a
-- concurrent RPC are skipped; the next run picks them up. Returns the number
-- of battles that changed.
create function public.sweep_deadlines()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_job     bigint;
  v_changed int := 0;
begin
  for v_id in
    select b.id
    from public.battles b
    where b.phase not in ('destroyed', 'abandoned')
      and b.phase_ends_at <= now()
    order by b.phase_ends_at
    limit 200
    for update skip locked
  loop
    begin
      if (private.advance(v_id, null, null) ->> 'changed')::boolean then
        v_changed := v_changed + 1;
      end if;
    exception when others then
      raise warning 'sweep_deadlines: battle % not advanced: % (%)', v_id, sqlerrm, sqlstate;
    end;
  end loop;

  -- Jobs that used their last attempt and whose lease expired: the worker
  -- died or never reported. claim_job will not hand them out again.
  for v_job in
    select j.id from public.jobs j
    where j.status = 'running' and j.attempts >= 5 and j.run_after <= now()
    limit 200
  loop
    begin
      perform private.give_up_job(v_job, 'lease expired after the last attempt');
    exception when others then
      raise warning 'sweep_deadlines: job % not failed: % (%)', v_job, sqlerrm, sqlstate;
    end;
  end loop;

  return v_changed;
end;
$$;

-- The 24 h hard TTL for ephemeral data (docs/05 §5.6). For battles created
-- more than 24 h ago and not yet destroyed:
--   * stuck in RESULTS (should not happen: the capture deadline is 10 min)
--     → DESTROYED; the results stay public;
--   * stuck in any other non-terminal phase → ABANDONED (is_complete = false);
--   * terminal → make sure a destroy job is queued; a destroy job that
--     already failed for good is re-queued with fresh attempts.
-- Returns the number of battles touched.
-- M3: also abandon battles whose members stopped sending heartbeats.
create function public.sweep_ttl()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b         public.battles;
  v_cutoff  timestamptz := now() - interval '24 hours';
  v_touched int := 0;
begin
  for b in
    select * from public.battles
    where created_at < v_cutoff
      and destroyed_at is null
    order by created_at
    limit 200
    for update skip locked
  loop
    begin
      if b.phase not in ('destroyed', 'abandoned') then
        update public.battles
           set phase            = case when b.phase = 'results' then 'destroyed'::public.battle_phase
                                       else 'abandoned'::public.battle_phase end,
               phase_started_at = now(),
               phase_ends_at    = null,
               is_complete      = (b.phase = 'results')
         where id = b.id;
        -- The sources are about to go: pending captures can never finish.
        update public.builds
           set capture_status = 'failed'
         where battle_id = b.id
           and status in ('shipped', 'auto_shipped')
           and capture_status = 'pending';
        perform private.bump(b.id, 'phase', null, jsonb_build_object(
          'from', b.phase,
          'to', case when b.phase = 'results' then 'destroyed' else 'abandoned' end,
          'reason', 'ttl'));
      end if;

      insert into public.jobs (kind, ref_id)
      values ('destroy', b.id)
      on conflict (kind, ref_id) do update
        set status = 'queued', attempts = 0, run_after = now(), last_error = null, updated_at = now()
        where public.jobs.status = 'failed';

      v_touched := v_touched + 1;
    exception when others then
      raise warning 'sweep_ttl: battle % not handled: % (%)', b.id, sqlerrm, sqlstate;
    end;
  end loop;

  return v_touched;
end;
$$;

revoke all on function public.sweep_deadlines() from public, anon, authenticated;
revoke all on function public.sweep_ttl()       from public, anon, authenticated;
grant execute on function public.sweep_deadlines() to service_role;
grant execute on function public.sweep_ttl()       to service_role;

-- ─── pg_cron ──────────────────────────────────────────────────────────────
-- Safe to apply anywhere: when pg_cron is not available (a plain Postgres
-- without the extension), the schedule is skipped with a NOTICE and the
-- sweeps can be driven by any other scheduler. On Supabase (hosted and the
-- local stack) pg_cron is available and preloaded; Supabase installs it into
-- pg_catalog, which is what the dashboard does as well.
-- cron.schedule(name, ...) upserts by name, so re-applying is harmless.
-- Sub-minute schedules ('5 seconds') need pg_cron >= 1.5.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: sweeps are not scheduled';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;

  perform cron.schedule('br-sweep-deadlines', '5 seconds', 'select public.sweep_deadlines()');
  perform cron.schedule('br-sweep-ttl', '*/10 * * * *', 'select public.sweep_ttl()');
  -- A 5-second job writes ~17,000 rows a day to cron.job_run_details.
  perform cron.schedule('br-cron-history-cleanup', '17 3 * * *',
    $cmd$delete from cron.job_run_details where end_time < now() - interval '2 days'$cmd$);
end;
$$;
