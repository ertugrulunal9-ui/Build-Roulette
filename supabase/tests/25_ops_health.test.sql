-- T-030: admin_ops_health, the operations signals behind /admin "Health" and the runbooks.
-- Who may call it (admins only), and the counts on fixtures. The database may hold other
-- committed data (the e2e scripts commit theirs), so every count is checked as the
-- difference between a call before and a call after the fixtures (one transaction, so
-- now() is the same in both).
--
-- Fixtures (inserted as the superuser):
--   S1  building, deadline passed 100 days ago        → overdue, stuck (the oldest)
--   S2  building, deadline passed 10 s ago             → within the 30 s grace
--   R1  results, last look over, screenshot pending,   → overdue, waiting for captures
--       capture deadline not reached
--   R2  results, screenshot pending, capture deadline  → overdue, stuck
--       passed
--   D1  destroyed 10 min ago, files not deleted yet     → destroy pending
--   T1  abandoned, created 30 h ago, not destroyed     → past the TTL (+ an old object)
--   X1  destroyed and deleted, but an object is left   → object of a destroyed battle
--   jobs: capture queued (ready), running with an expired lease, failed now, failed 3 h
--   ago, done 61 min ago; destroy done 5 min ago
--   cron: a probe job that never fires, with three runs (failed 2 h ago, ok 10 min ago,
--   failed 5 min ago)

begin;
create extension if not exists pgtap with schema extensions;

select plan(43);

\set mod_id  '25a00000-0000-0000-0000-000000000006'
\set dee_id  '25a00000-0000-0000-0000-000000000005'
\set ana_id  '25a00000-0000-0000-0000-000000000001'
\set mod  '{"sub":"25a00000-0000-0000-0000-000000000006","role":"authenticated","is_anonymous":false}'
\set dee  '{"sub":"25a00000-0000-0000-0000-000000000005","role":"authenticated","is_anonymous":false}'
\set ana  '{"sub":"25a00000-0000-0000-0000-000000000001","role":"authenticated","is_anonymous":true}'

\set S1 '25b00000-0000-0000-0000-000000000001'
\set S2 '25b00000-0000-0000-0000-000000000002'
\set R1 '25b00000-0000-0000-0000-000000000003'
\set R2 '25b00000-0000-0000-0000-000000000004'
\set D1 '25b00000-0000-0000-0000-000000000005'
\set T1 '25b00000-0000-0000-0000-000000000006'
\set X1 '25b00000-0000-0000-0000-000000000007'
\set r1 '25d00000-0000-0000-0000-000000000001'
\set r2 '25d00000-0000-0000-0000-000000000002'
\set f1 '25d00000-0000-0000-0000-000000000003'
\set f2 '25d00000-0000-0000-0000-000000000004'
\set c5 '25d00000-0000-0000-0000-000000000005'

insert into auth.users (id, is_anonymous, email) values
  (:'mod_id', false, 'mod-health@example.test'), (:'dee_id', false, 'dee-health@example.test'),
  (:'ana_id', true, null);
insert into private.admins (user_id, note) values (:'mod_id', 'health test');
insert into public.profiles (id, display_name) values (:'ana_id', 'Ana');
-- One challenge per battle (battles.challenge_id is unique).
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('25e00000-0000-0000-0000-00000000000' || n)::uuid, 'Build', 'Rule', 'Style', 300
from generate_series(1, 7) n;

-- ═══ Who may call it ══════════════════════════════════════════════════════
set local role anon;
select throws_ok($$ select public.admin_ops_health() $$, '42501', null,
  'anon (no session) cannot call it');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.admin_ops_health() $$, '42501', null,
  'service_role (the workers) cannot call it');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok($$ select public.admin_ops_health() $$, '42501', 'not_admin',
  'an anonymous player gets not_admin');
select set_config('request.jwt.claims', :'dee', true);
select throws_ok($$ select public.admin_ops_health() $$, '42501', 'not_admin',
  'a signed-up user who is not an admin gets not_admin');
select set_config('request.jwt.claims', :'mod', true);
select lives_ok($$ select public.admin_ops_health() $$, 'an admin can call it');
select public.admin_ops_health() as h0 \gset
reset role;

select ok((:'h0'::jsonb) ?& array['generated_at', 'battles', 'jobs', 'captures_last_day', 'cron', 'ttl'],
  'the answer has every section');
select is(jsonb_array_length((:'h0'::jsonb) -> 'jobs'), 3, 'one jobs entry per kind (capture, destroy, takedown)');

-- ═══ Fixtures ═════════════════════════════════════════════════════════════
insert into public.battles (id, challenge_id, host_id, settings, phase, phase_started_at, phase_ends_at,
                            shipping_ended_at, finished_at, destroyed_at, is_complete, created_at)
values
  (:'S1', '25e00000-0000-0000-0000-000000000001', :'ana_id', '{"mode":"solo"}', 'building',
   now() - interval '100 days 5 minutes', now() - interval '100 days', null, null, null, false, now()),
  (:'S2', '25e00000-0000-0000-0000-000000000002', :'ana_id', '{"mode":"solo"}', 'building',
   now() - interval '5 minutes', now() - interval '10 seconds', null, null, null, false, now()),
  (:'R1', '25e00000-0000-0000-0000-000000000003', :'ana_id', '{"mode":"solo"}', 'results',
   now() - interval '3 minutes', now() - interval '2 minutes', now() - interval '3 minutes',
   now() - interval '3 minutes', null, true, now()),
  (:'R2', '25e00000-0000-0000-0000-000000000004', :'ana_id', '{"mode":"solo"}', 'results',
   now() - interval '20 minutes', now() - interval '15 minutes', now() - interval '20 minutes',
   now() - interval '20 minutes', null, true, now()),
  (:'D1', '25e00000-0000-0000-0000-000000000005', :'ana_id', '{"mode":"solo"}', 'destroyed',
   now() - interval '10 minutes', null, now() - interval '12 minutes', now() - interval '12 minutes',
   null, true, now()),
  (:'T1', '25e00000-0000-0000-0000-000000000006', :'ana_id', '{"mode":"solo"}', 'abandoned',
   now(), null, null, null, null, false, now() - interval '30 hours'),
  (:'X1', '25e00000-0000-0000-0000-000000000007', :'ana_id', '{"mode":"solo"}', 'destroyed',
   now() - interval '2 hours', null, now() - interval '3 hours', now() - interval '3 hours',
   now() - interval '1 hour', true, now());
insert into public.battle_players (battle_id, user_id, display_name)
select b, :'ana_id', 'Ana' from unnest(array[:'S1', :'S2', :'R1', :'R2', :'D1', :'T1', :'X1']::uuid[]) b;
insert into public.builds (id, battle_id, builder_id, name, status, capture_status) values
  (:'r1', :'R1', :'ana_id', 'One', 'shipped', 'pending'),
  (:'r2', :'R2', :'ana_id', 'Two', 'shipped', 'pending'),
  (:'f1', :'D1', :'ana_id', 'Three', 'shipped', 'failed'),
  (:'c5', :'X1', :'ana_id', 'Five', 'shipped', 'captured');
insert into public.builds (id, battle_id, builder_id, name, status, capture_status) values
  (:'f2', :'T1', :'ana_id', 'Four', 'auto_shipped', 'failed');
insert into public.jobs (kind, ref_id, status, attempts, run_after, last_error, created_at, updated_at) values
  ('capture', :'r1', 'queued', 0, now() - interval '1 minute', null,
   now() - interval '5 minutes', now() - interval '5 minutes'),
  ('capture', :'r2', 'running', 2, now() - interval '10 seconds', 'render timeout',
   now() - interval '6 minutes', now() - interval '130 seconds'),
  ('capture', :'f1', 'failed', 5, now(), 'blank render; no client thumbnail',
   now() - interval '20 minutes', now()),
  ('capture', :'f2', 'failed', 5, now(), 'old failure',
   now() - interval '4 hours', now() - interval '3 hours'),
  ('capture', :'c5', 'done', 1, now(), null,
   now() - interval '62 minutes', now() - interval '61 minutes'),
  ('destroy', :'X1', 'done', 1, now(), null,
   now() - interval '6 minutes', now() - interval '5 minutes');
insert into storage.objects (bucket_id, name, created_at) values
  ('ephemeral-builds', :'T1' || '/' || :'ana_id' || '/bundle.js', now() - interval '30 hours'),
  ('ephemeral-builds', :'X1' || '/' || :'ana_id' || '/bundle.js', now() - interval '3 hours');
-- A cron job that never fires (31 February), with three runs.
select cron.schedule('zz-health-probe', '0 0 31 2 *', 'select 1') as probe \gset
-- runid is given (the API roles cannot use cron's sequence), far ahead of the scheduler's.
select coalesce(max(runid), 0) + 1000000 as runid from cron.job_run_details \gset
insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status,
                                  return_message, start_time, end_time) values
  (:probe, :runid + 1, 0, 'postgres', 'postgres', 'select 1', 'failed', 'ERROR:  old failure',
   now() - interval '2 hours', now() - interval '2 hours'),
  (:probe, :runid + 2, 0, 'postgres', 'postgres', 'select 1', 'succeeded', '1 row',
   now() - interval '10 minutes', now() - interval '10 minutes'),
  (:probe, :runid + 3, 0, 'postgres', 'postgres', 'select 1', 'failed', 'ERROR:  boom',
   now() - interval '5 minutes', now() - interval '5 minutes' + interval '250 milliseconds');

set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_ops_health() as h1 \gset
select public.admin_ops_health(0) as hz \gset
reset role;

-- Helpers over the two answers.
create function pg_temp.overdue(h jsonb, p text, k text) returns int language sql as $$
  select coalesce((select (e ->> k)::int from jsonb_array_elements(h -> 'battles' -> 'overdue') e
                   where e ->> 'phase' = p), 0) $$;
create function pg_temp.job(h jsonb, kind text, k text) returns int language sql as $$
  select coalesce((select (e ->> k)::int from jsonb_array_elements(h -> 'jobs') e
                   where e ->> 'kind' = kind), 0) $$;
create function pg_temp.jobj(h jsonb, kind text) returns jsonb language sql as $$
  select e from jsonb_array_elements(h -> 'jobs') e where e ->> 'kind' = kind $$;
create function pg_temp.cronj(h jsonb, name text) returns jsonb language sql as $$
  select e from jsonb_array_elements(h -> 'cron' -> 'jobs') e where e ->> 'name' = name $$;
create function pg_temp.delta(a jsonb, b jsonb, variadic path text[]) returns int language sql as $$
  select coalesce((b #>> path)::int, 0) - coalesce((a #>> path)::int, 0) $$;

-- ═══ Battles ══════════════════════════════════════════════════════════════
select is(pg_temp.overdue(:'h1', 'building', 'count') - pg_temp.overdue(:'h0', 'building', 'count'), 1,
  'building: one more overdue battle (S2 is within the grace)');
select is(pg_temp.overdue(:'h1', 'building', 'stuck') - pg_temp.overdue(:'h0', 'building', 'stuck'), 1,
  'building: it is stuck');
select is((select e ->> 'oldest_battle_id' from jsonb_array_elements((:'h1'::jsonb) -> 'battles' -> 'overdue') e
           where e ->> 'phase' = 'building'), :'S1', 'building: the oldest overdue battle is S1');
select cmp_ok(pg_temp.overdue(:'h1', 'building', 'oldest_overdue_s'), '>=', 100 * 86400,
  'building: overdue by 100 days');
select is(pg_temp.overdue(:'hz', 'building', 'count') - pg_temp.overdue(:'h0', 'building', 'count'), 2,
  'with grace 0, S2 counts too');
select is(pg_temp.overdue(:'h1', 'results', 'count') - pg_temp.overdue(:'h0', 'results', 'count'), 2,
  'results: two overdue (R1, R2)');
select is(pg_temp.overdue(:'h1', 'results', 'waiting_for_captures')
          - pg_temp.overdue(:'h0', 'results', 'waiting_for_captures'), 1,
  'results: R1 is waiting for its screenshot (capture deadline not reached)');
select is(pg_temp.overdue(:'h1', 'results', 'stuck') - pg_temp.overdue(:'h0', 'results', 'stuck'), 1,
  'results: R2 is stuck (capture deadline passed)');
select is(pg_temp.delta(:'h0', :'h1', 'battles', 'stuck_total'), 2, 'stuck_total: S1 and R2');
select is(pg_temp.delta(:'h0', :'h1', 'battles', 'overdue_total'), 3, 'overdue_total: S1, R1, R2');
select is(pg_temp.delta(:'h0', :'h1', 'battles', 'running', 'building'), 2, 'running: two more in building');
select is(pg_temp.delta(:'h0', :'h1', 'battles', 'destroy_pending', 'count'), 1,
  'destroy pending: D1 (destroyed 10 min ago, files not deleted)');

-- ═══ Jobs ═════════════════════════════════════════════════════════════════
select is(pg_temp.job(:'h1', 'capture', 'queued') - pg_temp.job(:'h0', 'capture', 'queued'), 1, 'capture: queued +1');
select is(pg_temp.job(:'h1', 'capture', 'running') - pg_temp.job(:'h0', 'capture', 'running'), 1, 'capture: running +1');
select is(pg_temp.job(:'h1', 'capture', 'ready') - pg_temp.job(:'h0', 'capture', 'ready'), 2,
  'capture: ready to claim +2 (the queued one and the expired lease)');
select is(pg_temp.job(:'h1', 'capture', 'lease_expired') - pg_temp.job(:'h0', 'capture', 'lease_expired'), 1,
  'capture: one running job with an expired lease');
select is(pg_temp.job(:'h1', 'capture', 'failed_last_hour') - pg_temp.job(:'h0', 'capture', 'failed_last_hour'), 1,
  'capture: failed in the last hour +1 (not the one from 3 h ago)');
select is(pg_temp.job(:'h1', 'capture', 'failed_last_day') - pg_temp.job(:'h0', 'capture', 'failed_last_day'), 2,
  'capture: failed in the last 24 h +2');
select is(pg_temp.job(:'h1', 'capture', 'done_last_hour') - pg_temp.job(:'h0', 'capture', 'done_last_hour'), 0,
  'capture: the job done 61 min ago is not in the last hour');
select is(pg_temp.jobj(:'h1', 'capture') -> 'last_failure' ->> 'ref_id', :'f1',
  'capture: the latest failure is f1');
select is(pg_temp.jobj(:'h1', 'capture') -> 'last_failure' ->> 'error', 'blank render; no client thumbnail',
  'capture: with its error');
select cmp_ok(pg_temp.job(:'h1', 'capture', 'oldest_pending_s'), '>=', 360,
  'capture: the oldest pending job is at least 6 min old');
select is(pg_temp.job(:'h1', 'destroy', 'done_last_hour') - pg_temp.job(:'h0', 'destroy', 'done_last_hour'), 1,
  'destroy: done in the last hour +1');
select is(pg_temp.job(:'h1', 'takedown', 'queued') - pg_temp.job(:'h0', 'takedown', 'queued'), 0,
  'takedown: nothing new');

-- ═══ Captures of the last 24 h ════════════════════════════════════════════
select is(pg_temp.delta(:'h0', :'h1', 'captures_last_day', 'failed'), 2, 'captures: failed +2 (f1, f2)');
select is(pg_temp.delta(:'h0', :'h1', 'captures_last_day', 'captured'), 1, 'captures: captured +1 (c5)');
select is(pg_temp.delta(:'h0', :'h1', 'captures_last_day', 'fallback'), 0, 'captures: no fallback');

-- ═══ pg_cron ══════════════════════════════════════════════════════════════
select is((:'h1'::jsonb) -> 'cron' ->> 'available', 'true', 'cron: cron.job_run_details is readable');
select ok(pg_temp.cronj(:'h1', 'br-sweep-deadlines') is not null, 'cron: the deadline sweep is listed');
select is(pg_temp.cronj(:'h1', 'zz-health-probe') ->> 'runs_last_hour', '2', 'cron: probe ran twice in the last hour');
select is(pg_temp.cronj(:'h1', 'zz-health-probe') ->> 'failed_last_hour', '1', 'cron: and failed once');
select is(pg_temp.cronj(:'h1', 'zz-health-probe') -> 'last_run' ->> 'status', 'failed', 'cron: the last run failed');
select is(pg_temp.cronj(:'h1', 'zz-health-probe') -> 'last_failure' ->> 'message', 'ERROR:  boom',
  'cron: with the latest failure message');

-- ═══ TTL leftovers ════════════════════════════════════════════════════════
select is(pg_temp.delta(:'h0', :'h1', 'ttl', 'battles_past_ttl'), 1, 'ttl: T1 is past the 24 h TTL');
select is(pg_temp.delta(:'h0', :'h1', 'ttl', 'ephemeral_objects_past_ttl'), 1, 'ttl: one object older than 24 h');
select is(pg_temp.delta(:'h0', :'h1', 'ttl', 'ephemeral_objects_of_destroyed'), 1,
  'ttl: one object of a battle already destroyed (X1)');

select * from finish();
rollback;
