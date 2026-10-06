-- Build Roulette (T-016, M3): presence rules in the existing sweeps
-- (docs/04 §4.8, docs/05 §5.6).
--
-- sweep_deadlines (pg_cron, every 5 s), in this order, each battle or room in
-- its own subtransaction so one failure cannot stop the others:
--   1. advance overdue battles (unchanged);
--   2. abandonment: a room battle in SPINNING, BUILDING, SHIPPING, REVEAL or
--      VOTING where no roster player (not kicked) has sent a heartbeat for
--      5 minutes → ABANDONED (results partial, destroy queued, room reopens);
--   3. host migration: rooms whose host is not present while another member
--      is (private.ensure_host, the same rule the RPCs apply lazily);
--   4. jobs whose last lease expired (unchanged).
--   Returns the number of battles that changed (advanced or abandoned).
--
-- sweep_ttl (pg_cron, every 10 min):
--   1. the 24 h hard TTL for battles (unchanged, except that the room of an
--      ended battle reopens);
--   2. idle rooms: an open room with no room event and no heartbeat for 2 h
--      → closed;
--   3. purge: rooms closed more than 7 days ago are deleted (members and room
--      events cascade; battles keep their results with room_id = null).
--   Returns the number of battles touched (rooms are not counted).
--
-- Solo battles have no room and no heartbeat; only the 24 h TTL applies to
-- them, as before.

create or replace function public.sweep_deadlines()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_job     bigint;
  v_room    uuid;
  r         public.rooms;
  v_changed int := 0;
begin
  -- 1. Deadlines.
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

  -- 2. Abandonment (room battles only; RESULTS ends on its own deadline).
  for v_id in
    select b.id
    from public.battles b
    where b.phase in ('spinning', 'building', 'shipping', 'reveal', 'voting')
      and b.room_id is not null
      and not exists (
        select 1
        from public.battle_players bp
        join public.room_members rm on rm.room_id = b.room_id and rm.user_id = bp.user_id
        where bp.battle_id = b.id
          and rm.kicked_at is null
          and rm.last_seen_at >= now() - private.room_limit_interval('abandon_s'))
    order by b.created_at
    limit 200
    for update skip locked
  loop
    begin
      perform private.abandon_battle(v_id, 'no_presence', null);
      v_changed := v_changed + 1;
    exception when others then
      raise warning 'sweep_deadlines: battle % not abandoned: % (%)', v_id, sqlerrm, sqlstate;
    end;
  end loop;

  -- 3. Host migration.
  for v_room in
    select ro.id
    from public.rooms ro
    where ro.status <> 'closed'
      and not exists (
        select 1 from public.room_members h
        where h.room_id = ro.id and h.user_id = ro.host_id and private.is_present(h))
      and exists (
        select 1 from public.room_members c
        where c.room_id = ro.id and c.user_id <> ro.host_id and private.is_present(c))
    limit 200
  loop
    begin
      r := private.lock_room(v_room, true);
      if r.id is not null then
        perform private.ensure_host(v_room, null);
      end if;
    exception when others then
      raise warning 'sweep_deadlines: room % host not migrated: % (%)', v_room, sqlerrm, sqlstate;
    end;
  end loop;

  -- 4. Jobs that used their last attempt and whose lease expired.
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

create or replace function public.sweep_ttl()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b         public.battles;
  v_room    uuid;
  r         public.rooms;
  v_cutoff  timestamptz := now() - interval '24 hours';
  v_touched int := 0;
begin
  -- 1. The 24 h hard TTL for ephemeral data.
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
        perform private.on_battle_ended(b.id, null);
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

  -- 2. Idle rooms.
  for v_room in
    select ro.id
    from public.rooms ro
    where ro.status = 'open'
      and ro.last_activity_at < now() - private.room_limit_interval('idle_close_s')
      and not exists (
        select 1 from public.room_members m
        where m.room_id = ro.id
          and m.kicked_at is null
          and m.last_seen_at >= now() - private.room_limit_interval('idle_close_s'))
    order by ro.last_activity_at
    limit 200
  loop
    begin
      r := private.lock_room(v_room, true);
      if r.id is not null and r.status = 'open' then
        update public.rooms set status = 'closed', closed_at = now() where id = v_room;
        perform private.room_bump(v_room, 'closed', null, jsonb_build_object('reason', 'idle'));
      end if;
    exception when others then
      raise warning 'sweep_ttl: room % not closed: % (%)', v_room, sqlerrm, sqlstate;
    end;
  end loop;

  -- 3. Purge closed rooms (docs/05 §5.6: rooms and members, 7 days after close).
  begin
    delete from public.rooms
     where id in (
       select ro.id from public.rooms ro
       where ro.status = 'closed'
         and ro.closed_at < now() - private.room_limit_interval('purge_closed_s')
       order by ro.closed_at
       limit 500);
  exception when others then
    raise warning 'sweep_ttl: closed rooms not purged: % (%)', sqlerrm, sqlstate;
  end;

  return v_touched;
end;
$$;
