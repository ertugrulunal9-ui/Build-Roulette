-- Build Roulette (T-024, M5): per-user rate limits in Postgres (docs/02 R9).
--
-- One helper for every limited RPC, with the limits in one table:
--
--   action             limit           counted                       used by
--   create_room        10 per hour     rooms created                 create_room
--   join_room_failed   20 per 10 min   wrong or closed room codes    join_room (code guessing)
--   report_build       20 per hour     reports filed                 report_build
--   start_solo_battle  30 per hour     solo battles started          start_solo_battle
--   cast_vote          120 per minute  votes cast (revotes too)      cast_vote (floods only)
--
-- @br/game `RATE_LIMITS` mirrors the seed below (drift-tested). The table is the
-- configuration: an operator can change a limit with SQL (service side only, schema
-- `private`), e.g.
--   update private.rate_limits set max_count = 5 where action = 'create_room';
--
-- ─── The window ───────────────────────────────────────────────────────────
-- Sliding window over an event log: a call is allowed when the user has fewer than
-- `max_count` events of that action in the last `window_s` seconds. An allowed call records
-- an event in the same transaction, so a call that fails later (any guard) rolls its event
-- back and only successful calls count. `join_room` is the exception: it counts its
-- FAILURES, and records them on a path that does not raise (see that function).
--
-- Over the limit: SQLSTATE PT429 (PostgREST answers HTTP 429), message `rate_limited`,
-- `details` a sentence for people ("… Try again in 12 minutes."), `hint` JSON
-- `{"retry_after_s": n}` (when the oldest counted event leaves the window). PostgREST does
-- not send a Retry-After header for a raised error, hence the hint.
--
-- Per USER (auth.uid()). Anonymous sign-ins are cheap, so per-IP limits at the edge
-- (Cloudflare) and Turnstile on anonymous sign-up are the outer layer; see
-- supabase/README.md "Abuse controls".
--
-- Concurrency: one advisory transaction lock per (user, action), so two parallel calls
-- cannot both take the last slot.
-- Pruning: the helper deletes the caller's expired events for that action; an hourly
-- pg_cron job deletes everything older than the longest window.

create table private.rate_limits (
  action     text primary key check (action ~ '^[a-z_]+$'),
  max_count  int  not null check (max_count > 0),
  window_s   int  not null check (window_s between 1 and 86400),
  -- The noun of the details sentence: "You created too many <label> recently."
  label      text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.rate_limits from public, anon, authenticated, service_role;

insert into private.rate_limits (action, max_count, window_s, label) values
  ('create_room',       10, 3600, 'rooms'),
  ('join_room_failed',  20,  600, 'wrong room codes'),
  ('report_build',      20, 3600, 'reports'),
  ('start_solo_battle', 30, 3600, 'solo battles'),
  ('cast_vote',        120,   60, 'votes')
on conflict (action) do nothing;

create table private.rate_events (
  id         bigint generated always as identity primary key,
  action     text not null references private.rate_limits (action) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index rate_events_user_action_idx on private.rate_events (user_id, action, created_at);
create index rate_events_created_idx on private.rate_events (created_at);
revoke all on private.rate_events from public, anon, authenticated, service_role;

-- Raises rate_limited when the user is at the limit of p_action; otherwise does nothing.
-- Takes the per-(user, action) lock and prunes the user's expired events.
create function private.rate_limit_check(p_action text, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cfg      private.rate_limits;
  v_count  int;
  v_free   timestamptz;
  v_retry  int;
begin
  select * into cfg from private.rate_limits where action = p_action;
  if not found then
    raise exception 'private.rate_limit_check: unknown action %', p_action;
  end if;
  if p_user_id is null then
    return;   -- the callers require auth first; nothing to count without a user
  end if;

  perform pg_advisory_xact_lock(hashtextextended('br:rate:' || p_action || ':' || p_user_id::text, 0));

  delete from private.rate_events
   where user_id = p_user_id and action = p_action
     and created_at <= now() - make_interval(secs => cfg.window_s);

  select count(*)::int into v_count
  from private.rate_events where user_id = p_user_id and action = p_action;
  if v_count < cfg.max_count then
    return;
  end if;

  -- The next call is allowed once the count drops to max_count - 1: when the
  -- (v_count - max_count + 1)-th oldest event leaves the window.
  select e.created_at into v_free
  from private.rate_events e
  where e.user_id = p_user_id and e.action = p_action
  order by e.created_at, e.id
  offset v_count - cfg.max_count
  limit 1;
  v_retry := greatest(1, ceil(extract(epoch from (v_free + make_interval(secs => cfg.window_s) - now())))::int);

  raise exception using errcode = 'PT429', message = 'rate_limited',
    detail = format('You sent too many %s recently. Try again in %s.', cfg.label,
                    case when v_retry < 120 then v_retry || ' seconds'
                         else ceil(v_retry / 60.0)::int || ' minutes' end),
    hint = jsonb_build_object('retry_after_s', v_retry)::text;
end;
$$;

-- Records one event of p_action for the user (the caller holds the lock from
-- rate_limit_check, or takes it here).
create function private.rate_limit_record(p_action text, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('br:rate:' || p_action || ':' || p_user_id::text, 0));
  insert into private.rate_events (action, user_id) values (p_action, p_user_id);
end;
$$;

-- The usual case: check, then count this call (rolled back if the call fails later).
create function private.rate_limit(p_action text, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.rate_limit_check(p_action, p_user_id);
  perform private.rate_limit_record(p_action, p_user_id);
end;
$$;

-- Hourly: drops events older than the longest window. Returns the number deleted.
create function private.prune_rate_events()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from private.rate_events
   where created_at < now() - make_interval(secs => (select coalesce(max(window_s), 86400)
                                                     from private.rate_limits));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.rate_limit_check(text, uuid)  from public, anon, authenticated, service_role;
revoke all on function private.rate_limit_record(text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.rate_limit(text, uuid)        from public, anon, authenticated, service_role;
revoke all on function private.prune_rate_events()           from public, anon, authenticated, service_role;

-- pg_cron, like 20261004120500_sweeps_and_cron.sql (skipped where pg_cron is missing).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed: rate events are not pruned on a schedule';
    return;
  end if;
  perform cron.schedule('br-rate-events-prune', '23 * * * *', 'select private.prune_rate_events()');
end;
$$;
