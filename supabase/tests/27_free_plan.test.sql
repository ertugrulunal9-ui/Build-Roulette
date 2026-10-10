-- T-036: Supabase Free. The keep-alive RPC, the plan usage in admin_ops_health, and the
-- event-log retention sweep (which must never touch permanent results).
-- The database may hold committed data from the e2e scripts, so counts are checked on this
-- file's own fixtures or as differences between two calls (one transaction: now() is fixed).

begin;
create extension if not exists pgtap with schema extensions;

select plan(52);

\set mod_id '27a00000-0000-0000-0000-000000000001'
\set ana_id '27a00000-0000-0000-0000-000000000002'
\set bob_id '27a00000-0000-0000-0000-000000000003'
\set mod '{"sub":"27a00000-0000-0000-0000-000000000001","role":"authenticated","is_anonymous":false}'
\set ana '{"sub":"27a00000-0000-0000-0000-000000000002","role":"authenticated","is_anonymous":true}'

\set OLD  '27b00000-0000-0000-0000-000000000001'
\set LIVE '27b00000-0000-0000-0000-000000000002'
\set ROOM '27c00000-0000-0000-0000-000000000001'
\set b1   '27d00000-0000-0000-0000-000000000001'
\set b2   '27d00000-0000-0000-0000-000000000002'
\set b3   '27d00000-0000-0000-0000-000000000003'

insert into auth.users (id, is_anonymous, email, last_sign_in_at) values
  (:'mod_id', false, 'mod-free@example.test', now() - interval '40 days'),
  (:'ana_id', true, null, now() - interval '40 days'),
  (:'bob_id', true, null, now() - interval '40 days');
insert into private.admins (user_id, note) values (:'mod_id', 'free plan test');
insert into public.profiles (id, display_name) values (:'ana_id', 'Ana'), (:'bob_id', 'Bob');

-- ═══ keep_alive (8) ═══════════════════════════════════════════════════════
select pings as pings0 from private.keep_alive \gset
-- Older than a minute, so the next ping writes.
update private.keep_alive set last_ping_at = now() - interval '2 minutes';

set local role anon;
select lives_ok($$ select public.keep_alive() $$, 'anon (the GitHub workflow''s key) can call keep_alive');
reset role;
select is(pings, (:pings0 + 1)::bigint, 'the ping is recorded') from private.keep_alive;
select is(last_ping_at, now(), 'with its time') from private.keep_alive;

set local role anon;
select is(public.keep_alive() - 'at', '{"ok": true, "read_only": false}'::jsonb,
  'it answers ok (and the time)');
reset role;
select is(pings, (:pings0 + 1)::bigint, 'a second ping within the minute writes nothing') from private.keep_alive;

-- The Free plan makes a database over 500 MB read-only. pgTAP's own bookkeeping would be
-- rolled back with the savepoint, so the answer is checked after it.
savepoint ro;
set transaction_read_only = on;
select public.keep_alive() - 'at' as ro_answer \gset
rollback to savepoint ro;
select is(:'ro_answer'::jsonb, '{"ok": false, "read_only": true}'::jsonb,
  'a read-only database answers read_only: true (the workflow fails on it), it does not throw');

set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok($$ select public.keep_alive() $$, '42501', null,
  'players (authenticated) cannot call it: only the anon key needs it');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.keep_alive() $$, '42501', null, 'service_role cannot call it');
reset role;

-- ═══ Plan usage in admin_ops_health (18) ═══════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_ops_health() as h0 \gset
reset role;

select ok((:'h0'::jsonb) ?& array['generated_at', 'battles', 'jobs', 'captures_last_day', 'cron', 'ttl', 'usage'],
  'admin_ops_health keeps T-030''s sections and adds usage');
select ok((:'h0'::jsonb) -> 'usage' ?& array['warn_pct', 'storage', 'database', 'auth', 'keep_alive', 'retention'],
  'usage has storage, database, auth, keep_alive and retention');
select is(((:'h0'::jsonb) #>> '{usage,storage,limit_bytes}')::bigint, 1000000000::bigint,
  'storage limit: Supabase Free''s 1 GB by default');
select is(((:'h0'::jsonb) #>> '{usage,database,limit_bytes}')::bigint, 500000000::bigint,
  'database limit: Supabase Free''s 500 MB by default');
select is(((:'h0'::jsonb) #>> '{usage,warn_pct}')::int, 80, 'warning at 80 %');
select ok(((:'h0'::jsonb) #>> '{usage,database,used_bytes}')::bigint
          >= ((:'h0'::jsonb) #>> '{usage,database,this_database_bytes}')::bigint
          and ((:'h0'::jsonb) #>> '{usage,database,this_database_bytes}')::bigint > 0,
  'database size: every database of the cluster, at least this one');
select ok(jsonb_array_length((:'h0'::jsonb) #> '{usage,database,largest}') between 1 and 10
          and ((:'h0'::jsonb) #> '{usage,database,largest}') -> 0 ?& array['relation', 'bytes'],
  'database: the largest relations (at most ten)');

-- Two screenshots and a build file (the API writes metadata.size; the bucket's own size).
insert into storage.objects (bucket_id, name, metadata) values
  ('screenshots', :'OLD' || '/' || :'b1' || '.webp', '{"size": 61234, "mimetype": "image/webp"}'),
  ('screenshots', :'OLD' || '/' || :'b2' || '.webp', '{"size": 20000, "mimetype": "image/webp"}'),
  ('ephemeral-builds', :'LIVE' || '/' || :'ana_id' || '/bundle.js', '{"size": 4096}');
update auth.users set last_sign_in_at = now() where id = :'ana_id';
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_ops_health() as h1 \gset
reset role;

create function pg_temp.bucket(h jsonb, b text, k text) returns bigint language sql as $$
  select coalesce((select (e ->> k)::bigint from jsonb_array_elements(h #> '{usage,storage,buckets}') e
                   where e ->> 'bucket' = b), 0) $$;
select is(pg_temp.bucket(:'h1', 'screenshots', 'bytes') - pg_temp.bucket(:'h0', 'screenshots', 'bytes'),
  81234::bigint, 'storage: the screenshots bucket''s bytes are the sum of its objects'' sizes');
select is(pg_temp.bucket(:'h1', 'screenshots', 'objects') - pg_temp.bucket(:'h0', 'screenshots', 'objects'),
  2::bigint, 'storage: and its object count');
select is(pg_temp.bucket(:'h1', 'ephemeral-builds', 'bytes') - pg_temp.bucket(:'h0', 'ephemeral-builds', 'bytes'),
  4096::bigint, 'storage: the build files bucket too');
select is(((:'h1'::jsonb) #>> '{usage,storage,used_bytes}')::bigint
          - ((:'h0'::jsonb) #>> '{usage,storage,used_bytes}')::bigint, 85330::bigint,
  'storage: used = all buckets');
select is(((:'h1'::jsonb) #>> '{usage,auth,signed_in_this_month}')::int
          - ((:'h0'::jsonb) #>> '{usage,auth,signed_in_this_month}')::int, 1,
  'auth: a user who signed in this month counts');

-- The 80 % warning, against the configured limits.
update private.ops_settings
   set storage_limit_bytes = ((:'h1'::jsonb) #>> '{usage,storage,used_bytes}')::bigint * 2,
       database_limit_bytes = 1;
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_ops_health() -> 'usage' as u2 \gset
reset role;
select is((:'u2'::jsonb) #>> '{storage,warning}', 'false', 'storage at 50 % of the limit: no warning');
select is((:'u2'::jsonb) #>> '{database,warning}', 'true', 'database over its limit: warning');
update private.ops_settings set usage_warn_pct = 50;
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_ops_health() -> 'usage' as u3 \gset
reset role;
select is((:'u3'::jsonb) #>> '{storage,warning}', 'true', 'storage at the threshold: warning');
select is((:'u3'::jsonb) #>> '{storage,used_pct}', '50.0', 'storage: used_pct');

-- The keep-alive as Health sees it.
select is((:'u3'::jsonb) #>> '{keep_alive,stale}', 'false', 'keep-alive: pinged just now, not stale');
update private.keep_alive set last_ping_at = now() - interval '2 days';
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_ops_health() -> 'usage' as u4 \gset
reset role;
select is((:'u4'::jsonb) #>> '{keep_alive,stale}', 'true', 'keep-alive: 2 days without a ping is stale');

-- ═══ prune_event_logs (26) ════════════════════════════════════════════════
-- OLD: a 6-week-old settled battle with everything a results page shows, its log 40 days old
-- (plus one entry from 10 days ago). LIVE: a battle that is not over, with an old log entry
-- (a stuck battle keeps its log). A room with old and recent log entries. Jobs of all kinds.
update private.ops_settings set usage_warn_pct = 80, storage_limit_bytes = 1000000000,
                                database_limit_bytes = 500000000;
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds) values
  ('27e00000-0000-0000-0000-000000000001', 'A pomodoro timer', 'One button', 'Brutalist', 300),
  ('27e00000-0000-0000-0000-000000000002', 'A dice roller', 'No mouse', 'Neon', 300);
insert into public.rooms (id, code, host_id, status, settings)
values (:'ROOM', 'FRPLN', :'ana_id', 'open', '{}');
insert into public.battles (id, room_id, challenge_id, host_id, settings, phase, version, phase_started_at,
                            building_started_at, building_ends_at, shipping_ended_at, finished_at,
                            destroyed_at, is_complete, created_at)
values
  (:'OLD', :'ROOM', '27e00000-0000-0000-0000-000000000001', :'ana_id', '{"mode":"multiplayer"}', 'destroyed', 12,
   now() - interval '42 days', now() - interval '42 days 20 minutes', now() - interval '42 days 10 minutes',
   now() - interval '42 days 9 minutes', now() - interval '42 days 5 minutes', now() - interval '42 days',
   true, now() - interval '42 days 21 minutes'),
  (:'LIVE', :'ROOM', '27e00000-0000-0000-0000-000000000002', :'ana_id', '{"mode":"multiplayer"}', 'building', 3,
   now() - interval '41 days', now() - interval '41 days', now() + interval '5 minutes', null, null,
   null, false, now() - interval '41 days');
insert into public.battle_players (battle_id, user_id, display_name) values
  (:'OLD', :'ana_id', 'Ana'), (:'OLD', :'bob_id', 'Bob'), (:'LIVE', :'ana_id', 'Ana');
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms, capture_status,
                           screenshot_path, captured_at, source_destroyed_at, final_rank, total_votes)
values
  (:'b1', :'OLD', :'ana_id', 'Tomato Time', 'shipped', now() - interval '42 days 12 minutes', 480000, 'captured',
   :'OLD' || '/' || :'b1' || '.webp', now() - interval '42 days 6 minutes', now() - interval '42 days', 1, 2),
  (:'b2', :'OLD', :'bob_id', 'Clicky', 'shipped', now() - interval '42 days 11 minutes', 540000, 'captured',
   :'OLD' || '/' || :'b2' || '.webp', now() - interval '42 days 6 minutes', now() - interval '42 days', 2, 0),
  (:'b3', :'LIVE', :'ana_id', null, 'draft', null, null, 'pending', null, null, null, null, 0);
insert into public.votes (battle_id, voter_id, category, build_id, created_at, updated_at) values
  (:'OLD', :'bob_id', 'overall', :'b1', now() - interval '42 days 7 minutes', now() - interval '42 days 7 minutes'),
  (:'OLD', :'bob_id', 'style', :'b1', now() - interval '42 days 7 minutes', now() - interval '42 days 7 minutes');
insert into public.awards (battle_id, build_id, award, source, votes, created_at) values
  (:'OLD', :'b1', 'overall', 'vote', 1, now() - interval '42 days 5 minutes'),
  (:'OLD', :'b1', 'style', 'vote', 1, now() - interval '42 days 5 minutes'),
  (:'OLD', :'b2', 'fastest_ship', 'auto', null, now() - interval '42 days 5 minutes');
insert into public.battle_events (battle_id, version, type, payload, created_at) values
  (:'OLD', 1, 'phase', '{"to":"building"}', now() - interval '42 days 20 minutes'),
  (:'OLD', 2, 'ship', '{}', now() - interval '42 days 12 minutes'),
  (:'OLD', 3, 'phase', '{"to":"destroyed"}', now() - interval '42 days'),
  (:'OLD', 4, 'takedown', '{}', now() - interval '10 days'),
  (:'LIVE', 1, 'phase', '{"to":"building"}', now() - interval '41 days');
insert into public.room_events (room_id, version, type, payload, created_at) values
  (:'ROOM', 1, 'created', '{}', now() - interval '43 days'),
  (:'ROOM', 2, 'battle_started', '{}', now() - interval '42 days'),
  (:'ROOM', 3, 'member_joined', '{}', now() - interval '5 days');
-- ref_ids are random for the jobs not tied to the fixtures (the jobs table is unique per kind+ref).
insert into public.jobs (kind, ref_id, status, attempts, last_error, created_at, updated_at) values
  ('capture', :'b1', 'done', 1, null, now() - interval '42 days', now() - interval '42 days'),
  ('capture', :'b2', 'failed', 5, 'blank', now() - interval '10 days', now() - interval '10 days'),
  ('destroy', :'OLD', 'done', 1, null, now() - interval '42 days', now() - interval '42 days'),
  ('capture', '27f00000-0000-0000-0000-000000000001', 'done', 1, null, now() - interval '3 days', now() - interval '3 days'),
  ('takedown', '27f00000-0000-0000-0000-000000000002', 'failed', 5, 'storage down', now() - interval '20 days', now() - interval '20 days'),
  ('takedown', '27f00000-0000-0000-0000-000000000003', 'done', 1, null, now() - interval '20 days', now() - interval '20 days'),
  ('capture', '27f00000-0000-0000-0000-000000000004', 'queued', 0, null, now() - interval '20 days', now() - interval '20 days');

create temp table fx_jobs as select kind, ref_id from public.jobs
  where ref_id in (:'b1', :'b2', :'OLD', '27f00000-0000-0000-0000-000000000001', '27f00000-0000-0000-0000-000000000002',
                   '27f00000-0000-0000-0000-000000000003', '27f00000-0000-0000-0000-000000000004');
create function pg_temp.permanent(b uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'battle', (select to_jsonb(x) from public.battles x where x.id = b),
    'challenge', (select to_jsonb(c) from public.challenges c join public.battles x on x.challenge_id = c.id where x.id = b),
    'players', (select jsonb_agg(to_jsonb(p) order by p.user_id) from public.battle_players p where p.battle_id = b),
    'builds', (select jsonb_agg(to_jsonb(u) order by u.id) from public.builds u where u.battle_id = b),
    'votes', (select jsonb_agg(to_jsonb(v) order by v.voter_id, v.category) from public.votes v where v.battle_id = b),
    'awards', (select jsonb_agg(to_jsonb(a) order by a.award, a.build_id) from public.awards a where a.battle_id = b),
    'screenshots', (select jsonb_agg(o.name order by o.name) from storage.objects o
                    where o.bucket_id = 'screenshots' and o.name like b::text || '/%')) $$;

select public.get_public_battle(:'OLD') as pub0 \gset
select pg_temp.permanent(:'OLD') as perm0 \gset
select public.get_player_history(:'ana_id') as hist0 \gset

-- A long retention keeps everything.
update private.ops_settings set event_log_retention_days = 3650, job_retention_days = 3650;
select private.prune_event_logs() as kept \gset
select is((select count(*)::int from public.battle_events where battle_id in (:'OLD', :'LIVE')), 5,
  'retention 3650 days: no battle event of the fixtures is deleted');
select is((select count(*)::int from public.room_events where room_id = :'ROOM'), 3,
  'retention 3650 days: no room event either');
select is((select count(*)::int from public.jobs j join fx_jobs f using (kind, ref_id)), 7,
  'retention 3650 days: no job either');

-- The defaults (30 days for the logs, 7 for jobs).
update private.ops_settings set event_log_retention_days = 30, job_retention_days = 7;
select private.prune_event_logs() as pruned \gset
select ok((:'pruned'::jsonb) ?& array['battle_events', 'room_events', 'jobs'], 'it reports what it deleted');
select cmp_ok(((:'pruned'::jsonb) ->> 'battle_events')::int, '>=', 3, 'at least the three old events of OLD');

select is((select count(*)::int from public.battle_events where battle_id = :'OLD' and created_at < now() - interval '30 days'), 0,
  'battle events older than 30 days of a battle that is over are deleted');
select is((select count(*)::int from public.battle_events where battle_id = :'OLD'), 1,
  'the one from 10 days ago stays');
select is((select count(*)::int from public.battle_events where battle_id = :'LIVE'), 1,
  'a battle that is not over keeps its whole log');
select is((select count(*)::int from public.room_events where room_id = :'ROOM' and created_at < now() - interval '30 days'), 0,
  'room events older than 30 days are deleted');
select is((select count(*)::int from public.room_events where room_id = :'ROOM'), 1, 'the recent room event stays');
select ok(exists (select 1 from public.rooms where id = :'ROOM'), 'the room itself stays');

select is((select count(*)::int from public.jobs where kind = 'capture' and ref_id in (:'b1', :'b2')), 0,
  'finished capture jobs (done or failed) older than 7 days are deleted');
select is((select count(*)::int from public.jobs where kind = 'destroy' and ref_id = :'OLD'), 0,
  'a finished destroy job older than 7 days is deleted');
select is((select status::text from public.jobs where ref_id = '27f00000-0000-0000-0000-000000000001'), 'done',
  'a capture job finished 3 days ago stays');
select is((select count(*)::int from public.jobs where kind = 'takedown' and ref_id in
            ('27f00000-0000-0000-0000-000000000002', '27f00000-0000-0000-0000-000000000003')), 2,
  'takedown jobs stay, done or failed (a failed one is what /admin retries)');
select is((select status::text from public.jobs where ref_id = '27f00000-0000-0000-0000-000000000004'), 'queued',
  'a job that is not finished stays, however old');

-- Permanent results: nothing changed.
select is(pg_temp.permanent(:'OLD'), :'perm0'::jsonb,
  'the battle, challenge, roster, builds (names, ranks, screenshot paths), votes, awards and screenshot files are unchanged');
select is(public.get_public_battle(:'OLD'), :'pub0'::jsonb, 'the public results page reads exactly the same');
select is(public.get_player_history(:'ana_id'), :'hist0'::jsonb, 'and so does the player history');
select is((select count(*)::int from storage.objects where bucket_id = 'screenshots' and name like :'OLD' || '/%'), 2,
  'both screenshots are still in storage');
select is((select count(*)::int from public.votes where battle_id = :'OLD'), 2, 'the ballots stay');
select is((select count(*)::int from public.awards where battle_id = :'OLD'), 3, 'the awards stay');

-- Running it again deletes nothing more of the fixtures.
select private.prune_event_logs() as again \gset
select is((select count(*)::int from public.battle_events where battle_id in (:'OLD', :'LIVE')), 2,
  'a second run deletes nothing more');

-- Scheduled daily; reachable by no API role (04 checks every private function).
select is((select schedule from cron.job where jobname = 'br-event-logs-prune'), '41 4 * * *',
  'pg_cron runs it daily (04:41 UTC)');
select ok(not has_function_privilege('service_role', 'private.prune_event_logs()', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.prune_event_logs()', 'EXECUTE'),
  'no API role can run the sweep');
select ok(not has_function_privilege('authenticated', 'private.ops_health_signals(integer)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.ops_usage()', 'EXECUTE'),
  'the moved T-030 function and ops_usage are private: only admin_ops_health reaches them');

select * from finish();
rollback;
