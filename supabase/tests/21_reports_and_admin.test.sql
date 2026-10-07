-- T-024: report_build (every guard), the admin role (non-admin, anonymous, admin), the
-- admin RPCs (report queue, dismiss, take down, retry, battle and room logs, action log).
-- What a takedown does to the reads and to running battles is in 22_takedown.test.sql.
--
-- Cast: ana and ben (players), sam (a spectator of room R), cy (a stranger, anonymous, no
-- profile), dee (a signed-up user who is not an admin), mod (the admin, email user),
-- ghost (an anonymous user). Fixtures are inserted as the superuser:
--   P  results, multiplayer: ana's "Ana Pad" #1 (captured), ben's "Ben Box" #2, dee DNF,
--      eve disqualified
--   R  reveal, room R (ana, ben players; sam spectator): ana's and ben's builds revealed
--   K  building: ana's draft

begin;
create extension if not exists pgtap with schema extensions;

select plan(67);

\set ana_id   '21a00000-0000-0000-0000-000000000001'
\set ben_id   '21a00000-0000-0000-0000-000000000002'
\set sam_id   '21a00000-0000-0000-0000-000000000003'
\set cy_id    '21a00000-0000-0000-0000-000000000004'
\set dee_id   '21a00000-0000-0000-0000-000000000005'
\set mod_id   '21a00000-0000-0000-0000-000000000006'
\set ghost_id '21a00000-0000-0000-0000-000000000007'
\set eve_id   '21a00000-0000-0000-0000-000000000008'
\set ana   '{"sub":"21a00000-0000-0000-0000-000000000001","role":"authenticated","is_anonymous":true}'
\set ben   '{"sub":"21a00000-0000-0000-0000-000000000002","role":"authenticated","is_anonymous":true}'
\set sam   '{"sub":"21a00000-0000-0000-0000-000000000003","role":"authenticated","is_anonymous":true}'
\set cy    '{"sub":"21a00000-0000-0000-0000-000000000004","role":"authenticated","is_anonymous":true}'
\set dee   '{"sub":"21a00000-0000-0000-0000-000000000005","role":"authenticated","is_anonymous":false}'
\set mod   '{"sub":"21a00000-0000-0000-0000-000000000006","role":"authenticated","is_anonymous":false}'
\set ghost '{"sub":"21a00000-0000-0000-0000-000000000007","role":"authenticated","is_anonymous":true}'

\set P '21b00000-0000-0000-0000-000000000001'
\set R '21b00000-0000-0000-0000-000000000002'
\set K '21b00000-0000-0000-0000-000000000003'
\set room '21c00000-0000-0000-0000-000000000001'
\set pa '21d00000-0000-0000-0000-0000000000a1'
\set pb '21d00000-0000-0000-0000-0000000000b1'
\set pd '21d00000-0000-0000-0000-0000000000d1'
\set pe '21d00000-0000-0000-0000-0000000000e1'
\set ra '21d00000-0000-0000-0000-0000000000a2'
\set rb '21d00000-0000-0000-0000-0000000000b2'
\set ka '21d00000-0000-0000-0000-0000000000a3'

insert into auth.users (id, is_anonymous, email) values
  (:'ana_id', true, null), (:'ben_id', true, null), (:'sam_id', true, null), (:'cy_id', true, null),
  (:'dee_id', false, 'dee@example.test'), (:'mod_id', false, 'mod@example.test'),
  (:'ghost_id', true, null), (:'eve_id', true, null);
insert into public.profiles (id, display_name) values
  (:'ana_id', 'Ana'), (:'ben_id', 'Ben'), (:'sam_id', 'Sam'), (:'dee_id', 'Dee'), (:'eve_id', 'Eve');
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('21e00000-0000-0000-0000-00000000000' || n)::uuid, 'Build ' || n, 'Rule ' || n, 'Style ' || n, 300
from generate_series(1, 3) n;
insert into public.rooms (id, code, host_id, status, settings)
values (:'room', 'QRSTU', :'ana_id', 'in_battle', '{"max_players": 8}');
insert into public.room_members (room_id, user_id, role) values
  (:'room', :'ana_id', 'player'), (:'room', :'ben_id', 'player'), (:'room', :'sam_id', 'spectator');
insert into public.battles (id, room_id, challenge_id, host_id, settings, phase, finished_at, is_complete,
                            reveal_order, reveal_index, phase_ends_at)
values
  (:'P', null, '21e00000-0000-0000-0000-000000000001', :'ana_id', '{"mode":"multiplayer","reveal_vote":true}',
   'results', now() - interval '1 hour', true, '{}', 0, now() + interval '1 minute'),
  (:'R', :'room', '21e00000-0000-0000-0000-000000000002', :'ana_id', '{"mode":"multiplayer","reveal_vote":true}',
   'reveal', null, false, array[:'ra', :'rb']::uuid[], 0, now() + interval '1 minute'),
  (:'K', null, '21e00000-0000-0000-0000-000000000003', :'ana_id', '{"mode":"multiplayer"}',
   'building', null, false, '{}', 0, now() + interval '1 minute');
update public.rooms set current_battle_id = :'R' where id = :'room';
insert into public.battle_players (battle_id, user_id, display_name) values
  (:'P', :'ana_id', 'Ana'), (:'P', :'ben_id', 'Ben'), (:'P', :'dee_id', 'Dee'), (:'P', :'eve_id', 'Eve'),
  (:'R', :'ana_id', 'Ana'), (:'R', :'ben_id', 'Ben'),
  (:'K', :'ana_id', 'Ana'), (:'K', :'ben_id', 'Ben');
insert into public.builds (id, battle_id, builder_id, name, status, final_rank, capture_status, screenshot_path)
values
  (:'pa', :'P', :'ana_id', 'Ana Pad', 'shipped', 1, 'captured', :'P' || '/' || :'pa' || '.webp'),
  (:'pb', :'P', :'ben_id', 'Ben Box', 'shipped', 2, 'captured', :'P' || '/' || :'pb' || '.webp'),
  (:'pd', :'P', :'dee_id', null, 'dnf', null, 'pending', null),
  (:'pe', :'P', :'eve_id', 'Eve Kicked', 'disqualified', null, 'pending', null),
  (:'ra', :'R', :'ana_id', 'Ana Live', 'shipped', null, 'pending', null),
  (:'rb', :'R', :'ben_id', 'Ben Live', 'auto_shipped', null, 'pending', null),
  (:'ka', :'K', :'ana_id', null, 'draft', null, 'pending', null);
insert into public.battle_events (battle_id, version, type, actor_id, payload) values
  (:'P', 1, 'phase', :'ana_id', '{"from":null,"to":"spinning"}'),
  (:'P', 2, 'ship', :'ana_id', '{"name":"Ana Pad"}');
update public.battles set version = 2 where id = :'P';
insert into public.room_events (room_id, version, type, actor_id, payload) values
  (:'room', 1, 'created', :'ana_id', '{}'), (:'room', 2, 'member_joined', :'ben_id', '{}');

-- ═══ report_build ═════════════════════════════════════════════════════════
-- Guards
set local role anon;
select throws_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'pa'), '42501', null,
  'anon (no session) cannot report');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select throws_ok(format($$ select public.report_build(%L, 'boring', null) $$, :'pa'), '22023', 'invalid_reason',
  'an unknown reason');
select throws_ok(format($$ select public.report_build(%L, null, null) $$, :'pa'), '22023', 'invalid_reason',
  'a missing reason');
select throws_ok(format($$ select public.report_build(%L, 'other', %L) $$, :'pa', repeat('x', 501)), '22023',
  'invalid_details', 'details over 500 characters');
select throws_ok(format($$ select public.report_build(%L, 'other', %L) $$, :'pa', 'bad' || chr(7)), '22023',
  'invalid_details', 'details with a control character');
select throws_ok($$ select public.report_build(gen_random_uuid(), 'spam', null) $$, 'P0002', 'build_not_found',
  'an unknown build');
select throws_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'pd'), 'P0002', 'build_not_found',
  'a DNF build has nothing to report');
select throws_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'pe'), 'P0002', 'build_not_found',
  'a disqualified build is not public');
select throws_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'ra'), 'P0002', 'build_not_found',
  'a stranger cannot see (or report) a build in a running reveal');
select set_config('request.jwt.claims', :'ben', true);
select throws_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'ka'), 'P0002', 'build_not_found',
  'a draft in BUILDING is not visible to anyone else');
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'pa'), 'P0001', 'own_build',
  'not your own build');
-- Allowed
select set_config('request.jwt.claims', :'cy', true);
select public.report_build(:'pa', 'spam', E'  Spam link\nin the page  ') as rep \gset
select is((:'rep'::jsonb) - 'report_id' - 'created_at',
  jsonb_build_object('build_id', :'pa', 'reason', 'spam'),
  'a signed-in stranger (anonymous, no profile) reports a build of public results');
select throws_ok(format($$ select public.report_build(%L, 'phishing', null) $$, :'pa'), 'P0001', 'already_reported',
  'one report per user per build');
select set_config('request.jwt.claims', :'sam', true);
select lives_ok(format($$ select public.report_build(%L, 'offensive', '') $$, :'ra'),
  'a spectator reports a build of the running reveal');
select set_config('request.jwt.claims', :'ana', true);
select lives_ok(format($$ select public.report_build(%L, 'malware', 'Mines crypto') $$, :'rb'),
  'a player reports another player''s build in the reveal');
-- What was stored
reset role;
select is((select details from public.reports where reporter_id = :'cy_id'), E'Spam link\nin the page',
  'details are trimmed (newlines kept)');
select is((select details from public.reports where reporter_id = :'sam_id'), null, 'empty details are null');
select is((select status from public.reports where reporter_id = :'cy_id'), 'open', 'a new report is open');
set local role authenticated;
select set_config('request.jwt.claims', :'sam', true);
select is((select count(*)::int from public.reports), 1, 'RLS: a reporter sees their own reports only');
select set_config('request.jwt.claims', :'ben', true);
select lives_ok(format($$ select public.report_build(%L, 'phishing', 'Asks for a password') $$, :'pa'),
  'a second report of the same build');
reset role;

-- ═══ The admin role ═══════════════════════════════════════════════════════
select throws_ok(format($$ insert into private.admins (user_id) values (%L) $$, :'ghost_id'), 'P0001', null,
  'an anonymous user can never be an admin (trigger)');
insert into private.admins (user_id, note) values (:'mod_id', 'test moderator');
select throws_ok(format($$ update private.admins set user_id = %L where user_id = %L $$, :'ghost_id', :'mod_id'),
  'P0001', null, 'nor become one by an update');
set local role anon;
select throws_ok($$ select public.is_admin() $$, '42501', null, 'anon cannot even ask');
select throws_ok($$ select public.admin_report_queue() $$, '42501', null, 'anon cannot call the admin RPCs');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select is(public.is_admin(), false, 'a signed-up user who is not listed is not an admin');
select set_config('request.jwt.claims', :'cy', true);
select is(public.is_admin(), false, 'an anonymous user is not an admin');
select set_config('request.jwt.claims', :'mod', true);
select is(public.is_admin(), true, 'a listed, non-anonymous user is an admin');
select set_config('request.jwt.claims', replace(:'mod', '"is_anonymous":false', '"is_anonymous":true'), true);
select is(public.is_admin(), false, 'an admin''s id with an anonymous token is not an admin');

-- Every admin RPC refuses a non-admin
select set_config('request.jwt.claims', :'dee', true);
select throws_ok($$ select public.admin_report_queue() $$, '42501', 'not_admin', 'queue: not_admin');
select throws_ok(format($$ select public.admin_dismiss_reports(%L) $$, :'pa'), '42501', 'not_admin',
  'dismiss: not_admin');
select throws_ok(format($$ select public.admin_take_down_build(%L) $$, :'pa'), '42501', 'not_admin',
  'take down: not_admin');
select throws_ok(format($$ select public.admin_battle_log(%L) $$, :'P'), '42501', 'not_admin',
  'battle log: not_admin');
select throws_ok($$ select public.admin_room_log('QRSTU') $$, '42501', 'not_admin', 'room log: not_admin');
select throws_ok($$ select public.admin_action_log() $$, '42501', 'not_admin', 'action log: not_admin');
select set_config('request.jwt.claims', :'ghost', true);
select throws_ok($$ select public.admin_report_queue() $$, '42501', 'not_admin', 'an anonymous user: not_admin');
reset role;

-- ═══ The report queue ═════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_report_queue() as q \gset
reset role;
select is((select array_agg(b ->> 'build_id' order by n) from jsonb_array_elements((:'q'::jsonb) -> 'builds')
             with ordinality x(b, n)),
  array[:'pa', :'ra', :'rb'], 'open reports grouped by build, most open reports first');
select is((:'q'::jsonb) -> 'builds' -> 0 -> 'reasons', '{"spam": 1, "phishing": 1}'::jsonb, 'reason counts');
select is(
  (select jsonb_build_object('name', b ->> 'name', 'builder', b ->> 'builder_name', 'phase', b ->> 'battle_phase',
                             'battle', b ->> 'battle_id', 'shot', b ->> 'screenshot_path',
                             'count', b -> 'report_count', 'open', b -> 'open_count', 'takedown', b -> 'takedown')
   from jsonb_array_elements((:'q'::jsonb) -> 'builds') b where b ->> 'build_id' = :'pa'),
  jsonb_build_object('name', 'Ana Pad', 'builder', 'Ana', 'phase', 'results', 'battle', :'P',
                     'shot', :'P' || '/' || :'pa' || '.webp', 'count', 2, 'open', 2, 'takedown', null),
  'each build: name, builder, battle, screenshot, counts');
select is(
  (select jsonb_agg(r ->> 'details' order by r ->> 'created_at' desc, r ->> 'reason')
   from jsonb_array_elements((:'q'::jsonb) -> 'builds' -> 0 -> 'reports') r),
  jsonb_build_array('Asks for a password', E'Spam link\nin the page'),
  'and the reports with their details');
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is(public.admin_dismiss_reports(:'ra', 'false alarm'), jsonb_build_object('build_id', :'ra', 'dismissed', 1),
  'dismiss: the open reports of a build');
select is(public.admin_dismiss_reports(:'ra'), jsonb_build_object('build_id', :'ra', 'dismissed', 0),
  'dismissing again changes nothing');
reset role;

-- ═══ Take down (finished battle) ═════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select throws_ok(format($$ select public.admin_take_down_build(%L, %L) $$, :'pa', repeat('n', 501)), '22023',
  'invalid_details', 'a note is at most 500 characters');
select throws_ok($$ select public.admin_take_down_build(gen_random_uuid()) $$, 'P0002', 'build_not_found',
  'an unknown build');
select public.admin_take_down_build(:'pa', 'Phishing form') as td \gset
reset role;
select is((:'td'::jsonb) - 'taken_down_at' - 'job_id',
  jsonb_build_object('build_id', :'pa', 'battle_id', :'P', 'disqualified', false, 'actioned_reports', 2,
                     'retried', false),
  'take down a build of finished results: not disqualified, both reports actioned');
select is((select jsonb_build_object('name', name, 'shot', screenshot_path, 'status', status, 'rank', final_rank,
                                     'down', taken_down_at is not null)
           from public.builds where id = :'pa'),
  '{"name": null, "shot": null, "status": "shipped", "rank": 1, "down": true}'::jsonb,
  'the row: name and screenshot path cleared at once, status and rank kept');
select is((select jsonb_build_object('name', original_name, 'shot', original_screenshot_path,
                                     'admin', admin_id, 'note', note, 'phase', phase_at_takedown)
           from private.build_takedowns where build_id = :'pa'),
  jsonb_build_object('name', 'Ana Pad', 'shot', :'P' || '/' || :'pa' || '.webp', 'admin', :'mod_id',
                     'note', 'Phishing form', 'phase', 'results'),
  'the originals are archived for the admins');
select is((select status::text from public.jobs where kind = 'takedown' and ref_id = :'pa'), 'queued',
  'a takedown job is queued (the worker deletes the screenshot)');
select is((select array_agg(status order by status) from public.reports where build_id = :'pa'),
  array['actioned', 'actioned'], 'the reports are actioned');
select ok((select bool_and(resolved_at is not null) from public.reports where build_id = :'pa'),
  'and say when (who is in the admin log only)');
select is((select jsonb_build_object('type', type, 'actor', actor_id, 'payload', payload)
           from public.battle_events where battle_id = :'P' order by id desc limit 1),
  jsonb_build_object('type', 'takedown', 'actor', :'mod_id', 'payload', jsonb_build_object('build_id', :'pa')),
  'a takedown battle event (clients in the battle refetch)');
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select throws_ok(format($$ select public.admin_take_down_build(%L) $$, :'pa'), 'P0001', 'already_taken_down',
  'a second takedown is refused');
reset role;
update public.jobs set status = 'failed', attempts = 5, last_error = 'storage down'
 where kind = 'takedown' and ref_id = :'pa';
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is(public.admin_take_down_build(:'pa') -> 'retried', 'true'::jsonb,
  'unless its Storage delete failed for good: then it is queued again');
reset role;
select is((select jsonb_build_object('status', status, 'attempts', attempts) from public.jobs
           where kind = 'takedown' and ref_id = :'pa'),
  '{"status": "queued", "attempts": 0}'::jsonb, 'with fresh attempts');
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select lives_ok(format($$ select public.report_build(%L, 'spam', null) $$, :'pb'),
  'one report per build: the same user may report another build of the battle');
reset role;

-- ═══ Queue after the actions ══════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is((select array_agg(b ->> 'build_id' order by b ->> 'build_id')
           from jsonb_array_elements(public.admin_report_queue() -> 'builds') b),
  array[:'pb', :'rb'], 'the open queue no longer lists the dismissed and taken-down builds');
select is((select array_agg(b ->> 'build_id' order by b ->> 'build_id')
           from jsonb_array_elements(public.admin_report_queue(true) -> 'builds') b),
  array[:'pa', :'ra'], 'the resolved list does');
select is((select b -> 'takedown' ->> 'job_status'
           from jsonb_array_elements(public.admin_report_queue(true) -> 'builds') b
           where b ->> 'build_id' = :'pa'), 'queued', 'with the takedown state');
reset role;

-- ═══ Battle and room logs ═════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_battle_log(:'P') as log \gset
select throws_ok($$ select public.admin_battle_log(gen_random_uuid()) $$, 'P0002', 'battle_not_found',
  'battle log: unknown battle');
select public.admin_room_log(' qrstu ') as rlog \gset
select throws_ok($$ select public.admin_room_log('ZZZZZ') $$, 'P0002', 'room_not_found', 'room log: unknown code');
reset role;
select is((select jsonb_agg(jsonb_build_object('v', e -> 'version', 't', e ->> 'type', 'who', e ->> 'actor_name')
                            order by n)
           from jsonb_array_elements((:'log'::jsonb) -> 'events') with ordinality x(e, n)),
  '[{"v":1,"t":"phase","who":"Ana"},{"v":2,"t":"ship","who":"Ana"},{"v":3,"t":"takedown","who":"moderator"}]'::jsonb,
  'battle log: the battle_events timeline, oldest first, with actor names');
select is((select b ->> 'name' from jsonb_array_elements((:'log'::jsonb) -> 'builds') b where b ->> 'id' = :'pa'),
  'Ana Pad', 'battle log: admins see the original name of a taken-down build');
select is((select array_agg(j ->> 'kind') from jsonb_array_elements((:'log'::jsonb) -> 'jobs') j),
  array['takedown'], 'battle log: the jobs of the battle');
select is((:'rlog'::jsonb) -> 'room' ->> 'code', 'QRSTU', 'room log: found by code (any case, trimmed)');
select is((select jsonb_agg(e ->> 'type' order by n)
           from jsonb_array_elements((:'rlog'::jsonb) -> 'events') with ordinality x(e, n)),
  '["created", "member_joined"]'::jsonb, 'room log: the room_events timeline');
select is((select jsonb_agg(m ->> 'display_name' || ':' || (m ->> 'role') order by n)
           from jsonb_array_elements((:'rlog'::jsonb) -> 'members') with ordinality x(m, n)),
  '["Ana:player", "Ben:player", "Sam:spectator"]'::jsonb, 'room log: the members');

-- ═══ The action log ═══════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is((select jsonb_agg(a ->> 'action' order by n)
           from jsonb_array_elements(public.admin_action_log()) with ordinality x(a, n)),
  '["view_room", "view_battle", "retry_takedown", "take_down_build", "dismiss_reports"]'::jsonb,
  'every admin action is logged, newest first (reads of the queue are not actions)');
select is((select jsonb_build_object('email', a ->> 'admin_email', 'note', a ->> 'note', 'build', a ->> 'build_id')
           from jsonb_array_elements(public.admin_action_log()) a where a ->> 'action' = 'take_down_build'),
  jsonb_build_object('email', 'mod@example.test', 'note', 'Phishing form', 'build', :'pa'),
  'who did what to which build, with the note');
reset role;

select * from finish();
rollback;
