-- Key constraints, defaults and reference data. Runs as the superuser (no
-- RLS involved); fixtures are rolled back at the end.

begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

-- ─── Fixtures ─────────────────────────────────────────────────────────────
-- users: u1 = 1111…, u2 = 2222…, u3 = 3333… (u3 is never on a roster)
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');
insert into public.profiles (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Ada'),
  ('22222222-2222-2222-2222-222222222222', 'Bob'),
  ('33333333-3333-3333-3333-333333333333', 'Cy');

insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds) values
  ('c0000000-0000-0000-0000-000000000001', 'A pomodoro timer', 'No buttons', 'Brutalist', 300),
  ('c0000000-0000-0000-0000-000000000002', 'A todo app', 'One color', 'Y2K', 600);

-- battle b1 (challenge 1): roster u1, u2 with builds d1, d2
-- battle b2 (challenge 2): roster u1 with build d3
insert into public.battles (id, challenge_id, host_id, settings) values
  ('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', '{}'),
  ('b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111', '{}');
insert into public.battle_players (battle_id, user_id, display_name) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Ada'),
  ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Bob'),
  ('b0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Ada');
insert into public.builds (id, battle_id, builder_id) values
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111');

-- ─── profiles (3) ─────────────────────────────────────────────────────────
select ok(
  (select bool_and(avatar_seed ~ '^[0-9a-f]{12}$') from public.profiles),
  'profiles.avatar_seed defaults to 12 random hex chars (pgcrypto via extensions schema)'
);
select throws_ok(
  $$ insert into public.profiles (id, display_name) values ('33333333-3333-3333-3333-333333333333', '') $$,
  '23514', null, 'profiles.display_name rejects an empty name'
);
select throws_ok(
  $$ update public.profiles set display_name = repeat('x', 25)
     where id = '33333333-3333-3333-3333-333333333333' $$,
  '23514', null, 'profiles.display_name rejects 25 characters'
);

-- ─── rooms.code (9) ───────────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.rooms (code, host_id) values ('K7QXM', '11111111-1111-1111-1111-111111111111') $$,
  'room code K7QXM is accepted'
);
select throws_ok(
  format('insert into public.rooms (code, host_id) values (%L, %L)',
         c.code, '11111111-1111-1111-1111-111111111111'),
  '23514', null, format('room code %s is rejected (%s)', c.code, c.why)
)
from (values
  ('K7QXI',  'contains I'),
  ('K7QXO',  'contains O'),
  ('K7QX0',  'contains 0'),
  ('K7QX1',  'contains 1'),
  ('k7qxm',  'lowercase'),
  ('K7QX',   'too short'),
  ('K7QXMM', 'too long')
) as c(code, why);
select throws_ok(
  $$ insert into public.rooms (code, host_id) values ('K7QXM', '22222222-2222-2222-2222-222222222222') $$,
  '23505', null, 'room codes are unique'
);

-- ─── challenges.time_limit_seconds (4) ────────────────────────────────────
select throws_ok(
  $$ insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
     values ('b', 'r', 's', 59) $$,
  '23514', null, 'time_limit_seconds 59 is rejected'
);
select lives_ok(
  $$ insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
     values ('b', 'r', 's', 60) $$,
  'time_limit_seconds 60 is accepted'
);
select lives_ok(
  $$ insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
     values ('b', 'r', 's', 3600) $$,
  'time_limit_seconds 3600 is accepted'
);
select throws_ok(
  $$ insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
     values ('b', 'r', 's', 3601) $$,
  '23514', null, 'time_limit_seconds 3601 is rejected'
);

-- ─── battles (1) ──────────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.battles (challenge_id, host_id, settings)
     values ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '{}') $$,
  '23505', null, 'a challenge belongs to exactly one battle'
);

-- ─── builds (4) ───────────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.builds (battle_id, builder_id)
     values ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111') $$,
  '23505', null, 'one build per (battle, builder)'
);
select throws_ok(
  $$ insert into public.builds (battle_id, builder_id)
     values ('b0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333') $$,
  '23503', null, 'a build requires its builder to be on the battle roster'
);
select throws_ok(
  $$ update public.builds set name = '' where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'builds.name rejects an empty name'
);
select throws_ok(
  $$ update public.builds set name = repeat('x', 49) where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'builds.name rejects 49 characters'
);

-- ─── vote_categories (1) ──────────────────────────────────────────────────
select results_eq(
  $$ select slug from public.vote_categories where is_active order by sort_order $$,
  array['overall', 'rule', 'style', 'chaos'],
  'the four default vote categories are seeded in order'
);

-- ─── votes (6) ────────────────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.votes (battle_id, voter_id, category, build_id)
     values ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
             'overall', 'd0000000-0000-0000-0000-000000000002') $$,
  'a roster player can have a vote row'
);
select throws_ok(
  $$ insert into public.votes (battle_id, voter_id, category, build_id)
     values ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
             'overall', 'd0000000-0000-0000-0000-000000000001') $$,
  '23505', null, 'the vote PK prevents a second vote in the same category'
);
select lives_ok(
  $$ insert into public.votes (battle_id, voter_id, category, build_id)
     values ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
             'style', 'd0000000-0000-0000-0000-000000000002') $$,
  'the same voter can vote in another category'
);
select throws_ok(
  $$ insert into public.votes (battle_id, voter_id, category, build_id)
     values ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
             'nope', 'd0000000-0000-0000-0000-000000000001') $$,
  '23503', null, 'votes.category must be a known category'
);
select throws_ok(
  $$ insert into public.votes (battle_id, voter_id, category, build_id)
     values ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
             'overall', 'd0000000-0000-0000-0000-000000000003') $$,
  '23503', null, 'a vote cannot point at a build of another battle'
);
select throws_ok(
  $$ insert into public.votes (battle_id, voter_id, category, build_id)
     values ('b0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
             'overall', 'd0000000-0000-0000-0000-000000000001') $$,
  '23503', null, 'only roster players can have votes'
);

-- ─── awards and reports (4) ───────────────────────────────────────────────
select throws_ok(
  $$ insert into public.awards (battle_id, build_id, award, source)
     values ('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003',
             'winner', 'auto') $$,
  '23503', null, 'an award cannot point at a build of another battle'
);
select throws_ok(
  $$ insert into public.awards (battle_id, build_id, award, source)
     values ('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
             'winner', 'magic') $$,
  '23514', null, 'awards.source must be vote or auto'
);
select throws_ok(
  $$ insert into public.reports (build_id, reporter_id, reason)
     values ('d0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'meh') $$,
  '23514', null, 'reports.reason must be a known reason'
);
select throws_ok(
  $$ insert into public.reports (build_id, reporter_id, reason)
     values ('d0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'spam'),
            ('d0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'other') $$,
  '23505', null, 'one report per (build, reporter)'
);

-- ─── Deletes (5) ──────────────────────────────────────────────────────────
select throws_ok(
  $$ delete from public.battle_players
     where battle_id = 'b0000000-0000-0000-0000-000000000001'
       and user_id = '22222222-2222-2222-2222-222222222222' $$,
  '23503', null, 'a roster row with a build cannot be deleted (permanent results are protected)'
);

update public.rooms set current_battle_id = 'b0000000-0000-0000-0000-000000000001' where code = 'K7QXM';
insert into public.awards (battle_id, build_id, award, source)
  values ('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'winner', 'auto');
insert into public.battle_events (battle_id, version, type)
  values ('b0000000-0000-0000-0000-000000000001', 1, 'phase');

select lives_ok(
  $$ delete from public.battles where id = 'b0000000-0000-0000-0000-000000000001' $$,
  'deleting a battle cascades through roster, builds, votes, awards and events'
);
select is(
  (select count(*)::int from public.builds where battle_id = 'b0000000-0000-0000-0000-000000000001')
  + (select count(*)::int from public.battle_players where battle_id = 'b0000000-0000-0000-0000-000000000001')
  + (select count(*)::int from public.votes where battle_id = 'b0000000-0000-0000-0000-000000000001')
  + (select count(*)::int from public.awards where battle_id = 'b0000000-0000-0000-0000-000000000001')
  + (select count(*)::int from public.battle_events where battle_id = 'b0000000-0000-0000-0000-000000000001'),
  0,
  'no rows of the deleted battle remain'
);
select is(
  (select current_battle_id from public.rooms where code = 'K7QXM'),
  null,
  'rooms.current_battle_id is set to null when its battle is deleted'
);
update public.battles set room_id = (select id from public.rooms where code = 'K7QXM')
  where id = 'b0000000-0000-0000-0000-000000000002';
delete from public.rooms where code = 'K7QXM';
select is(
  (select room_id from public.battles where id = 'b0000000-0000-0000-0000-000000000002'),
  null,
  'battles outlive their room (room_id set to null)'
);

select * from finish();
rollback;
