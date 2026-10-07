-- T-021: get_player_history (the player history page /u/[id], readable with the anon
-- key): only RESULTS/DESTROYED battles, only permanent data of the player's own build,
-- no other user ids, no ephemeral paths, no ballots; keyset pagination newest first,
-- including battles that finished in the same transaction (same finished_at).
--
-- Cast: ada (the player whose history is read), bob and cy (her opponents), dot (never
-- finished a battle). Fixtures are inserted as the superuser.

begin;
create extension if not exists pgtap with schema extensions;

select plan(36);

\set ada '1a000000-0000-0000-0000-00000000000a'
\set bob '1a000000-0000-0000-0000-00000000000b'
\set cy  '1a000000-0000-0000-0000-00000000000c'
\set dot '1a000000-0000-0000-0000-00000000000d'

insert into auth.users (id, is_anonymous) values
  (:'ada', true), (:'bob', true), (:'cy', true), (:'dot', true);
insert into public.profiles (id, display_name) values
  (:'ada', 'Ada Profile'), (:'bob', 'Bob'), (:'cy', 'Cy'), (:'dot', 'Dot');

-- Battles (b1 newest public … b9). t0 = a fixed instant; b4 and b5 finished in the same
-- transaction (same finished_at), so only the battle id orders them.
--   b1 results    multiplayer  ada #2 of 3 (bob #1, cy #3), a vote award, captured
--   b2 destroyed  solo         ada #1 of 1, speedrun, captured then destroyed
--   b3 abandoned  multiplayer  (not public)
--   b4 results    multiplayer  ada DNF, finished at t0 - 3 h
--   b5 results    multiplayer  ada auto-shipped #2 of 2, finished at t0 - 3 h (tie with b4)
--   b6 building   multiplayer  (running: not public)
--   b7 results    multiplayer  ada disqualified (kicked): left out
--   b8 destroyed  multiplayer  ada #1 of 2, finished at t0 - 5 h, name "Old Ada"
--   b9 results    multiplayer  dot's build was disqualified, dot has nothing else
\set t0 '2026-10-07 12:00:00+00'
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('c1000000-0000-0000-0000-00000000000' || n)::uuid,
       'Build ' || n, 'Rule ' || n, 'Style ' || n, 300
from generate_series(1, 9) n;

insert into public.battles (id, challenge_id, host_id, settings, phase, finished_at, destroyed_at, is_complete)
values
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', :'bob',
   '{"mode":"multiplayer","reveal_vote":true}', 'results',  :'t0'::timestamptz - interval '1 hour', null, true),
  ('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', :'ada',
   '{"mode":"solo"}', 'destroyed', :'t0'::timestamptz - interval '2 hours', :'t0'::timestamptz - interval '1 hour', true),
  ('b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', :'ada',
   '{"mode":"multiplayer"}', 'abandoned', null, null, false),
  ('b1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000004', :'bob',
   '{"mode":"multiplayer"}', 'results', :'t0'::timestamptz - interval '3 hours', null, true),
  ('b1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000005', :'bob',
   '{"mode":"multiplayer"}', 'results', :'t0'::timestamptz - interval '3 hours', null, true),
  ('b1000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000006', :'ada',
   '{"mode":"multiplayer"}', 'building', null, null, false),
  ('b1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000007', :'bob',
   '{"mode":"multiplayer"}', 'results', :'t0'::timestamptz - interval '4 hours', null, true),
  ('b1000000-0000-0000-0000-000000000008', 'c1000000-0000-0000-0000-000000000008', :'bob',
   '{"mode":"multiplayer"}', 'destroyed', :'t0'::timestamptz - interval '5 hours', :'t0'::timestamptz - interval '5 hours', true),
  ('b1000000-0000-0000-0000-000000000009', 'c1000000-0000-0000-0000-000000000009', :'bob',
   '{"mode":"multiplayer"}', 'results', :'t0'::timestamptz - interval '6 hours', null, true);

insert into public.battle_players (battle_id, user_id, display_name) values
  ('b1000000-0000-0000-0000-000000000001', :'ada', 'Ada'),
  ('b1000000-0000-0000-0000-000000000001', :'bob', 'Bob'),
  ('b1000000-0000-0000-0000-000000000001', :'cy',  'Cy'),
  ('b1000000-0000-0000-0000-000000000002', :'ada', 'Ada Solo'),
  ('b1000000-0000-0000-0000-000000000003', :'ada', 'Ada'),
  ('b1000000-0000-0000-0000-000000000004', :'ada', 'Ada'),
  ('b1000000-0000-0000-0000-000000000004', :'bob', 'Bob'),
  ('b1000000-0000-0000-0000-000000000005', :'ada', 'Ada'),
  ('b1000000-0000-0000-0000-000000000005', :'bob', 'Bob'),
  ('b1000000-0000-0000-0000-000000000006', :'ada', 'Ada'),
  ('b1000000-0000-0000-0000-000000000007', :'ada', 'Ada Kicked'),
  ('b1000000-0000-0000-0000-000000000007', :'bob', 'Bob'),
  ('b1000000-0000-0000-0000-000000000008', :'ada', 'Old Ada'),
  ('b1000000-0000-0000-0000-000000000008', :'bob', 'Bob'),
  ('b1000000-0000-0000-0000-000000000009', :'dot', 'Dot'),
  ('b1000000-0000-0000-0000-000000000009', :'bob', 'Bob');

insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms,
                           final_rank, total_votes, vote_counts, capture_status, screenshot_path,
                           source_destroyed_at)
values
  ('d1000000-0000-0000-0000-0000000000a1', 'b1000000-0000-0000-0000-000000000001', :'ada', 'Snack Overflow',
   'shipped', :'t0'::timestamptz - interval '90 minutes', 180000, 2, 3,
   '{"overall":1,"rule":2,"style":0,"chaos":0}', 'captured',
   'b1000000-0000-0000-0000-000000000001/d1000000-0000-0000-0000-0000000000a1.webp', null),
  ('d1000000-0000-0000-0000-0000000000b1', 'b1000000-0000-0000-0000-000000000001', :'bob', 'Bob Build',
   'shipped', :'t0'::timestamptz - interval '95 minutes', 120000, 1, 4,
   '{"overall":2,"rule":0,"style":1,"chaos":1}', 'captured',
   'b1000000-0000-0000-0000-000000000001/d1000000-0000-0000-0000-0000000000b1.webp', null),
  ('d1000000-0000-0000-0000-0000000000c1', 'b1000000-0000-0000-0000-000000000001', :'cy', null,
   'auto_shipped', :'t0'::timestamptz - interval '85 minutes', 300000, 3, 0,
   '{"overall":0,"rule":0,"style":0,"chaos":0}', 'pending', null, null),
  ('d1000000-0000-0000-0000-0000000000a2', 'b1000000-0000-0000-0000-000000000002', :'ada', 'Solo Run',
   'shipped', :'t0'::timestamptz - interval '150 minutes', 61000, 1, 0, null, 'captured',
   'b1000000-0000-0000-0000-000000000002/d1000000-0000-0000-0000-0000000000a2.webp',
   :'t0'::timestamptz - interval '1 hour'),
  ('d1000000-0000-0000-0000-0000000000a3', 'b1000000-0000-0000-0000-000000000003', :'ada', 'Abandoned',
   'shipped', :'t0'::timestamptz - interval '7 hours', 1000, null, 0, null, 'pending', null, null),
  ('d1000000-0000-0000-0000-0000000000a4', 'b1000000-0000-0000-0000-000000000004', :'ada', null,
   'dnf', null, null, null, 0, null, 'pending', null, null),
  ('d1000000-0000-0000-0000-0000000000b4', 'b1000000-0000-0000-0000-000000000004', :'bob', 'Bob 4',
   'shipped', :'t0'::timestamptz - interval '200 minutes', 1000, 1, 0, null, 'failed', null, null),
  ('d1000000-0000-0000-0000-0000000000a5', 'b1000000-0000-0000-0000-000000000005', :'ada', null,
   'auto_shipped', :'t0'::timestamptz - interval '200 minutes', 300000, 2, 0, null, 'fallback',
   'b1000000-0000-0000-0000-000000000005/d1000000-0000-0000-0000-0000000000a5.webp', null),
  ('d1000000-0000-0000-0000-0000000000b5', 'b1000000-0000-0000-0000-000000000005', :'bob', 'Bob 5',
   'shipped', :'t0'::timestamptz - interval '210 minutes', 1000, 1, 0, null, 'captured',
   'b1000000-0000-0000-0000-000000000005/d1000000-0000-0000-0000-0000000000b5.webp', null),
  ('d1000000-0000-0000-0000-0000000000a6', 'b1000000-0000-0000-0000-000000000006', :'ada', null,
   'draft', null, null, null, 0, null, 'pending', null, null),
  ('d1000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-000000000007', :'ada', 'Kicked Build',
   'disqualified', null, null, null, 0, null, 'pending', null, null),
  ('d1000000-0000-0000-0000-0000000000b7', 'b1000000-0000-0000-0000-000000000007', :'bob', 'Bob 7',
   'shipped', :'t0'::timestamptz - interval '250 minutes', 1000, 1, 0, null, 'captured',
   'b1000000-0000-0000-0000-000000000007/d1000000-0000-0000-0000-0000000000b7.webp', null),
  ('d1000000-0000-0000-0000-0000000000a8', 'b1000000-0000-0000-0000-000000000008', :'ada', 'Old Ada Build',
   'shipped', :'t0'::timestamptz - interval '320 minutes', 1000, 1, 0, null, 'captured',
   'b1000000-0000-0000-0000-000000000008/d1000000-0000-0000-0000-0000000000a8.webp',
   :'t0'::timestamptz - interval '5 hours'),
  ('d1000000-0000-0000-0000-0000000000b8', 'b1000000-0000-0000-0000-000000000008', :'bob', 'Bob 8',
   'shipped', :'t0'::timestamptz - interval '330 minutes', 2000, 2, 0, null, 'captured',
   'b1000000-0000-0000-0000-000000000008/d1000000-0000-0000-0000-0000000000b8.webp',
   :'t0'::timestamptz - interval '5 hours'),
  ('d1000000-0000-0000-0000-0000000000d9', 'b1000000-0000-0000-0000-000000000009', :'dot', 'Dot Kicked',
   'disqualified', null, null, null, 0, null, 'pending', null, null),
  ('d1000000-0000-0000-0000-0000000000b9', 'b1000000-0000-0000-0000-000000000009', :'bob', 'Bob 9',
   'shipped', :'t0'::timestamptz - interval '370 minutes', 1000, 1, 0, null, 'captured',
   'b1000000-0000-0000-0000-000000000009/d1000000-0000-0000-0000-0000000000b9.webp', null);

insert into public.awards (battle_id, build_id, award, source, votes) values
  ('b1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-0000000000a1', 'rule', 'vote', 2),
  ('b1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-0000000000b1', 'overall', 'vote', 2),
  ('b1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-0000000000a2', 'speedrun', 'auto', null);

-- Ballots exist (bob and cy voted for ada's build): they must never show.
insert into public.votes (battle_id, voter_id, category, build_id) values
  ('b1000000-0000-0000-0000-000000000001', :'bob', 'rule', 'd1000000-0000-0000-0000-0000000000a1'),
  ('b1000000-0000-0000-0000-000000000001', :'cy',  'rule', 'd1000000-0000-0000-0000-0000000000a1');

-- Calls get_player_history as anon (no session), the way the page does.
create function pg_temp.history(p_user uuid, p_before timestamptz default null,
                                p_before_battle uuid default null, p_limit int default 20)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v := public.get_player_history(p_user, p_before, p_before_battle, p_limit);
  reset role;
  return v;
end $$;
grant execute on function pg_temp.history(uuid, timestamptz, uuid, int) to public;

-- All of a user's history, page by page (p_limit per page): the battle ids in order.
create function pg_temp.all_pages(p_user uuid, p_limit int) returns uuid[] language plpgsql as $$
declare
  v_page jsonb;
  v_ids  uuid[] := '{}';
  v_before timestamptz;
  v_before_battle uuid;
  v_guard int := 0;
begin
  loop
    v_page := pg_temp.history(p_user, v_before, v_before_battle, p_limit);
    v_ids := v_ids || array(select (x ->> 'battle_id')::uuid
                            from jsonb_array_elements(v_page -> 'battles') x);
    exit when v_page -> 'next' = 'null'::jsonb or v_page -> 'next' is null;
    v_before := (v_page -> 'next' ->> 'before')::timestamptz;
    v_before_battle := (v_page -> 'next' ->> 'before_battle')::uuid;
    v_guard := v_guard + 1;
    exit when v_guard > 20;
  end loop;
  return v_ids;
end $$;
grant execute on function pg_temp.all_pages(uuid, int) to public;

select pg_temp.history(:'ada') as h \gset

-- ─── Which battles (6) ─────────────────────────────────────────────────────
select is(
  (select array_agg((x ->> 'battle_id')::uuid order by o)
   from jsonb_array_elements((:'h'::jsonb) -> 'battles') with ordinality t(x, o)),
  array['b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002',
        'b1000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000004',
        'b1000000-0000-0000-0000-000000000008']::uuid[],
  'RESULTS and DESTROYED battles only, newest first (a finished_at tie by battle id, descending)');
select ok(:'h' !~ 'b1000000-0000-0000-0000-000000000003', 'an ABANDONED battle is left out');
select ok(:'h' !~ 'b1000000-0000-0000-0000-000000000006', 'a running battle is left out');
select ok(:'h' !~ 'b1000000-0000-0000-0000-000000000007',
  'a battle where the player was disqualified (kicked) is left out, like on the results page');
select is((:'h'::jsonb) -> 'next', 'null'::jsonb, 'one page: no next cursor');
select is((:'h'::jsonb) -> 'player', '{"display_name":"Ada"}'::jsonb,
  'the display name is the one of the newest public battle (not the profile)');

-- ─── What each battle shows (10) ──────────────────────────────────────────
select is(
  (select array_agg(k order by k) from jsonb_object_keys((:'h'::jsonb) -> 'battles' -> 0) k),
  array['awards', 'battle_id', 'build', 'challenge', 'destroyed_at', 'display_name',
        'finished_at', 'mode', 'phase', 'players_count'],
  'battle: permanent fields only (no host, room, settings, version or roster ids)');
select is(
  (select array_agg(k order by k) from jsonb_object_keys((:'h'::jsonb) -> 'battles' -> 0 -> 'build') k),
  array['capture_status', 'completion_ms', 'final_rank', 'id', 'name', 'screenshot_path',
        'status', 'taken_down', 'total_votes', 'votes'],
  'build: permanent fields only (no builder id, no source paths, no stats)');
select is((:'h'::jsonb) -> 'battles' -> 0 -> 'challenge',
  '{"build":{"text":"Build 1"},"rule":{"text":"Rule 1"},"style":{"text":"Style 1"},"time_limit_seconds":300}'::jsonb,
  'the challenge texts and the time limit');
select is(
  ((:'h'::jsonb) -> 'battles' -> 0 -> 'build') - 'id',
  '{"name":"Snack Overflow","status":"shipped","completion_ms":180000,"final_rank":2,"total_votes":3,"votes":{"overall":1,"rule":2,"style":0,"chaos":0},"capture_status":"captured","taken_down":false,"screenshot_path":"b1000000-0000-0000-0000-000000000001/d1000000-0000-0000-0000-0000000000a1.webp"}'::jsonb,
  'the build: name, status, time, rank, vote counts per category, public screenshot');
select is((:'h'::jsonb) -> 'battles' -> 0 ->> 'players_count', '3', 'rank 2 of 3 (N = the builds the results page lists)');
select is((:'h'::jsonb) -> 'battles' -> 0 -> 'awards', '[{"award":"rule","source":"vote","votes":2}]'::jsonb,
  'only the player''s own awards (not the winner''s)');
select is(
  (select jsonb_build_object('mode', x ->> 'mode', 'phase', x ->> 'phase', 'name', x ->> 'display_name',
                             'rank', x -> 'build' -> 'final_rank', 'of', x -> 'players_count', 'awards', x -> 'awards')
   from jsonb_array_elements((:'h'::jsonb) -> 'battles') x
   where x ->> 'battle_id' = 'b1000000-0000-0000-0000-000000000002'),
  '{"mode":"solo","phase":"destroyed","name":"Ada Solo","rank":1,"of":1,"awards":[{"award":"speedrun","source":"auto","votes":null}]}'::jsonb,
  'a destroyed solo battle: rank 1 of 1, its auto-award, its own display name');
select is(
  (select x -> 'build' from jsonb_array_elements((:'h'::jsonb) -> 'battles') x
   where x ->> 'battle_id' = 'b1000000-0000-0000-0000-000000000004') - 'id',
  '{"name":null,"status":"dnf","completion_ms":null,"final_rank":null,"total_votes":0,"votes":null,"capture_status":"pending","taken_down":false,"screenshot_path":null}'::jsonb,
  'a DNF: no rank, no time, no screenshot');
select is(
  (select x -> 'build' ->> 'screenshot_path' from jsonb_array_elements((:'h'::jsonb) -> 'battles') x
   where x ->> 'battle_id' = 'b1000000-0000-0000-0000-000000000005'),
  'b1000000-0000-0000-0000-000000000005/d1000000-0000-0000-0000-0000000000a5.webp',
  'a fallback capture (the client thumbnail) is public too');
select is(
  (select (x -> 'build' ->> 'final_rank') || '/' || (x ->> 'players_count')
   from jsonb_array_elements((:'h'::jsonb) -> 'battles') x
   where x ->> 'battle_id' = 'b1000000-0000-0000-0000-000000000001'),
  (select (b -> 'final_rank')::text || '/' || jsonb_array_length(pb -> 'builds')::text
   from (select public.get_public_battle('b1000000-0000-0000-0000-000000000001') pb) p,
        jsonb_array_elements(pb -> 'builds') b
   where b ->> 'name' = 'Snack Overflow'),
  'rank and N agree with the public results page');

-- ─── Privacy (6) ──────────────────────────────────────────────────────────
select ok(position(:'bob' in :'h') = 0 and position(:'cy' in :'h') = 0,
  'no other user id appears anywhere (opponents, voters, the host)');
select ok(position(:'ada' in :'h') = 0, 'not even the player''s own id is repeated');
select ok(:'h' !~ '(source\.json|bundle\.js|bundle\.css|thumb\.webp|manifest\.json|autosave)',
  'no ephemeral storage path');
select ok(:'h' !~ '"(voter_id|voted_at|ballot|votes_by)"',
  'no ballot: who voted for what never appears (only counts per category)');
select ok(:'h' !~ '(Bob Build|Bob 5|Bob 8|"Cy")',
  'no other player''s build or name');
select ok(:'h' !~ 'Ada Profile', 'the mutable profile name is not used');

-- ─── Nobody and nothing (4) ───────────────────────────────────────────────
select is(pg_temp.history(gen_random_uuid()),
  '{"player":null,"battles":[],"next":null}'::jsonb, 'an unknown id: the empty answer');
select is(pg_temp.history(:'dot'),
  '{"player":null,"battles":[],"next":null}'::jsonb,
  'a player whose only finished battle is not public: the same empty answer');
select is(pg_temp.history(null),
  '{"player":null,"battles":[],"next":null}'::jsonb, 'a null id: the same empty answer');
update public.battles set phase = 'reveal', finished_at = null
 where id = 'b1000000-0000-0000-0000-000000000009';
select is(pg_temp.history(:'dot'),
  '{"player":null,"battles":[],"next":null}'::jsonb,
  'a player with only a running battle: the same answer (nothing to probe)');

-- ─── Pagination (7) ───────────────────────────────────────────────────────
select pg_temp.history(:'ada', null, null, 2) as p1 \gset
select is(jsonb_array_length((:'p1'::jsonb) -> 'battles'), 2, 'p_limit = 2: two battles');
select is((:'p1'::jsonb) -> 'next',
  jsonb_build_object('before', (:'p1'::jsonb) -> 'battles' -> 1 -> 'finished_at',
                     'before_battle', (:'p1'::jsonb) -> 'battles' -> 1 -> 'battle_id'),
  'next is the cursor of the page''s oldest battle');
select is(pg_temp.all_pages(:'ada', 2),
  array['b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002',
        'b1000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000004',
        'b1000000-0000-0000-0000-000000000008']::uuid[],
  'pages of 2: every battle once, in order, across the finished_at tie (b5 | b4 on two pages)');
select is(pg_temp.all_pages(:'ada', 1),
  pg_temp.all_pages(:'ada', 50), 'pages of 1 give the same list as one page');
select is(jsonb_array_length(pg_temp.history(:'ada', :'t0'::timestamptz - interval '3 hours') -> 'battles'), 1,
  'p_before alone: strictly older battles (the tie at that instant is excluded)');
select is(jsonb_array_length(pg_temp.history(:'ada', null, null, 0) -> 'battles'), 1,
  'p_limit is clamped: 0 → 1');
select is(jsonb_array_length(pg_temp.history(:'ada', null, null, null) -> 'battles'), 5,
  'p_limit null → the default (20)');

-- ─── Callers (3) ──────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', :'bob'), true);
select is(jsonb_array_length(public.get_player_history(:'ada') -> 'battles'), 5,
  'a signed-in user (anyone) reads the same history');
reset role;
select ok(
  has_function_privilege('anon', 'public.get_player_history(uuid, timestamptz, uuid, integer)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_player_history(uuid, timestamptz, uuid, integer)', 'EXECUTE'),
  'anon and authenticated can execute get_player_history');
select is(
  (select provolatile::text from pg_proc where proname = 'get_player_history'),
  's', 'get_player_history is read-only (STABLE)');

select * from finish();
rollback;
