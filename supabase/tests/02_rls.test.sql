-- RLS behaviour with fixture data. Fixtures are inserted as the superuser;
-- assertions run as `authenticated` (or `anon`) with request.jwt.claims set
-- the way PostgREST sets them. Everything is rolled back at the end.
--
-- Cast (all uuids end in the same digit as the list number):
--   1 alice  host of room r1; roster of b1 (building)
--   2 pat    member of r1;   roster of b1 and b2 (results)
--   3 dora   spectator in r1, never on a roster
--   4 carl   member of r1, kicked during the test
--   5 sam    stranger: no room, no roster
--   6 rita   room r2; roster of b2 (results), b3 (abandoned, in r2), b4 (destroyed)

begin;
create extension if not exists pgtap with schema extensions;

select plan(
  50
  -- 3 write attempts (INSERT/UPDATE/DELETE) per public table
  + 3 * (select count(*)::int from pg_class
         where relnamespace = 'public'::regnamespace and relkind in ('r', 'p'))
);

-- ─── Fixtures ─────────────────────────────────────────────────────────────
insert into auth.users (id, is_anonymous) values
  ('0a000000-0000-0000-0000-000000000001', true),
  ('0a000000-0000-0000-0000-000000000002', true),
  ('0a000000-0000-0000-0000-000000000003', true),
  ('0a000000-0000-0000-0000-000000000004', true),
  ('0a000000-0000-0000-0000-000000000005', true),
  ('0a000000-0000-0000-0000-000000000006', false);
insert into public.profiles (id, display_name) values
  ('0a000000-0000-0000-0000-000000000001', 'alice'),
  ('0a000000-0000-0000-0000-000000000002', 'pat'),
  ('0a000000-0000-0000-0000-000000000003', 'dora'),
  ('0a000000-0000-0000-0000-000000000004', 'carl'),
  ('0a000000-0000-0000-0000-000000000005', 'sam'),
  ('0a000000-0000-0000-0000-000000000006', 'rita');

insert into public.rooms (id, code, host_id) values
  ('e1000000-0000-0000-0000-000000000001', 'K7QXM', '0a000000-0000-0000-0000-000000000001'),
  ('e1000000-0000-0000-0000-000000000002', 'ZZZZ2', '0a000000-0000-0000-0000-000000000006');
insert into public.room_members (room_id, user_id, role) values
  ('e1000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'player'),
  ('e1000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000002', 'player'),
  ('e1000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000003', 'spectator'),
  ('e1000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000004', 'player'),
  ('e1000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000006', 'player');

insert into public.prompt_cards (kind, text) values ('build', 'A pomodoro timer');

insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds) values
  ('c0000000-0000-0000-0000-000000000001', 'Pomodoro timer', 'No buttons', 'Brutalist', 300),
  ('c0000000-0000-0000-0000-000000000002', 'Todo app', 'One color', 'Y2K', 300),
  ('c0000000-0000-0000-0000-000000000003', 'Weather', 'No text', 'Pastel', 300),
  ('c0000000-0000-0000-0000-000000000004', 'Drum pad', 'Mobile first', 'Neon', 300);

insert into public.battles (id, room_id, challenge_id, host_id, phase, settings) values
  ('b0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'building', '{}'),
  ('b0000000-0000-0000-0000-000000000002', null,
   'c0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000002', 'results', '{}'),
  ('b0000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000002',
   'c0000000-0000-0000-0000-000000000003', '0a000000-0000-0000-0000-000000000006', 'abandoned', '{}'),
  ('b0000000-0000-0000-0000-000000000004', null,
   'c0000000-0000-0000-0000-000000000004', '0a000000-0000-0000-0000-000000000006', 'destroyed', '{}');
update public.rooms set current_battle_id = 'b0000000-0000-0000-0000-000000000001'
  where id = 'e1000000-0000-0000-0000-000000000001';

insert into public.battle_players (battle_id, user_id, display_name) values
  ('b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'alice'),
  ('b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000002', 'pat'),
  ('b0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000002', 'pat'),
  ('b0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000006', 'rita'),
  ('b0000000-0000-0000-0000-000000000003', '0a000000-0000-0000-0000-000000000006', 'rita'),
  ('b0000000-0000-0000-0000-000000000004', '0a000000-0000-0000-0000-000000000006', 'rita');

insert into public.builds (id, battle_id, builder_id, status) values
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'draft'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000002', 'draft'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000002', 'shipped'),
  ('d0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000006', 'shipped'),
  ('d0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000003', '0a000000-0000-0000-0000-000000000006', 'dnf'),
  ('d0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000004', '0a000000-0000-0000-0000-000000000006', 'shipped');

insert into public.votes (battle_id, voter_id, category, build_id) values
  ('b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'overall', 'd0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'style',   'd0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000002', 'overall', 'd0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000002', 'overall', 'd0000000-0000-0000-0000-000000000004'),
  ('b0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000006', 'overall', 'd0000000-0000-0000-0000-000000000003');

insert into public.awards (battle_id, build_id, award, source, votes) values
  ('b0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000003', 'overall', 'vote', 1),
  ('b0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000004', 'overall', 'vote', 1),
  ('b0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000005', 'fastest_ship', 'auto', null);

insert into public.reports (build_id, reporter_id, reason) values
  ('d0000000-0000-0000-0000-000000000003', '0a000000-0000-0000-0000-000000000005', 'spam');

insert into public.battle_events (battle_id, version, type)
  values ('b0000000-0000-0000-0000-000000000001', 1, 'phase');
insert into public.jobs (kind, ref_id)
  values ('capture', 'd0000000-0000-0000-0000-000000000003');

-- ═══ alice: host, room member, roster of b1 (16) ══════════════════════════
set local role authenticated;
set local request.jwt.claims = '{"sub":"0a000000-0000-0000-0000-000000000001","role":"authenticated"}';

select is(auth.uid(), '0a000000-0000-0000-0000-000000000001'::uuid, 'alice: auth.uid() reads request.jwt.claims');
select results_eq(
  $$ select id from public.rooms $$,
  $$ values ('e1000000-0000-0000-0000-000000000001'::uuid) $$,
  'alice: sees her room only'
);
select is((select count(*)::int from public.room_members), 4, 'alice: sees all 4 members of her room');
select set_eq(
  $$ select id from public.battles $$,
  array['b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002',
        'b0000000-0000-0000-0000-000000000004']::uuid[],
  'alice: sees her battle plus public results/destroyed battles, not the abandoned one'
);
select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 2,
          'alice: sees both builds of her battle');
select is((select count(*)::int from public.battle_players
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 2,
          'alice: sees the roster of her battle');
select set_eq(
  $$ select id from public.challenges $$,
  array['c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002',
        'c0000000-0000-0000-0000-000000000004']::uuid[],
  'alice: sees challenges of visible battles only'
);
select results_eq(
  $$ select voter_id, category from public.votes order by category $$,
  $$ values ('0a000000-0000-0000-0000-000000000001'::uuid, 'overall'::text),
            ('0a000000-0000-0000-0000-000000000001'::uuid, 'style'::text) $$,
  'alice: sees only her own votes'
);
select set_eq(
  $$ select build_id from public.awards $$,
  array['d0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000004']::uuid[],
  'alice: sees awards of public battles, not of the abandoned one'
);
select is((select count(*)::int from public.profiles), 6, 'alice: sees every profile');
select is((select count(*)::int from public.vote_categories), 4, 'alice: sees the vote categories');
select is_empty($$ select * from public.reports $$, 'alice: sees no reports (she filed none)');
select throws_ok($$ select * from public.jobs $$, '42501', null, 'alice: cannot read jobs');
select throws_ok($$ select * from public.battle_events $$, '42501', null, 'alice: cannot read battle_events');
select throws_ok($$ select * from public.prompt_cards $$, '42501', null, 'alice: cannot read prompt_cards');

-- Writes: every public table rejects INSERT, UPDATE and DELETE outright
-- (privilege error, not a silent RLS no-op).
select throws_ok(
  format('insert into public.%I default values', c.relname),
  '42501', null, format('alice: cannot INSERT into public.%s', c.relname)
)
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
order by c.relname;

select throws_ok(
  format('update public.%I set %I = %I', c.relname, a.attname, a.attname),
  '42501', null, format('alice: cannot UPDATE public.%s', c.relname)
)
from pg_class c
cross join lateral (
  select attname from pg_attribute
  where attrelid = c.oid and attnum > 0 and not attisdropped
    and attidentity = '' and attgenerated = ''
  order by attnum limit 1
) a
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
order by c.relname;

select throws_ok(
  format('delete from public.%I', c.relname),
  '42501', null, format('alice: cannot DELETE from public.%s', c.relname)
)
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
order by c.relname;

select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 2,
          'alice: her battle is intact after the rejected writes');

-- ═══ dora: spectator in the room, not on the roster (4) ═══════════════════
set local request.jwt.claims = '{"sub":"0a000000-0000-0000-0000-000000000003","role":"authenticated"}';

select is((select count(*)::int from public.rooms), 1, 'dora: sees the room she spectates');
select ok(exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000001'),
          'dora: sees the running battle of her room');
select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 2,
          'dora: sees the builds of that battle');
select ok(exists (select 1 from public.challenges where id = 'c0000000-0000-0000-0000-000000000001'),
          'dora: sees the challenge of that battle');

-- ═══ sam: stranger (12) ═══════════════════════════════════════════════════
set local request.jwt.claims = '{"sub":"0a000000-0000-0000-0000-000000000005","role":"authenticated"}';

select is_empty($$ select * from public.rooms $$, 'sam: sees no rooms');
select is_empty($$ select * from public.room_members $$, 'sam: sees no room members');
select set_eq(
  $$ select id from public.battles $$,
  array['b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004']::uuid[],
  'sam: sees only battles in results/destroyed'
);
select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 0,
          'sam: cannot see builds of a running battle');
select is((select count(*)::int from public.battle_players
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 0,
          'sam: cannot see the roster of a running battle');
select ok(not exists (select 1 from public.challenges where id = 'c0000000-0000-0000-0000-000000000001'),
          'sam: cannot see the challenge of a running battle');
select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000002'), 2,
          'sam: sees builds of a battle in results');
select is((select count(*)::int from public.battle_players
           where battle_id = 'b0000000-0000-0000-0000-000000000002'), 2,
          'sam: sees the roster of a battle in results');
select is((select count(*)::int from public.awards), 2, 'sam: sees awards of public battles only');
select ok(not exists (select 1 from public.builds where battle_id = 'b0000000-0000-0000-0000-000000000003'),
          'sam: cannot see builds of an abandoned battle');
select is_empty($$ select * from public.votes $$, 'sam: sees no votes (cast none)');
select is((select count(*)::int from public.reports), 1, 'sam: sees the report he filed');

-- The running battle becomes public once it reaches results (2).
reset role;
update public.battles set phase = 'results' where id = 'b0000000-0000-0000-0000-000000000001';
set local role authenticated;

select ok(exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000001'),
          'sam: sees a battle once it reaches results');
select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 2,
          'sam: sees its builds once it reaches results');

reset role;
update public.battles set phase = 'building' where id = 'b0000000-0000-0000-0000-000000000001';
set local role authenticated;

-- ═══ carl: member, then kicked (6) ════════════════════════════════════════
set local request.jwt.claims = '{"sub":"0a000000-0000-0000-0000-000000000004","role":"authenticated"}';

select is((select count(*)::int from public.rooms), 1, 'carl: sees the room before the kick');
select ok(exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000001'),
          'carl: sees the room''s running battle before the kick');

reset role;
update public.room_members set kicked_at = now()
  where room_id = 'e1000000-0000-0000-0000-000000000001'
    and user_id = '0a000000-0000-0000-0000-000000000004';
set local role authenticated;

select is_empty($$ select * from public.rooms $$, 'carl: kicked, no longer sees the room');
select is_empty($$ select * from public.room_members $$, 'carl: kicked, no longer sees the members');
select ok(not exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000001'),
          'carl: kicked, no longer sees the running battle');
select is((select count(*)::int from public.builds
           where battle_id = 'b0000000-0000-0000-0000-000000000001'), 0,
          'carl: kicked, no longer sees its builds');

-- ═══ pat: kicked roster player (3) ════════════════════════════════════════
-- Documented semantics (T-016, replacing the T-002 decision): a kick removes
-- every live view of the room, including the running battle the player is on
-- (their draft is disqualified). The battle becomes visible again, like for
-- everyone, once it reaches RESULTS. Their solo battle b2 is unaffected.
reset role;
update public.room_members set kicked_at = now()
  where room_id = 'e1000000-0000-0000-0000-000000000001'
    and user_id = '0a000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"0a000000-0000-0000-0000-000000000002","role":"authenticated"}';

select is_empty($$ select * from public.rooms $$, 'pat: kicked, no longer sees the room');
select ok(not exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000001'),
          'pat: kicked roster player no longer sees the running battle of that room');
select ok(exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000002'),
          'pat: kicked roster player still sees a battle outside that room');

-- ═══ rita: abandoned battle is visible to its roster only (2) ═════════════
set local request.jwt.claims = '{"sub":"0a000000-0000-0000-0000-000000000006","role":"authenticated"}';

select ok(exists (select 1 from public.battles where id = 'b0000000-0000-0000-0000-000000000003'),
          'rita: sees her abandoned battle');
select is((select count(*)::int from public.awards
           where battle_id = 'b0000000-0000-0000-0000-000000000003'), 1,
          'rita: sees the awards of her abandoned battle');

-- ═══ authenticated without a sub claim (2) ════════════════════════════════
set local request.jwt.claims = '{"role":"authenticated"}';

select is_empty($$ select * from public.rooms $$, 'no sub: sees no rooms');
select set_eq(
  $$ select id from public.battles $$,
  array['b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004']::uuid[],
  'no sub: sees only public battles'
);

-- ═══ anon: no table access at all (3) ═════════════════════════════════════
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon: cannot read profiles');
select throws_ok($$ select * from public.battles $$, '42501', null, 'anon: cannot read battles (even public ones)');
select throws_ok(
  $$ insert into public.profiles (id, display_name) values ('0a000000-0000-0000-0000-000000000005', 'x') $$,
  '42501', null, 'anon: cannot write profiles'
);

reset role;
select * from finish();
rollback;
