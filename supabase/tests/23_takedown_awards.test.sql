-- T-028: a build taken down AFTER RESULTS keeps its rank but loses all its awards (vote
-- awards and auto-awards) on every public read: get_public_battle, get_player_history,
-- get_battle_snapshot, and the awards table itself through RLS. Nothing is re-ranked or
-- reassigned, the other builds keep their own awards, the vote counts stay, and the stored
-- awards rows are untouched. (Takedowns in a RUNNING battle: 22_takedown.test.sql.)
--
-- Battle W (room battle with voting, 4 players), results computed by the real
-- private.finalize_votes from fixture builds and ballots:
--   A (Ana) shipped by hand at t0-180 s, 2:00 of 5:00 → speedrun, fastest_ship
--   B (Ben) shipped by hand at t0-5 s,   4:55         → clutch_ship
--   C (Cy)  shipped by hand at t0-100 s, 3:20         → –
--   D (Dee) DNF
-- Ballots: overall Ben, Cy, Dee → A, Ana → C;  rule Ben, Cy → A, Ana → B;
--          style Ana, Ben → C, Dee → B;          chaos Ana, Cy → B.
--   Tallies A 5 (overall 3, rule 2), B 4, C 3. Ranks A 1, C 2, B 3.
--   Awards: overall A, rule A, style C, chaos B (vote); speedrun A, fastest_ship A,
--   clutch_ship B (auto). So the rank-1 build A holds 4 of the 7 awards, Best Build included.
-- Then a moderator takes A down in RESULTS (and the battle later reaches DESTROYED).
--
-- Battle S (solo): Ana's speedrun build is taken down in RESULTS: her own results screen
-- (get_battle_snapshot) and the public page drop the award too.

begin;
create extension if not exists pgtap with schema extensions;

select plan(24);

\set ana '{"sub":"23a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"23a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set eli '{"sub":"23a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set mod '{"sub":"23a00000-0000-0000-0000-000000000006","role":"authenticated","is_anonymous":false}'
\set ana_id '23a00000-0000-0000-0000-000000000001'
\set ben_id '23a00000-0000-0000-0000-000000000002'
\set cy_id  '23a00000-0000-0000-0000-000000000003'
\set dee_id '23a00000-0000-0000-0000-000000000004'
\set mod_id '23a00000-0000-0000-0000-000000000006'
\set w  '23b00000-0000-0000-0000-000000000001'
\set s  '23b00000-0000-0000-0000-000000000002'
\set a  '23d00000-0000-0000-0000-000000000001'
\set b  '23d00000-0000-0000-0000-000000000002'
\set c  '23d00000-0000-0000-0000-000000000003'
\set d  '23d00000-0000-0000-0000-000000000004'
\set sa '23d00000-0000-0000-0000-000000000005'
\set t0 '2026-10-08 12:00:00+00'

insert into auth.users (id, is_anonymous)
select ('23a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 5) n;
insert into auth.users (id, is_anonymous, email) values (:'mod_id', false, 'mod23@example.test');
insert into private.admins (user_id) values (:'mod_id');
insert into public.profiles (id, display_name) values
  (:'ana_id', 'Ana'), (:'ben_id', 'Ben'), (:'cy_id', 'Cy'), (:'dee_id', 'Dee');

insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds) values
  ('23c00000-0000-0000-0000-000000000001', 'A quiz', 'No buttons', 'Retro', 300),
  ('23c00000-0000-0000-0000-000000000002', 'A clock', 'One file', 'Neon', 300);

-- ─── Battle W: VOTING, then the real finalize_votes ──────────────────────
insert into public.battles (id, challenge_id, host_id, settings, phase, building_started_at, building_ends_at)
values (:'w', '23c00000-0000-0000-0000-000000000001', :'ana_id',
        '{"mode":"multiplayer","reveal_vote":true}', 'voting',
        :'t0'::timestamptz - interval '300 seconds', :'t0');
insert into public.battle_players (battle_id, user_id, display_name)
select :'w', p.id, p.display_name from public.profiles p
where p.id in (:'ana_id', :'ben_id', :'cy_id', :'dee_id');
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms) values
  (:'a', :'w', :'ana_id', 'Quiz Quest', 'shipped', :'t0'::timestamptz - interval '180 seconds', 120000),
  (:'b', :'w', :'ben_id', 'Buzz',       'shipped', :'t0'::timestamptz - interval '5 seconds',   295000),
  (:'c', :'w', :'cy_id',  'Cy Quiz',    'shipped', :'t0'::timestamptz - interval '100 seconds', 200000),
  (:'d', :'w', :'dee_id', null,         'dnf',     null,                                         null);
update public.battles set reveal_order = array[:'a', :'b', :'c']::uuid[] where id = :'w';
insert into public.votes (battle_id, voter_id, category, build_id) values
  (:'w', :'ben_id', 'overall', :'a'), (:'w', :'cy_id', 'overall', :'a'),
  (:'w', :'dee_id', 'overall', :'a'), (:'w', :'ana_id', 'overall', :'c'),
  (:'w', :'ben_id', 'rule', :'a'),    (:'w', :'cy_id', 'rule', :'a'),
  (:'w', :'ana_id', 'rule', :'b'),
  (:'w', :'ana_id', 'style', :'c'),   (:'w', :'ben_id', 'style', :'c'),
  (:'w', :'dee_id', 'style', :'b'),
  (:'w', :'ana_id', 'chaos', :'b'),   (:'w', :'cy_id', 'chaos', :'b');
select private.finalize_votes(:'w');
update public.battles set phase = 'results', finished_at = :'t0'::timestamptz + interval '2 minutes',
                          is_complete = true
 where id = :'w';

select results_eq(
  format($$ select id, final_rank, total_votes from public.builds where battle_id = %L order by id $$, :'w'),
  format($$ values (%L::uuid, 1, 5), (%L::uuid, 3, 4), (%L::uuid, 2, 3), (%L::uuid, null::int, 0) $$,
         :'a', :'b', :'c', :'d'),
  'fixture: ranks A 1, C 2, B 3 (D DNF)');
select results_eq(
  format($$ select award, build_id, source from public.awards where battle_id = %L order by award $$, :'w'),
  format($$ values ('chaos', %L::uuid, 'vote'), ('clutch_ship', %L::uuid, 'auto'),
                   ('fastest_ship', %L::uuid, 'auto'), ('overall', %L::uuid, 'vote'),
                   ('rule', %L::uuid, 'vote'), ('speedrun', %L::uuid, 'auto'),
                   ('style', %L::uuid, 'vote') $$,
         :'b', :'b', :'a', :'a', :'a', :'a', :'c'),
  'fixture: the rank-1 build A holds Best Build, the rule award, speedrun and fastest_ship');

-- What was stored and shown before the takedown.
create temp table w_awards_before as
  select id, battle_id, build_id, award, source, votes, created_at from public.awards where battle_id = :'w';
create temp table w_builds_before as
  select id, status, final_rank, total_votes, vote_counts from public.builds where battle_id = :'w';
set local role anon;
select is(jsonb_array_length(public.get_public_battle(:'w') -> 'awards'), 7,
  'before the takedown the public page lists all 7 awards');
reset role;

-- ═══ A (rank 1) is taken down in RESULTS ══════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is(public.admin_take_down_build(:'a', 'offensive') -> 'disqualified', 'false'::jsonb,
  'a takedown in RESULTS does not disqualify');
reset role;

-- ─── Stored data: untouched ───────────────────────────────────────────────
select results_eq(
  format($$ select id, battle_id, build_id, award, source, votes, created_at from public.awards
            where battle_id = %L order by id $$, :'w'),
  $$ select id, battle_id, build_id, award, source, votes, created_at from w_awards_before order by id $$,
  'the awards rows are untouched (permanent data, auditability)');
select results_eq(
  format($$ select id, status, final_rank, total_votes, vote_counts from public.builds
            where battle_id = %L order by id $$, :'w'),
  $$ select id, status, final_rank, total_votes, vote_counts from w_builds_before order by id $$,
  'nothing is re-ranked: status, ranks and tallies of every build are unchanged');

-- ─── get_public_battle (anon) ─────────────────────────────────────────────
set local role anon;
select public.get_public_battle(:'w') as pub \gset
select public.get_player_history(:'ana_id') as hist_ana \gset
select public.get_player_history(:'ben_id') as hist_ben \gset
select public.get_player_history(:'cy_id') as hist_cy \gset
reset role;
-- What every read must return from now on: B's and C's awards, exactly as stored.
select jsonb_build_array(
    jsonb_build_object('build_id', :'b', 'award', 'chaos', 'source', 'vote', 'votes', 2),
    jsonb_build_object('build_id', :'b', 'award', 'clutch_ship', 'source', 'auto', 'votes', null),
    jsonb_build_object('build_id', :'c', 'award', 'style', 'source', 'vote', 'votes', 2)) as kept \gset
select is((:'pub'::jsonb) -> 'awards', :'kept'::jsonb,
  'get_public_battle: none of A''s awards; B and C keep theirs exactly as stored');
select is((select count(*)::int from jsonb_array_elements((:'pub'::jsonb) -> 'awards') x
           where x ->> 'award' in ('overall', 'rule', 'speedrun', 'fastest_ship')), 0,
  'nobody inherits A''s awards: no Best Build, no rule award, no speedrun, no fastest ship');
select is(((:'pub'::jsonb) -> 'builds' -> 0) - 'shipped_at' - 'stats' - 'capture_status' - 'builder_name',
  jsonb_build_object('id', :'a', 'name', null, 'status', 'shipped', 'completion_ms', 120000,
                     'final_rank', 1, 'total_votes', 5,
                     'votes', '{"overall": 3, "rule": 2, "style": 0, "chaos": 0}'::jsonb,
                     'screenshot_path', null, 'taken_down', true),
  'get_public_battle: A is still listed first with rank 1, its time and its vote counts');
select is((select jsonb_agg(jsonb_build_array(x ->> 'id', (x ->> 'final_rank')::int) order by n)
           from jsonb_array_elements((:'pub'::jsonb) -> 'builds') with ordinality e(x, n)),
  jsonb_build_array(jsonb_build_array(:'a', 1), jsonb_build_array(:'c', 2), jsonb_build_array(:'b', 3),
                    jsonb_build_array(:'d', null)),
  'get_public_battle: the order is unchanged (A, C, B, then the DNF)');

-- ─── get_player_history (anon) ────────────────────────────────────────────
select is((select jsonb_build_object('awards', x -> 'awards', 'rank', x -> 'build' -> 'final_rank',
                                     'down', x -> 'build' -> 'taken_down',
                                     'total', x -> 'build' -> 'total_votes', 'of', x -> 'players_count')
           from jsonb_array_elements((:'hist_ana'::jsonb) -> 'battles') x where x ->> 'battle_id' = :'w'),
  '{"awards": [], "rank": 1, "down": true, "total": 5, "of": 4}'::jsonb,
  'get_player_history (Ana): rank 1 of 4 and her vote total stay, no awards');
select is((select x -> 'awards' from jsonb_array_elements((:'hist_ben'::jsonb) -> 'battles') x
           where x ->> 'battle_id' = :'w'),
  '[{"award": "chaos", "source": "vote", "votes": 2}, {"award": "clutch_ship", "source": "auto", "votes": null}]'::jsonb,
  'get_player_history (Ben): his awards are unchanged');
select is((select x -> 'awards' from jsonb_array_elements((:'hist_cy'::jsonb) -> 'battles') x
           where x ->> 'battle_id' = :'w'),
  '[{"award": "style", "source": "vote", "votes": 2}]'::jsonb,
  'get_player_history (Cy, now the best-ranked visible build): only his own award, no Best Build');

-- ─── get_battle_snapshot (players and a signed-in visitor) ────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.get_battle_snapshot(:'w') as snap_ben \gset
select set_config('request.jwt.claims', :'ana', true);
select public.get_battle_snapshot(:'w') as snap_ana \gset
select set_config('request.jwt.claims', :'eli', true);
select public.get_battle_snapshot(:'w') as snap_eli \gset
reset role;
select is((:'snap_ben'::jsonb) -> 'awards', :'kept'::jsonb,
  'get_battle_snapshot (Ben, still in the room): the same three awards');
select is((:'snap_ana'::jsonb) -> 'awards', :'kept'::jsonb,
  'get_battle_snapshot (Ana, whose build was removed): she does not see hers either');
select is((:'snap_eli'::jsonb) -> 'awards', :'kept'::jsonb,
  'get_battle_snapshot (a signed-in visitor): the same');
select is((select jsonb_build_object('rank', x -> 'final_rank', 'down', x -> 'taken_down',
                                     'total', x -> 'total_votes', 'overall', x -> 'votes' -> 'overall')
           from jsonb_array_elements((:'snap_ben'::jsonb) -> 'builds') x where x ->> 'id' = :'a'),
  '{"rank": 1, "down": true, "total": 5, "overall": 3}'::jsonb,
  'get_battle_snapshot: A keeps rank 1 and its vote counts');

-- ─── The awards table through RLS ─────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select results_eq(
  format($$ select award, build_id from public.awards where battle_id = %L order by award $$, :'w'),
  format($$ values ('chaos', %L::uuid), ('clutch_ship', %L::uuid), ('style', %L::uuid) $$, :'b', :'b', :'c'),
  'RLS: a direct read of public.awards hides A''s rows too');
select set_config('request.jwt.claims', :'ana', true);
select is((select count(*)::int from public.awards where build_id = :'a'), 0,
  'RLS: the builder of A cannot read them either');
reset role;
select is((select count(*)::int from public.awards where build_id = :'a'), 4,
  'the rows are still there for the superuser / SECURITY DEFINER code (admins, audits)');

-- ─── DESTROYED: still hidden ──────────────────────────────────────────────
update public.battles set phase = 'destroyed', destroyed_at = now() where id = :'w';
set local role anon;
select is(public.get_public_battle(:'w') -> 'awards', :'kept'::jsonb,
  'after DESTROY the public page still shows only B''s and C''s awards');
reset role;

-- ═══ Battle S (solo): a speedrun build taken down in RESULTS ══════════════
insert into public.battles (id, challenge_id, host_id, settings, phase, building_started_at, building_ends_at,
                            finished_at, is_complete)
values (:'s', '23c00000-0000-0000-0000-000000000002', :'ana_id', '{"mode":"solo"}', 'results',
        :'t0'::timestamptz - interval '300 seconds', :'t0', :'t0', true);
insert into public.battle_players (battle_id, user_id, display_name) values (:'s', :'ana_id', 'Ana');
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms, final_rank)
values (:'sa', :'s', :'ana_id', 'Tick Tock', 'shipped', :'t0'::timestamptz - interval '240 seconds', 60000, 1);
insert into public.awards (battle_id, build_id, award, source) values (:'s', :'sa', 'speedrun', 'auto');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(jsonb_array_length(public.get_battle_snapshot(:'s') -> 'awards'), 1,
  'solo: before the takedown Ana''s results show her speedrun');
select set_config('request.jwt.claims', :'mod', true);
select public.admin_take_down_build(:'sa');
select set_config('request.jwt.claims', :'ana', true);
select is(public.get_battle_snapshot(:'s') -> 'awards', '[]'::jsonb,
  'solo: after it, her results screen shows no award');
reset role;
set local role anon;
select is(jsonb_build_object('awards', public.get_public_battle(:'s') -> 'awards',
                             'rank', public.get_public_battle(:'s') -> 'builds' -> 0 -> 'final_rank'),
  '{"awards": [], "rank": 1}'::jsonb, 'solo: the public page keeps the rank, without the award');
reset role;

select * from finish();
rollback;
