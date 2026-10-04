-- Build Roulette: the job queue API for the capture and destroy workers
-- (docs/05 §5.4). service_role only; the workers themselves are T-013.
--
-- Lifecycle of a jobs row:
--   queued ──claim_job──▶ running ──complete_*──▶ done
--                           │
--                           ├──fail_job (attempts < 5)──▶ queued, run_after = now() + backoff
--                           ├──fail_job (attempts = 5)──▶ failed
--                           └──lease expires (2 min)───▶ claimable again (attempts < 5)
--                                                         or failed by sweep_deadlines
--
-- claim_job takes a 2-minute lease by moving run_after forward. A worker that
-- crashes mid-job therefore does not lose it: once the lease has expired the
-- job is claimable again. This replaces the separate `sweep_jobs` of the
-- docs/05 draft; there is no pg_net push yet, workers poll claim_job.
--
-- Backoff after a failed attempt n (1-based): 10 s · 2^(n-1), i.e. 10, 20,
-- 40, 80 s. Five attempts fit well inside the 10-minute capture deadline.
--
-- A capture job whose build reaches a terminal capture_status (captured,
-- fallback, failed) lets RESULTS → DESTROYED go ahead once the last-look
-- window is over (docs/04).

-- Lock order everywhere: the battle row first, then builds and jobs. Every
-- path that touches a job of a battle (fail_job, the lease sweep) first locks
-- that battle, like advance and complete_* do, so they cannot deadlock.
-- Returns the battle id (null if the job or its build is gone).
create function private.lock_job_battle(p_job_id bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_battle uuid;
begin
  select case j.kind
           when 'capture' then (select bu.battle_id from public.builds bu where bu.id = j.ref_id)
           else j.ref_id
         end
    into v_battle
  from public.jobs j
  where j.id = p_job_id;

  if v_battle is not null then
    perform 1 from public.battles where id = v_battle for update;
  end if;
  return v_battle;
end;
$$;

-- Shared by fail_job and the lease sweep: gives up on a job for good.
create function private.give_up_job(p_job_id bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j        public.jobs;
  v_battle uuid;
begin
  v_battle := private.lock_job_battle(p_job_id);

  update public.jobs
     set status = 'failed', last_error = left(p_error, 2000), updated_at = now()
   where id = p_job_id
  returning * into j;

  if j.kind = 'capture' then
    if v_battle is not null then
      update public.builds
         set capture_status = 'failed'
       where id = j.ref_id and capture_status = 'pending';
      if found then
        perform private.bump(v_battle, 'capture', null,
          jsonb_build_object('build_id', j.ref_id, 'capture_status', 'failed'));
      end if;
      perform private.try_advance(v_battle, null);
    end if;
  end if;
end;
$$;

-- Claims the oldest ready job of a kind: queued with run_after <= now(), or
-- running with an expired lease. Returns the claimed row (status running,
-- attempts incremented), or NULL when there is nothing to do (through
-- PostgREST: an object whose fields are all null).
create function public.claim_job(p_kind public.job_kind)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  j public.jobs;
begin
  select * into j
  from public.jobs
  where kind = p_kind
    and status in ('queued', 'running')
    and run_after <= now()
    and attempts < 5
  order by run_after, id
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.jobs
     set status     = 'running',
         attempts   = attempts + 1,
         run_after  = now() + interval '2 minutes',   -- lease
         updated_at = now()
   where id = j.id
  returning * into j;

  return j;
end;
$$;

-- Records the result of a capture job and marks the job done.
--   p_status  captured (server render) | fallback (client thumbnail) | failed
--   p_path    object name in the `screenshots` bucket,
--             '{battle_id}/{build_id}.webp' or '.png'; null for failed
-- Accepted even after the capture deadline marked the build failed: a late
-- success still replaces the failure. A build that is already `captured`
-- keeps its screenshot.
create function public.complete_capture(p_build_id uuid, p_status public.capture_status, p_path text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bu public.builds;
begin
  select * into bu from public.builds where id = p_build_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build.';
  end if;

  -- Lock order: battle row first, then builds and jobs.
  perform 1 from public.battles where id = bu.battle_id for update;
  select * into bu from public.builds where id = p_build_id for update;

  if p_status is null or p_status = 'pending' then
    raise exception using errcode = '22023', message = 'invalid_capture_status',
      detail = 'Use captured, fallback or failed.';
  end if;
  if bu.status not in ('shipped', 'auto_shipped') then
    raise exception using errcode = 'P0001', message = 'not_capturable',
      detail = format('A %s build has nothing to capture.', bu.status);
  end if;
  if p_status = 'failed' then
    if p_path is not null then
      raise exception using errcode = '22023', message = 'invalid_path',
        detail = 'A failed capture has no screenshot path.';
    end if;
  elsif p_path is null
        or p_path !~ ('^' || bu.battle_id::text || '/' || bu.id::text || '\.(webp|png)$') then
    raise exception using errcode = '22023', message = 'invalid_path',
      detail = 'The path must be {battle_id}/{build_id}.webp (or .png) in the screenshots bucket.';
  end if;

  if bu.capture_status <> 'captured' then
    update public.builds
       set capture_status  = p_status,
           screenshot_path = p_path,
           captured_at     = case when p_status = 'failed' then null else now() end
     where id = p_build_id;

    perform private.bump(bu.battle_id, 'capture', null,
      jsonb_build_object('build_id', p_build_id, 'capture_status', p_status));
  end if;

  update public.jobs
     set status = 'done', last_error = null, updated_at = now()
   where kind = 'capture' and ref_id = p_build_id;

  perform private.try_advance(bu.battle_id, null);
end;
$$;

-- Records a failed attempt. Below 5 attempts the job is re-queued with
-- exponential backoff; at 5 it fails for good (and a capture job marks its
-- build capture_status = failed). Returns the updated job row.
create function public.fail_job(p_job_id bigint, p_error text)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  j public.jobs;
begin
  perform private.lock_job_battle(p_job_id);
  select * into j from public.jobs where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'job_not_found',
      detail = 'No such job.';
  end if;
  if j.status <> 'running' then
    raise exception using errcode = 'P0001', message = 'job_not_running',
      detail = format('The job is %s.', j.status);
  end if;

  if j.attempts >= 5 then
    perform private.give_up_job(p_job_id, p_error);
  else
    update public.jobs
       set status     = 'queued',
           last_error = left(p_error, 2000),
           run_after  = now() + make_interval(secs => 10 * power(2, greatest(j.attempts, 1) - 1)),
           updated_at = now()
     where id = p_job_id;
  end if;

  select * into j from public.jobs where id = p_job_id;
  return j;
end;
$$;

-- Called by the destroy-worker after it deleted ephemeral-builds/{battle_id}/
-- through the Storage API. Stamps builds.source_destroyed_at and
-- battles.destroyed_at and marks the destroy job done. Only for a battle in
-- DESTROYED or ABANDONED. Idempotent: a second call changes nothing.
create function public.complete_destroy(p_battle_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.battles;
begin
  select * into b from public.battles where id = p_battle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;
  if b.phase not in ('destroyed', 'abandoned') then
    raise exception using errcode = 'P0001', message = 'wrong_phase',
      detail = format('Cannot destroy a battle in %s.', b.phase);
  end if;

  update public.jobs
     set status = 'done', last_error = null, updated_at = now()
   where kind = 'destroy' and ref_id = p_battle_id and status <> 'done';

  if b.destroyed_at is not null then
    return;
  end if;

  update public.builds
     set source_destroyed_at = now()
   where battle_id = p_battle_id and source_destroyed_at is null;

  update public.battles set destroyed_at = now() where id = p_battle_id;

  perform private.bump(p_battle_id, 'destroyed', null, '{}'::jsonb);
end;
$$;

revoke all on function private.lock_job_battle(bigint)                                from public, anon, authenticated;
revoke all on function private.give_up_job(bigint, text)                              from public, anon, authenticated;
revoke all on function public.claim_job(public.job_kind)                              from public, anon, authenticated;
revoke all on function public.complete_capture(uuid, public.capture_status, text)     from public, anon, authenticated;
revoke all on function public.fail_job(bigint, text)                                  from public, anon, authenticated;
revoke all on function public.complete_destroy(uuid)                                  from public, anon, authenticated;

grant execute on function public.claim_job(public.job_kind)                           to service_role;
grant execute on function public.complete_capture(uuid, public.capture_status, text)  to service_role;
grant execute on function public.fail_job(bigint, text)                               to service_role;
grant execute on function public.complete_destroy(uuid)                               to service_role;
