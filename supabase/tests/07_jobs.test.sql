-- The job queue API for the capture and destroy workers (service_role):
-- claim_job, fail_job (backoff), complete_capture, complete_destroy, and the
-- lease. Fixtures are inserted directly: three solo battles in RESULTS.
--   b1 / build u1  shipped, capture job queued
--   b2 / build u2  shipped, capture job queued
--   b3 / build u3  dnf

begin;
create extension if not exists pgtap with schema extensions;

select plan(49);

\set service '{"role":"service_role"}'

insert into auth.users (id, is_anonymous) values
  ('7a000000-0000-0000-0000-000000000001', true),
  ('7a000000-0000-0000-0000-000000000002', true),
  ('7a000000-0000-0000-0000-000000000003', true);
insert into public.profiles (id, display_name) values
  ('7a000000-0000-0000-0000-000000000001', 'ivan'),
  ('7a000000-0000-0000-0000-000000000002', 'jade'),
  ('7a000000-0000-0000-0000-000000000003', 'kim');
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('7c000000-0000-0000-0000-00000000000' || n)::uuid, 'b', 'r', 's', 300
from generate_series(1, 3) n;
insert into public.battles (id, challenge_id, host_id, phase, version, settings, phase_ends_at,
                            building_started_at, building_ends_at, shipping_ended_at, finished_at, is_complete)
select ('7b000000-0000-0000-0000-00000000000' || n)::uuid, ('7c000000-0000-0000-0000-00000000000' || n)::uuid,
       ('7a000000-0000-0000-0000-00000000000' || n)::uuid, 'results', 5, '{"mode":"solo"}',
       now() + interval '60 seconds', now() - interval '300 seconds', now(), now(), now(), true
from generate_series(1, 3) n;
insert into public.battle_players (battle_id, user_id, display_name)
select ('7b000000-0000-0000-0000-00000000000' || n)::uuid, ('7a000000-0000-0000-0000-00000000000' || n)::uuid, 'p'
from generate_series(1, 3) n;
insert into public.builds (id, battle_id, builder_id, status, shipped_at, completion_ms) values
  ('7d000000-0000-0000-0000-000000000001', '7b000000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', 'shipped', now(), 1000),
  ('7d000000-0000-0000-0000-000000000002', '7b000000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000002', 'shipped', now(), 1000),
  ('7d000000-0000-0000-0000-000000000003', '7b000000-0000-0000-0000-000000000003', '7a000000-0000-0000-0000-000000000003', 'dnf', null, null);
insert into public.jobs (kind, ref_id, run_after) values
  ('capture', '7d000000-0000-0000-0000-000000000001', now() - interval '2 seconds'),
  ('capture', '7d000000-0000-0000-0000-000000000002', now() - interval '1 second');
select id as j1 from public.jobs where ref_id = '7d000000-0000-0000-0000-000000000001' \gset
select id as j2 from public.jobs where ref_id = '7d000000-0000-0000-0000-000000000002' \gset

set local role service_role;
select set_config('request.jwt.claims', :'service', true);

-- ─── claim_job (8) ────────────────────────────────────────────────────────
select is((select id from public.claim_job('destroy')), null, 'nothing to claim: all fields null');

select results_eq(
  $$ select kind::text, ref_id, status::text, attempts, run_after from public.claim_job('capture') $$,
  $$ values ('capture', '7d000000-0000-0000-0000-000000000001'::uuid, 'running', 1, now() + interval '2 minutes') $$,
  'claim: the oldest ready job, running, attempts 1, leased for 2 minutes');
select is((select ref_id from public.claim_job('capture')), '7d000000-0000-0000-0000-000000000002'::uuid,
  'claim: then the next one');
select is((select id from public.claim_job('capture')), null, 'claim: leased jobs are not handed out again');

-- The lease of j1 expires (the worker died): j1 is claimable again.
reset role;
update public.jobs set run_after = now() - interval '1 second' where id = :j1;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select results_eq(
  $$ select ref_id, status::text, attempts from public.claim_job('capture') $$,
  $$ values ('7d000000-0000-0000-0000-000000000001'::uuid, 'running', 2) $$,
  'an expired lease makes a running job claimable again (attempts 2)');

-- Destroy jobs come back in run_after order; future ones wait.
reset role;
insert into public.jobs (kind, ref_id, run_after) values
  ('destroy', '7e000000-0000-0000-0000-000000000001', now() - interval '10 seconds'),
  ('destroy', '7e000000-0000-0000-0000-000000000002', now() - interval '20 seconds'),
  ('destroy', '7e000000-0000-0000-0000-000000000003', now() + interval '10 seconds');
insert into public.jobs (kind, ref_id, attempts) values
  ('destroy', '7e000000-0000-0000-0000-000000000004', 5);
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((select ref_id from public.claim_job('destroy')), '7e000000-0000-0000-0000-000000000002'::uuid,
  'claim order: earliest run_after first');
select is((select ref_id from public.claim_job('destroy')), '7e000000-0000-0000-0000-000000000001'::uuid,
  'claim order: then the next');
select is((select id from public.claim_job('destroy')), null,
  'a job scheduled in the future, or out of attempts, is not claimed');

-- ─── fail_job: backoff (12) ───────────────────────────────────────────────
-- j1 is running with attempts 2.
select results_eq(
  format($$ select status::text, attempts, run_after, last_error from public.fail_job(%s, 'boom') $$, :j1),
  $$ values ('queued', 2, now() + interval '20 seconds', 'boom') $$,
  'fail after attempt 2: queued again in 20 s');
select is((select id from public.claim_job('capture')), null, 'the backoff delays the next claim');

reset role;
update public.jobs set run_after = now() - interval '1 second' where id = :j1;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((select attempts from public.claim_job('capture')), 3, 'attempt 3');
select is((select run_after from public.fail_job(:j1, 'boom')), now() + interval '40 seconds',
  'fail after attempt 3: 40 s');
reset role;
update public.jobs set run_after = now() - interval '1 second' where id = :j1;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((select attempts from public.claim_job('capture')), 4, 'attempt 4');
select is((select run_after from public.fail_job(:j1, repeat('x', 5000))), now() + interval '80 seconds',
  'fail after attempt 4: 80 s');
select is((select char_length(last_error) from public.jobs where id = :j1), 2000,
  'last_error is truncated to 2000 characters');
reset role;
update public.jobs set run_after = now() - interval '1 second' where id = :j1;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((select attempts from public.claim_job('capture')), 5, 'attempt 5');
select results_eq(
  format($$ select status::text, attempts, last_error from public.fail_job(%s, 'gave up') $$, :j1),
  $$ values ('failed', 5, 'gave up') $$,
  'fail after attempt 5: failed for good');
select is((select capture_status::text from public.builds where id = '7d000000-0000-0000-0000-000000000001'),
  'failed', 'the build''s capture is marked failed');
select results_eq(
  $$ select version, type, payload ->> 'capture_status' from public.battle_events
     where battle_id = '7b000000-0000-0000-0000-000000000001' $$,
  $$ values (6, 'capture', 'failed') $$,
  'the failure bumps the battle version and is logged');

-- First failure: 10 s (j2 is running with attempts 1).
select is((select run_after from public.fail_job(:j2, 'first')), now() + interval '10 seconds',
  'fail after attempt 1: 10 s');

-- ─── fail_job guards (2) ──────────────────────────────────────────────────
select throws_ok(format($$ select public.fail_job(%s, 'again') $$, :j1), 'P0001', 'job_not_running',
  'a failed job cannot fail again');
select throws_ok($$ select public.fail_job(-1, 'x') $$, 'P0002', 'job_not_found', 'unknown job');

-- ─── complete_capture guards (7) ──────────────────────────────────────────
select throws_ok($$ select public.complete_capture(gen_random_uuid(), 'captured', 'x.webp') $$,
  'P0002', 'build_not_found', 'unknown build');
select throws_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000002', 'pending', null) $$,
  '22023', 'invalid_capture_status', 'pending is not a result');
select throws_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000002', 'captured', null) $$,
  '22023', 'invalid_path', 'captured needs a path');
select throws_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000002', 'captured',
       '7b000000-0000-0000-0000-000000000001/7d000000-0000-0000-0000-000000000001.webp') $$,
  '22023', 'invalid_path', 'the path must name this build in this battle');
select throws_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000002', 'captured',
       'screenshots/7b000000-0000-0000-0000-000000000002/7d000000-0000-0000-0000-000000000002.webp') $$,
  '22023', 'invalid_path', 'the path is the object name, without the bucket');
select throws_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000002', 'failed',
       '7b000000-0000-0000-0000-000000000002/7d000000-0000-0000-0000-000000000002.webp') $$,
  '22023', 'invalid_path', 'failed has no path');
select throws_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000003', 'failed', null) $$,
  'P0001', 'not_capturable', 'a dnf build has nothing to capture');

-- ─── complete_capture (9) ─────────────────────────────────────────────────
select lives_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000002', 'fallback',
       '7b000000-0000-0000-0000-000000000002/7d000000-0000-0000-0000-000000000002.png') $$,
  'fallback (client thumbnail) with a .png path');
select results_eq(
  $$ select capture_status::text, screenshot_path, captured_at from public.builds
     where id = '7d000000-0000-0000-0000-000000000002' $$,
  $$ values ('fallback', '7b000000-0000-0000-0000-000000000002/7d000000-0000-0000-0000-000000000002.png', now()) $$,
  'the fallback is recorded');
select is((select status::text from public.jobs where id = :j2), 'done', 'the capture job is done');
select results_eq(
  $$ select phase::text, version from public.battles where id = '7b000000-0000-0000-0000-000000000002' $$,
  $$ values ('results', 6) $$,
  'version bumped; RESULTS stays until its last-look deadline');

-- A late success replaces a failure (j1's build failed above).
select lives_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000001', 'captured',
       '7b000000-0000-0000-0000-000000000001/7d000000-0000-0000-0000-000000000001.webp') $$,
  'a late capture after a failure is accepted');
select results_eq(
  $$ select capture_status::text, screenshot_path from public.builds where id = '7d000000-0000-0000-0000-000000000001' $$,
  $$ values ('captured', '7b000000-0000-0000-0000-000000000001/7d000000-0000-0000-0000-000000000001.webp') $$,
  'the build is captured');
select is((select status::text from public.jobs where id = :j1), 'done', 'the failed job is now done');

-- A captured build keeps its screenshot.
select lives_ok(
  $$ select public.complete_capture('7d000000-0000-0000-0000-000000000001', 'failed', null) $$,
  'a late failure report is accepted');
select results_eq(
  $$ select capture_status::text, screenshot_path from public.builds where id = '7d000000-0000-0000-0000-000000000001' $$,
  $$ values ('captured', '7b000000-0000-0000-0000-000000000001/7d000000-0000-0000-0000-000000000001.webp') $$,
  '...but does not overwrite the screenshot');

-- ─── complete_destroy (7) ─────────────────────────────────────────────────
select throws_ok($$ select public.complete_destroy(gen_random_uuid()) $$, 'P0002', 'battle_not_found',
  'unknown battle');
select throws_ok($$ select public.complete_destroy('7b000000-0000-0000-0000-000000000003') $$,
  'P0001', 'wrong_phase', 'a battle in RESULTS cannot be destroyed');

reset role;
update public.battles set phase = 'abandoned', phase_ends_at = null
 where id = '7b000000-0000-0000-0000-000000000003';
insert into public.jobs (kind, ref_id, status, attempts)
values ('destroy', '7b000000-0000-0000-0000-000000000003', 'running', 1);
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select lives_ok($$ select public.complete_destroy('7b000000-0000-0000-0000-000000000003') $$,
  'an ABANDONED battle can be destroyed');
reset role;
select results_eq(
  $$ select destroyed_at, version from public.battles where id = '7b000000-0000-0000-0000-000000000003' $$,
  $$ select now(), 6 $$,
  'destroyed_at is stamped and the version bumped');
select is((select source_destroyed_at from public.builds where id = '7d000000-0000-0000-0000-000000000003'),
  now(), 'source_destroyed_at is stamped');
select is((select status::text from public.jobs where kind = 'destroy' and ref_id = '7b000000-0000-0000-0000-000000000003'),
  'done', 'the destroy job is done');
select is((select count(*)::int from public.battle_events
           where battle_id = '7b000000-0000-0000-0000-000000000003' and type = 'destroyed'), 1,
  'one destroyed event');

-- ─── Lease sweep (3) ──────────────────────────────────────────────────────
-- A job on its last attempt whose lease expired (the worker died).
update public.builds set capture_status = 'pending' where id = '7d000000-0000-0000-0000-000000000002';
update public.jobs set status = 'running', attempts = 5, run_after = now() - interval '1 second'
 where id = :j2;
select lives_ok($$ select public.sweep_deadlines() $$, 'sweep_deadlines runs');
select results_eq(
  format($$ select status::text, last_error from public.jobs where id = %s $$, :j2),
  $$ values ('failed', 'lease expired after the last attempt') $$,
  'the expired last attempt is failed by the sweep');
select is((select capture_status::text from public.builds where id = '7d000000-0000-0000-0000-000000000002'),
  'failed', 'and its build''s capture is failed');

-- ─── Not for clients (1) ──────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select ok(
  not has_function_privilege('public.complete_capture(uuid, public.capture_status, text)', 'EXECUTE')
  and not has_function_privilege('public.fail_job(bigint, text)', 'EXECUTE')
  and not has_function_privilege('public.complete_destroy(uuid)', 'EXECUTE')
  and not has_function_privilege('public.claim_job(public.job_kind)', 'EXECUTE'),
  'a signed-in client cannot call the worker functions');
reset role;

select * from finish();
rollback;
