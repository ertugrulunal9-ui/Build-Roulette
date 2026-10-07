-- The solo battle lifecycle, end to end, through the RPCs:
--   spinning → building → shipping → results → destroyed
-- Time is simulated: inside one transaction now() is constant, so the tests
-- move the stored deadlines into the past (as the superuser) instead.
--
-- Cast:
--   alice  ships by hand early (speedrun) → capture → destroy
--   bob    autosave only → auto_shipped at the deadline; capture deadline hit
--   cleo   nothing uploaded → dnf
--   eve    ships in the last 10 s (clutch)
--   finn   ships during the grace period, after the deadline (clutch, capped)

begin;
create extension if not exists pgtap with schema extensions;

select plan(88);

\set alice '{"sub":"5a000000-0000-0000-0000-0000000000a1","role":"authenticated"}'
\set bob   '{"sub":"5a000000-0000-0000-0000-0000000000b2","role":"authenticated"}'
\set cleo  '{"sub":"5a000000-0000-0000-0000-0000000000c3","role":"authenticated"}'
\set eve   '{"sub":"5a000000-0000-0000-0000-0000000000e5","role":"authenticated"}'
\set finn  '{"sub":"5a000000-0000-0000-0000-0000000000f6","role":"authenticated"}'
\set service '{"role":"service_role"}'

insert into auth.users (id, is_anonymous) values
  ('5a000000-0000-0000-0000-0000000000a1', true),
  ('5a000000-0000-0000-0000-0000000000b2', true),
  ('5a000000-0000-0000-0000-0000000000c3', true),
  ('5a000000-0000-0000-0000-0000000000e5', true),
  ('5a000000-0000-0000-0000-0000000000f6', true);
-- alice already has a profile; start_solo_battle must update it.
insert into public.profiles (id, display_name) values ('5a000000-0000-0000-0000-0000000000a1', 'old name');

-- ═══ alice: start ═════════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select public.start_solo_battle('  alice  ', 300) as a_battle \gset
reset role;

select isnt(:'a_battle'::uuid, null::uuid, 'start_solo_battle returns a battle id');

select results_eq(
  format($$ select phase::text, version, room_id, host_id, is_complete, finished_at
            from public.battles where id = %L $$, :'a_battle'),
  $$ values ('spinning', 1, null::uuid, '5a000000-0000-0000-0000-0000000000a1'::uuid, false, null::timestamptz) $$,
  'the battle is SPINNING at version 1, solo (no room), hosted by the caller');

select is((select phase_ends_at - phase_started_at from public.battles where id = :'a_battle'),
  interval '6 seconds', 'SPINNING lasts 6 s');
select is((select phase_started_at from public.battles where id = :'a_battle'), now(),
  'phase_started_at is the server time');
select is((select settings from public.battles where id = :'a_battle'),
  '{"mode": "solo", "spinning_s": 6, "shipping_s": 15, "voting_s": 60, "results_s": 60, "capture_deadline_s": 600}'::jsonb,
  'settings snapshot: mode solo plus the default durations');

select ok(
  (select c.time_limit_seconds = 300
          and c.build_card_id is not null and c.rule_card_id is not null and c.style_card_id is not null
          and c.build_text <> '' and c.rule_text <> '' and c.style_text <> ''
   from public.battles b join public.challenges c on c.id = b.challenge_id
   where b.id = :'a_battle'),
  'a challenge with three cards and the requested time limit is attached');

select results_eq(
  format($$ select user_id, display_name from public.battle_players where battle_id = %L $$, :'a_battle'),
  $$ values ('5a000000-0000-0000-0000-0000000000a1'::uuid, 'alice') $$,
  'the roster is the caller, with the trimmed display name');
select results_eq(
  format($$ select status::text, name, shipped_at from public.builds where battle_id = %L $$, :'a_battle'),
  $$ values ('draft', null::text, null::timestamptz) $$,
  'one draft build');
select is((select display_name from public.profiles where id = '5a000000-0000-0000-0000-0000000000a1'),
  'alice', 'the profile display name is upserted');
select results_eq(
  format($$ select version, type, actor_id, payload ->> 'to' from public.battle_events
            where battle_id = %L order by id $$, :'a_battle'),
  $$ values (1, 'phase', '5a000000-0000-0000-0000-0000000000a1'::uuid, 'spinning') $$,
  'the start is logged in battle_events');

-- ═══ alice: SPINNING → BUILDING ═══════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select is(public.advance_battle(:'a_battle', 1) - 'phase_ends_at',
  '{"changed": false, "version": 1, "phase": "spinning"}'::jsonb,
  'advance before the deadline is a no-op');
reset role;

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'a_battle';

set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select is(public.advance_battle(:'a_battle', 0) - 'phase_ends_at',
  '{"changed": false, "version": 1, "phase": "spinning"}'::jsonb,
  'advance with a stale version is a no-op, even when due');
select is(public.advance_battle(:'a_battle', 1),
  jsonb_build_object('changed', true, 'version', 2, 'phase', 'building',
                     'phase_ends_at', now() + interval '300 seconds'),
  'advance after the deadline: BUILDING, version 2, ends in 300 s');
select is(public.advance_battle(:'a_battle', 2) ->> 'changed', 'false',
  'a second nudge is a no-op');
select is(public.advance_battle(:'a_battle', 1) ->> 'changed', 'false',
  'a nudge with the old version is a no-op');
reset role;

select results_eq(
  format($$ select phase::text, version, building_started_at, building_ends_at, phase_ends_at, phase_started_at
            from public.battles where id = %L $$, :'a_battle'),
  $$ select 'building', 2, now(), now() + interval '300 seconds', now() + interval '300 seconds', now() $$,
  'BUILDING stamps building_started_at/ends_at and phase_ends_at');
select results_eq(
  format($$ select version, payload ->> 'from', payload ->> 'to', actor_id from public.battle_events
            where battle_id = %L and version = 2 $$, :'a_battle'),
  $$ values (2, 'spinning', 'building', '5a000000-0000-0000-0000-0000000000a1'::uuid) $$,
  'the transition is logged with the nudging actor');

-- ═══ alice: ship ══════════════════════════════════════════════════════════
-- 100 s into a 300 s build.
update public.battles
   set building_started_at = now() - interval '100 seconds',
       building_ends_at    = now() + interval '200 seconds',
       phase_ends_at       = now() + interval '200 seconds'
 where id = :'a_battle';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'a_battle' || '/5a000000-0000-0000-0000-0000000000a1/source.json'),
  ('ephemeral-builds', :'a_battle' || '/5a000000-0000-0000-0000-0000000000a1/bundle.js');

set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select public.ship_build(:'a_battle', '  Snack Overflow  ',
  '{"files": 3, "lines": 120, "deps": ["react", "react", "canvas-confetti"], "bundle_bytes": 99999999,
    "rebuilds": 7, "pastes": 2, "secret": "dropped"}') as a_ship \gset
reset role;

select is((:'a_ship'::jsonb) -> 'build' ->> 'status', 'shipped', 'ship_build returns the shipped build');
select is((:'a_ship'::jsonb) -> 'battle',
  jsonb_build_object('version', 5, 'phase', 'results', 'phase_ends_at', now() + interval '60 seconds'),
  'everyone shipped: BUILDING → SHIPPING → RESULTS at once (version 5)');

select results_eq(
  format($$ select status::text, name, shipped_at, completion_ms, final_rank from public.builds
            where battle_id = %L $$, :'a_battle'),
  $$ select 'shipped', 'Snack Overflow', now(), 100000, 1 $$,
  'the build is shipped with the trimmed name, shipped_at = now(), completion 100 s, rank 1');
select is((select stats from public.builds where battle_id = :'a_battle'),
  '{"files": 3, "lines": 120, "deps": ["react", "canvas-confetti"], "bundle_bytes": 5242880, "rebuilds": 7, "pastes": 2}'::jsonb,
  'stats are cleaned: unknown keys dropped, deps deduplicated, bundle_bytes capped');

select results_eq(
  format($$ select phase::text, phase_started_at, phase_ends_at, shipping_ended_at, finished_at, is_complete
            from public.battles where id = %L $$, :'a_battle'),
  $$ select 'results', now(), now() + interval '60 seconds', now(), now(), true $$,
  'RESULTS: last look of 60 s, shipping_ended_at and finished_at stamped, complete');

select results_eq(
  format($$ select version, type, payload ->> 'from', payload ->> 'to', (payload ->> 'early')::boolean
            from public.battle_events where battle_id = %L and version > 2 order by id $$, :'a_battle'),
  $$ values (3, 'ship', null, null, null::boolean),
            (4, 'phase', 'building', 'shipping', true),
            (5, 'phase', 'shipping', 'results', null) $$,
  'events: ship, then the early transitions');

select results_eq(
  format($$ select kind::text, status::text, attempts from public.jobs
            where ref_id in (select id from public.builds where battle_id = %L) $$, :'a_battle'),
  $$ values ('capture', 'queued', 0) $$,
  'a capture job is queued for the shipped build');

select results_eq(
  format($$ select award, source from public.awards where battle_id = %L order by award $$, :'a_battle'),
  $$ values ('speedrun', 'auto') $$,
  'auto-awards: speedrun (used ≤ half the time), no clutch, no fastest_ship in solo');

set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select throws_ok(format($$ select public.ship_build(%L, 'again', '{}') $$, :'a_battle'),
  'P0001', 'already_shipped', 'a second ship is refused (ship is final)');
select is(public.advance_battle(:'a_battle', 5) ->> 'changed', 'false',
  'RESULTS is not over before the last-look window');

-- Snapshot as the player.
select public.get_battle_snapshot(:'a_battle') as a_snap \gset
reset role;

select is((:'a_snap'::jsonb) -> 'battle' ->> 'phase', 'results', 'snapshot: phase');
select is(((:'a_snap'::jsonb) -> 'battle' ->> 'version')::int, 5, 'snapshot: version');
select is((:'a_snap'::jsonb) -> 'battle' ->> 'mode', 'solo', 'snapshot: mode');
select ok(
  (:'a_snap'::jsonb) -> 'challenge' ->> 'id' = (select challenge_id::text from public.battles where id = :'a_battle')
  and (:'a_snap'::jsonb) -> 'challenge' -> 'build' ? 'text'
  and (:'a_snap'::jsonb) -> 'challenge' -> 'rule' ? 'hint'
  and ((:'a_snap'::jsonb) -> 'challenge' ->> 'time_limit_seconds')::int = 300,
  'snapshot: challenge with texts, hints and time limit');
select is((:'a_snap'::jsonb) -> 'players',
  '[{"user_id": "5a000000-0000-0000-0000-0000000000a1", "display_name": "alice"}]'::jsonb,
  'snapshot: players');
select is(jsonb_array_length((:'a_snap'::jsonb) -> 'builds'), 1, 'snapshot: one build');
select is((:'a_snap'::jsonb) -> 'builds' -> 0 ->> 'name', 'Snack Overflow', 'snapshot: build name');
select is((:'a_snap'::jsonb) -> 'awards' -> 0 ->> 'award', 'speedrun', 'snapshot: awards');
select is((:'a_snap'::jsonb) -> 'me',
  '{"user_id": "5a000000-0000-0000-0000-0000000000a1", "is_player": true}'::jsonb,
  'snapshot: me');
select ok(
  not ((:'a_snap'::jsonb) ? 'votes')
  and (:'a_snap'::jsonb)::text not like '%source.json%'
  and (:'a_snap'::jsonb)::text not like '%bundle.js%'
  and (:'a_snap'::jsonb)::text not like '%ephemeral%',
  'snapshot: no votes, no ephemeral storage paths');

-- ═══ alice: RESULTS → DESTROYED ═══════════════════════════════════════════
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'a_battle';

set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select is(public.advance_battle(:'a_battle', 5) ->> 'changed', 'false',
  'after the last look, RESULTS still waits for the pending capture');
reset role;

select id as a_build from public.builds where battle_id = :'a_battle' \gset

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select lives_ok(
  format($$ select public.complete_capture(%L, 'captured', %L) $$,
         :'a_build', :'a_battle' || '/' || :'a_build' || '.webp'),
  'the capture worker reports the screenshot');
reset role;

select results_eq(
  format($$ select capture_status::text, screenshot_path, captured_at from public.builds where id = %L $$, :'a_build'),
  format($$ select 'captured', %L, now() $$, :'a_battle' || '/' || :'a_build' || '.webp'),
  'the build is captured with its screenshot path');
select results_eq(
  format($$ select phase::text, version, phase_ends_at from public.battles where id = %L $$, :'a_battle'),
  $$ values ('destroyed', 7, null::timestamptz) $$,
  'the last terminal capture moves the overdue RESULTS to DESTROYED (capture event + phase event)');
select results_eq(
  format($$ select kind::text, status::text from public.jobs
            where ref_id in (%L, %L) order by kind $$, :'a_battle', :'a_build'),
  $$ values ('capture', 'done'), ('destroy', 'queued') $$,
  'the capture job is done and the destroy job is queued');
select is((select destroyed_at from public.battles where id = :'a_battle'), null,
  'destroyed_at waits for the destroy-worker');

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select lives_ok(format($$ select public.complete_destroy(%L) $$, :'a_battle'),
  'the destroy-worker reports completion');
select lives_ok(format($$ select public.complete_destroy(%L) $$, :'a_battle'),
  'complete_destroy is idempotent');
select is(public.advance_battle(:'a_battle', 8) ->> 'changed', 'false',
  'DESTROYED is terminal');
reset role;

select results_eq(
  format($$ select destroyed_at, version from public.battles where id = %L $$, :'a_battle'),
  $$ select now(), 8 $$,
  'destroyed_at is stamped once (version 8)');
select is((select source_destroyed_at from public.builds where id = :'a_build'), now(),
  'builds.source_destroyed_at is stamped');
select is((select status::text from public.jobs where kind = 'destroy' and ref_id = :'a_battle'), 'done',
  'the destroy job is done');

-- A rematch is allowed now that the first battle is over.
set local role authenticated;
select set_config('request.jwt.claims', :'alice', true);
select lives_ok($$ select public.start_solo_battle('alice', 180) $$, 'a new solo battle can start after RESULTS');
reset role;

-- ═══ bob: autosave → auto_shipped ═════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'bob', true);
select public.start_solo_battle('bob', null) as b_battle \gset
reset role;

select ok((select c.time_limit_seconds in (300, 600, 900)
           from public.battles b join public.challenges c on c.id = b.challenge_id
           where b.id = :'b_battle'),
  'no time limit given: the server picks 5, 10 or 15 minutes');
select c.time_limit_seconds as b_limit
from public.battles b join public.challenges c on c.id = b.challenge_id where b.id = :'b_battle' \gset

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'bob', true);
select is(public.advance_battle(:'b_battle', 1) ->> 'phase', 'building', 'bob is BUILDING');
reset role;

insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'b_battle' || '/5a000000-0000-0000-0000-0000000000b2/autosave/source.json'),
  ('ephemeral-builds', :'b_battle' || '/5a000000-0000-0000-0000-0000000000b2/autosave/bundle.js');
-- The build deadline passed 20 s ago (beyond the 15 s grace) and nobody nudged.
update public.battles
   set building_started_at = now() - make_interval(secs => :b_limit + 20),
       building_ends_at    = now() - interval '20 seconds',
       phase_ends_at       = now() - interval '20 seconds'
 where id = :'b_battle';

set local role authenticated;
select set_config('request.jwt.claims', :'bob', true);
select is(public.advance_battle(:'b_battle', 2),
  jsonb_build_object('changed', true, 'version', 3, 'phase', 'shipping',
                     'phase_ends_at', now() + interval '15 seconds'),
  'deadline with a draft left: SHIPPING with the 15 s grace (one step only)');
select throws_ok(format($$ select public.ship_build(%L, 'late', '{}') $$, :'b_battle'),
  'P0001', 'deadline_passed', 'shipping after building_ends_at + grace is refused');
reset role;

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'bob', true);
select is(public.advance_battle(:'b_battle', 3) ->> 'phase', 'results', 'grace over: RESULTS');
reset role;

select results_eq(
  format($$ select status::text, name, shipped_at, completion_ms, final_rank from public.builds
            where battle_id = %L $$, :'b_battle'),
  format($$ select 'auto_shipped', null::text, now() - interval '20 seconds', %s * 1000, 1 $$, :b_limit),
  'the autosave is auto-shipped with shipped_at = building_ends_at and the full time limit');
select is((select count(*)::int from public.jobs j join public.builds bu on bu.id = j.ref_id
           where bu.battle_id = :'b_battle' and j.kind = 'capture' and j.status = 'queued'), 1,
  'a capture job is queued for the auto-shipped build');
select is_empty(format($$ select award from public.awards where battle_id = %L $$, :'b_battle'),
  'an auto-shipped build earns no auto-award');

-- Capture never reports; the 10-minute capture deadline passes.
update public.battles
   set phase_ends_at     = now() - interval '1 second',
       shipping_ended_at = now() - interval '11 minutes'
 where id = :'b_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'bob', true);
select is(public.advance_battle(:'b_battle', 4) ->> 'phase', 'destroyed',
  'capture deadline passed: RESULTS → DESTROYED without the screenshot');
reset role;
select is((select capture_status::text from public.builds where battle_id = :'b_battle'), 'failed',
  'the pending capture is marked failed');
select results_eq(
  format($$ select j.status::text, j.last_error from public.jobs j join public.builds bu on bu.id = j.ref_id
            where bu.battle_id = %L and j.kind = 'capture' $$, :'b_battle'),
  $$ values ('failed', 'capture deadline passed') $$,
  'the capture job is failed');
select is((select payload ->> 'capture_deadline' from public.battle_events
           where battle_id = :'b_battle' order by id desc limit 1), 'true',
  'the event records that the capture deadline was hit');
select is((select status::text from public.jobs where kind = 'destroy' and ref_id = :'b_battle'), 'queued',
  'the destroy job is queued');

-- ═══ cleo: nothing uploaded → dnf ═════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'cleo', true);
select public.start_solo_battle('cleo', 180) as c_battle \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'c_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'cleo', true);
select is(public.advance_battle(:'c_battle', 1) ->> 'phase', 'building', 'cleo is BUILDING');
reset role;

-- An autosave with only one of the two files does not count.
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'c_battle' || '/5a000000-0000-0000-0000-0000000000c3/autosave/bundle.js');
update public.battles
   set building_started_at = now() - interval '200 seconds',
       building_ends_at    = now() - interval '20 seconds',
       phase_ends_at       = now() - interval '20 seconds'
 where id = :'c_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'cleo', true);
select is(public.advance_battle(:'c_battle', 2) ->> 'phase', 'shipping', 'cleo: SHIPPING');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'c_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'cleo', true);
select is(public.advance_battle(:'c_battle', 3) ->> 'phase', 'results', 'cleo: RESULTS');
reset role;

select results_eq(
  format($$ select status::text, shipped_at, completion_ms, final_rank, capture_status::text
            from public.builds where battle_id = %L $$, :'c_battle'),
  $$ values ('dnf', null::timestamptz, null::int, null::int, 'pending') $$,
  'no complete autosave: dnf, no rank');
select is_empty(
  format($$ select j.id from public.jobs j join public.builds bu on bu.id = j.ref_id
            where bu.battle_id = %L $$, :'c_battle'),
  'no capture job for a dnf build');
select is((select is_complete from public.battles where id = :'c_battle'), true,
  'a battle where everyone DNFed is still complete');

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'c_battle';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.advance_battle(:'c_battle', 4) ->> 'phase', 'destroyed',
  'no captures to wait for: DESTROYED right after the last look (service role nudge)');
reset role;
select results_eq(
  format($$ select actor_id, payload ->> 'to' from public.battle_events
            where battle_id = %L order by id desc limit 1 $$, :'c_battle'),
  $$ values (null::uuid, 'destroyed') $$,
  'a service-role nudge is logged without an actor');

-- ═══ eve: clutch ship in the last 10 s ════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select public.start_solo_battle('eve', 300) as e_battle \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'e_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select is(public.advance_battle(:'e_battle', 1) ->> 'phase', 'building', 'eve is BUILDING');
reset role;
update public.battles
   set building_started_at = now() - interval '295 seconds',
       building_ends_at    = now() + interval '5 seconds',
       phase_ends_at       = now() + interval '5 seconds'
 where id = :'e_battle';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'e_battle' || '/5a000000-0000-0000-0000-0000000000e5/source.json'),
  ('ephemeral-builds', :'e_battle' || '/5a000000-0000-0000-0000-0000000000e5/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select is(public.ship_build(:'e_battle', 'Just in time', null) -> 'battle' ->> 'phase', 'results',
  'eve ships 5 s before the deadline (null stats are fine)');
reset role;
select results_eq(
  format($$ select completion_ms, stats from public.builds where battle_id = %L $$, :'e_battle'),
  $$ values (295000, '{}'::jsonb) $$,
  'completion 295 s, empty stats');
select results_eq(
  format($$ select award from public.awards where battle_id = %L order by award $$, :'e_battle'),
  $$ values ('clutch_ship') $$,
  'auto-award: clutch_ship');

-- ═══ finn: ship inside the grace period ═══════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'finn', true);
select public.start_solo_battle('finn', 600) as f_battle \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'f_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'finn', true);
select is(public.advance_battle(:'f_battle', 1) ->> 'phase', 'building', 'finn is BUILDING');
reset role;
-- The deadline passed 5 s ago; no one has nudged yet (phase still BUILDING).
update public.battles
   set building_started_at = now() - interval '605 seconds',
       building_ends_at    = now() - interval '5 seconds',
       phase_ends_at       = now() - interval '5 seconds'
 where id = :'f_battle';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'f_battle' || '/5a000000-0000-0000-0000-0000000000f6/source.json'),
  ('ephemeral-builds', :'f_battle' || '/5a000000-0000-0000-0000-0000000000f6/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'finn', true);
select is(public.ship_build(:'f_battle', 'Photo finish', '{}') -> 'battle' ->> 'phase', 'results',
  'a ship 5 s after the deadline is accepted (grace) and ends the battle');
reset role;
select results_eq(
  format($$ select shipped_at, completion_ms from public.builds where battle_id = %L $$, :'f_battle'),
  $$ select now(), 600000 $$,
  'shipped_at is the real time; completion_ms is capped at the time limit');
select results_eq(
  format($$ select award from public.awards where battle_id = %L order by award $$, :'f_battle'),
  $$ values ('clutch_ship') $$,
  'a grace-period ship is a clutch ship');
select results_eq(
  format($$ select payload ->> 'from', payload ->> 'to', (payload ->> 'early')::boolean
            from public.battle_events where battle_id = %L and type = 'phase' and version > 2 order by id $$,
         :'f_battle'),
  $$ values ('building', 'shipping', false), ('shipping', 'results', null::boolean) $$,
  'overdue and all shipped: not "early", but still no grace');

-- ═══ Visibility of other people's battles ═════════════════════════════════
-- eve is a stranger to finn's battle. It is in RESULTS now, so it is public.
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select is(public.get_battle_snapshot(:'f_battle') -> 'me' ->> 'is_player', 'false',
  'a stranger can read a battle in RESULTS (public results page)');
select throws_ok(format($$ select public.advance_battle(%L, 1) $$, :'f_battle'),
  'P0002', 'battle_not_found', 'a stranger cannot nudge someone else''s battle');
select is(public.get_battle_snapshot(:'a_battle') ->> 'battle' is not null, true,
  'a stranger can read a DESTROYED battle (public results page)');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'cleo', true);
select public.start_solo_battle('cleo', 300) as c2_battle \gset
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select throws_ok(format($$ select public.get_battle_snapshot(%L) $$, :'c2_battle'),
  'P0002', 'battle_not_found', 'a stranger cannot read a running battle');
reset role;

-- ═══ The multiplayer branches run without a room or players (M4) ═════════
-- Until M4 they raised not_implemented. Battles whose settings are not solo
-- and do not say reveal_vote = false take the reveal/vote path:
--   shipping, no final build  → RESULTS (fewer than 2 final builds)
--   reveal, empty order       → VOTING (the last slot is over)
--   voting, nobody to vote    → RESULTS at the deadline
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds) values
  ('5c000000-0000-0000-0000-000000000001', 'b', 'r', 's', 300),
  ('5c000000-0000-0000-0000-000000000002', 'b', 'r', 's', 300),
  ('5c000000-0000-0000-0000-000000000003', 'b', 'r', 's', 300);
insert into public.battles (id, challenge_id, host_id, phase, settings, phase_ends_at,
                            building_started_at, building_ends_at) values
  ('5b000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-000000000001',
   '5a000000-0000-0000-0000-0000000000a1', 'shipping', '{}', now() - interval '1 second',
   now() - interval '400 seconds', now() - interval '100 seconds'),
  ('5b000000-0000-0000-0000-000000000002', '5c000000-0000-0000-0000-000000000002',
   '5a000000-0000-0000-0000-0000000000a1', 'reveal', '{}', now() - interval '1 second', null, null),
  ('5b000000-0000-0000-0000-000000000003', '5c000000-0000-0000-0000-000000000003',
   '5a000000-0000-0000-0000-0000000000a1', 'voting', '{"mode":"room"}', now() - interval '1 second', null, null);

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.advance_battle('5b000000-0000-0000-0000-000000000001', 0) ->> 'phase', 'results',
  'non-solo SHIPPING with no final build → RESULTS (no REVEAL or VOTING)');
select is(public.advance_battle('5b000000-0000-0000-0000-000000000002', 0) ->> 'phase', 'voting',
  'REVEAL whose last slot is over → VOTING');
select is(public.advance_battle('5b000000-0000-0000-0000-000000000003', 0) ->> 'phase', 'results',
  'VOTING at its deadline → RESULTS');
reset role;
select is((select payload ->> 'reason' from public.battle_events
           where battle_id = '5b000000-0000-0000-0000-000000000001' and type = 'phase'),
  'too_few_builds', 'the skipped reveal is logged with its reason');

select * from finish();
rollback;
