-- Build Roulette (T-019, M4): the REVEAL and VOTING events on battle:{id}.
--
-- Replaces private.battle_broadcast (the trigger and the realtime.messages
-- policies are unchanged: members receive, nobody but Postgres broadcasts).
-- Changes:
--   phase          + reveal_index whenever the new phase is REVEAL (the first
--                    slot and every next one); `reason` may now also be
--                    host_next, host_skip, all_voted or too_few_builds
--   vote_progress  NEW, from a `vote` battle event: {voted_count,
--                    eligible_count}. Sent only when a voter completes their
--                    ballot. Never who voted, never for what, never tallies.
-- Everything else is as in 20261006130300_realtime.sql.

create or replace function private.battle_broadcast(p_event public.battle_events)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b       public.battles;
  v_type  text;
  v_body  jsonb := '{}'::jsonb;
begin
  case p_event.type
  when 'phase' then
    select * into b from public.battles where id = p_event.battle_id;
    v_type := 'phase';
    v_body := jsonb_build_object(
      'phase', p_event.payload ->> 'to',
      'phase_started_at', b.phase_started_at,
      'phase_ends_at', b.phase_ends_at)
      || jsonb_strip_nulls(jsonb_build_object('reason', p_event.payload ->> 'reason'));
    if p_event.payload ->> 'to' = 'reveal' then
      v_body := v_body || jsonb_build_object(
        'reveal_index', coalesce((p_event.payload ->> 'reveal_index')::int, b.reveal_index));
    end if;
  when 'ship' then
    v_type := 'build';
    v_body := jsonb_build_object(
      'build_id', p_event.payload ->> 'build_id',
      'user_id', p_event.actor_id,
      'status', 'shipped',
      'name', p_event.payload ->> 'name',
      'completion_ms', (p_event.payload ->> 'completion_ms')::int);
  when 'leave' then
    v_type := 'player';
    v_body := jsonb_build_object('user_id', p_event.payload ->> 'user_id', 'status', 'left');
  when 'rejoin' then
    v_type := 'player';
    v_body := jsonb_build_object('user_id', p_event.payload ->> 'user_id', 'status', 'active');
  when 'kick' then
    v_type := 'player';
    v_body := jsonb_build_object(
      'user_id', p_event.payload ->> 'user_id',
      'status', 'kicked',
      'build_status', p_event.payload ->> 'build_status');
  when 'host_change' then
    v_type := 'host';
    v_body := jsonb_build_object('host_id', p_event.payload ->> 'host_id');
  when 'capture' then
    v_type := 'capture';
    v_body := jsonb_build_object(
      'build_id', p_event.payload ->> 'build_id',
      'capture_status', p_event.payload ->> 'capture_status');
  when 'vote' then
    v_type := 'vote_progress';
    v_body := jsonb_build_object(
      'voted_count', (p_event.payload ->> 'voted_count')::int,
      'eligible_count', (p_event.payload ->> 'eligible_count')::int);
  when 'destroyed' then
    v_type := 'destroyed';
  else
    v_type := 'sync';
  end case;

  return jsonb_build_object('type', v_type, 'version', p_event.version) || v_body;
end;
$$;
