-- sweep_deadlines (the pg_cron backstop), sweep_ttl (24 h hard TTL) and the
-- pg_cron schedule.

begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

-- ─── pg_cron (2) ──────────────────────────────────────────────────────────
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pg_cron'), 'pg_catalog',
  'pg_cron is installed (in pg_catalog, as on Supabase)');
select results_eq(
  $$ select jobname::text collate "default", schedule::text collate "default", command::text collate "default", active
     from cron.job where jobname like 'br-%' order by jobname $$,
  $$ values ('br-cron-history-cleanup', '17 3 * * *',
             'delete from cron.job_run_details where end_time < now() - interval ''2 days''', true),
            ('br-sweep-deadlines', '5 seconds', 'select public.sweep_deadlines()', true),
            ('br-sweep-ttl', '*/10 * * * *', 'select public.sweep_ttl()', true) $$,
  'the sweeps are scheduled: deadlines every 5 s, TTL every 10 min, history cleanup daily');

-- ─── Fixtures ─────────────────────────────────────────────────────────────
-- s1  solo, SPINNING, overdue                    → BUILDING
-- s2  solo, SPINNING, not due                    → unchanged
-- s3  multiplayer SHIPPING, overdue              → not_implemented, skipped with a warning
-- s4  solo, BUILDING, overdue, draft, no files   → SHIPPING (then dnf on a later sweep)
-- t1  solo, BUILDING, created 25 h ago           → ABANDONED (TTL)
-- t2  solo, RESULTS, created 25 h ago            → DESTROYED (TTL), pending capture failed
-- t3  solo, DESTROYED 25 h ago, destroy job failed → destroy job re-queued
-- t4  solo, BUILDING, created 23 h ago           → untouched by the TTL
insert into auth.users (id, is_anonymous) values ('9a000000-0000-0000-0000-000000000001', true);
insert into public.profiles (id, display_name) values ('9a000000-0000-0000-0000-000000000001', 'nia');
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('9c000000-0000-0000-0000-0000000000' || k)::uuid, 'b', 'r', 's', 300
from unnest(array['01', '02', '03', '04', '11', '12', '13', '14']) k;

insert into public.battles (id, challenge_id, host_id, phase, version, settings, phase_ends_at,
                            building_started_at, building_ends_at, shipping_ended_at, created_at) values
  ('9b000000-0000-0000-0000-000000000001', '9c000000-0000-0000-0000-000000000001', '9a000000-0000-0000-0000-000000000001',
   'spinning', 1, '{"mode":"solo"}', now() - interval '1 second', null, null, null, now()),
  ('9b000000-0000-0000-0000-000000000002', '9c000000-0000-0000-0000-000000000002', '9a000000-0000-0000-0000-000000000001',
   'spinning', 1, '{"mode":"solo"}', now() + interval '3 seconds', null, null, null, now()),
  ('9b000000-0000-0000-0000-000000000003', '9c000000-0000-0000-0000-000000000003', '9a000000-0000-0000-0000-000000000001',
   'shipping', 3, '{}', now() - interval '30 seconds', now() - interval '400 seconds', now() - interval '100 seconds', null, now()),
  ('9b000000-0000-0000-0000-000000000004', '9c000000-0000-0000-0000-000000000004', '9a000000-0000-0000-0000-000000000001',
   'building', 2, '{"mode":"solo"}', now() - interval '2 seconds', now() - interval '302 seconds', now() - interval '2 seconds', null, now()),
  ('9b000000-0000-0000-0000-000000000011', '9c000000-0000-0000-0000-000000000011', '9a000000-0000-0000-0000-000000000001',
   'building', 2, '{"mode":"solo"}', now() + interval '1 hour', now() - interval '25 hours', now() + interval '1 hour', null,
   now() - interval '25 hours'),
  ('9b000000-0000-0000-0000-000000000012', '9c000000-0000-0000-0000-000000000012', '9a000000-0000-0000-0000-000000000001',
   'results', 5, '{"mode":"solo"}', now() + interval '1 hour', now() - interval '25 hours', now() - interval '25 hours',
   now() - interval '25 hours', now() - interval '25 hours'),
  ('9b000000-0000-0000-0000-000000000013', '9c000000-0000-0000-0000-000000000013', '9a000000-0000-0000-0000-000000000001',
   'destroyed', 6, '{"mode":"solo"}', null, null, null, null, now() - interval '25 hours'),
  ('9b000000-0000-0000-0000-000000000014', '9c000000-0000-0000-0000-000000000014', '9a000000-0000-0000-0000-000000000001',
   'building', 2, '{"mode":"solo"}', now() + interval '1 hour', now() - interval '23 hours', now() + interval '1 hour', null,
   now() - interval '23 hours');
insert into public.battle_players (battle_id, user_id, display_name)
select id, '9a000000-0000-0000-0000-000000000001', 'nia' from public.battles
where id::text like '9b000000-%';
insert into public.builds (battle_id, builder_id, status)
select id, '9a000000-0000-0000-0000-000000000001',
       case when phase = 'results' then 'shipped'::public.build_status else 'draft' end
from public.battles where id::text like '9b000000-%';
insert into public.jobs (kind, ref_id, status, attempts, last_error)
values ('destroy', '9b000000-0000-0000-0000-000000000013', 'failed', 5, 'storage down');

-- ─── sweep_deadlines (6) ──────────────────────────────────────────────────
select is(public.sweep_deadlines(), 2, 'the sweep advances the two overdue solo battles');
select is((select phase::text from public.battles where id = '9b000000-0000-0000-0000-000000000001'), 'building',
  'overdue SPINNING → BUILDING');
select is((select phase::text from public.battles where id = '9b000000-0000-0000-0000-000000000002'), 'spinning',
  'a battle that is not due is left alone');
select results_eq(
  $$ select phase::text, version from public.battles where id = '9b000000-0000-0000-0000-000000000003' $$,
  $$ values ('shipping', 3) $$,
  'a battle that raises (multiplayer, M3) is skipped and unchanged; the sweep does not fail');
select results_eq(
  $$ select phase::text, phase_ends_at from public.battles where id = '9b000000-0000-0000-0000-000000000004' $$,
  $$ values ('shipping', now() + interval '15 seconds') $$,
  'overdue BUILDING with a draft → SHIPPING with the grace');
select is((select actor_id from public.battle_events
           where battle_id = '9b000000-0000-0000-0000-000000000001' order by id desc limit 1), null,
  'sweep transitions are logged without an actor');

-- ─── sweep_ttl (9) ────────────────────────────────────────────────────────
select is(public.sweep_ttl(), 3, 'the TTL sweep handles the three battles older than 24 h');
select results_eq(
  $$ select phase::text, is_complete, phase_ends_at from public.battles where id = '9b000000-0000-0000-0000-000000000011' $$,
  $$ values ('abandoned', false, null::timestamptz) $$,
  'a battle stuck in BUILDING for 24 h is ABANDONED (incomplete)');
select results_eq(
  $$ select phase::text, is_complete from public.battles where id = '9b000000-0000-0000-0000-000000000012' $$,
  $$ values ('destroyed', true) $$,
  'a battle stuck in RESULTS is DESTROYED and keeps its results');
select is((select capture_status::text from public.builds where battle_id = '9b000000-0000-0000-0000-000000000012'),
  'failed', '...and its pending capture is failed');
select results_eq(
  $$ select ref_id, status::text from public.jobs
     where kind = 'destroy' and ref_id in ('9b000000-0000-0000-0000-000000000011', '9b000000-0000-0000-0000-000000000012')
     order by ref_id $$,
  $$ values ('9b000000-0000-0000-0000-000000000011'::uuid, 'queued'),
            ('9b000000-0000-0000-0000-000000000012'::uuid, 'queued') $$,
  'destroy jobs are queued for both');
select results_eq(
  $$ select status::text, attempts, last_error from public.jobs
     where kind = 'destroy' and ref_id = '9b000000-0000-0000-0000-000000000013' $$,
  $$ values ('queued', 0, null::text) $$,
  'a destroy job that failed for good is re-queued with fresh attempts');
select is((select phase::text from public.battles where id = '9b000000-0000-0000-0000-000000000014'), 'building',
  'a battle younger than 24 h is untouched');
select results_eq(
  $$ select payload ->> 'to', payload ->> 'reason' from public.battle_events
     where battle_id = '9b000000-0000-0000-0000-000000000011' $$,
  $$ values ('abandoned', 'ttl') $$,
  'the TTL transition is logged with its reason');
select is(public.sweep_ttl(), 3, 'a second TTL run touches the same not-yet-destroyed battles again (idempotent)');

select * from finish();
rollback;
