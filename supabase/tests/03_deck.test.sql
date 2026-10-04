-- The prompt deck, the tag rules, the draw and the shared constants.

begin;
create extension if not exists pgtap with schema extensions;

select plan(26);

-- ─── Counts and text (7) ──────────────────────────────────────────────────
select is((select count(*)::int from public.prompt_cards where kind = 'build' and is_active), 60, '60 active BUILD cards');
select is((select count(*)::int from public.prompt_cards where kind = 'rule'  and is_active), 40, '40 active RULE cards');
select is((select count(*)::int from public.prompt_cards where kind = 'style' and is_active), 30, '30 active STYLE cards');

select is_empty(
  $$ select id from public.prompt_cards
     where btrim(text) = '' or char_length(text) > 120
        or (hint is not null and btrim(hint) = '') $$,
  'no card has an empty text or an empty hint');

select is_empty(
  $$ select kind, lower(text) from public.prompt_cards group by 1, 2 having count(*) > 1 $$,
  'no duplicate card texts within a kind');

select throws_ok(
  $$ insert into public.prompt_cards (kind, text, tags) values ('rule', 'x', '{needs:telepathy}') $$,
  '23514', null,
  'a tag outside the vocabulary is rejected');

select throws_ok(
  $$ insert into public.prompt_cards (kind, text) values ('rule', '   ') $$,
  '23514', null,
  'a blank card text is rejected');

-- ─── Tags (4) ─────────────────────────────────────────────────────────────
select is_empty(
  $$ select c.id, t.tag from public.prompt_cards c, unnest(c.tags) as t(tag)
     where t.tag !~ '^(needs|no):(text|keyboard|pointer|audio|color|animation|scroll|buttons)$' $$,
  'every tag is needs:<cap> or no:<cap> from the documented vocabulary');

select is_empty(
  $$ select c.id from public.prompt_cards c
     where not private.tags_compatible(c.tags, c.tags) $$,
  'no card contradicts itself');

select set_eq(
  $$ select distinct substr(t.tag, 7) from public.prompt_cards c, unnest(c.tags) t(tag) where t.tag like 'needs:%' $$,
  $$ select distinct substr(t.tag, 4) from public.prompt_cards c, unnest(c.tags) t(tag) where t.tag like 'no:%' $$,
  'every capability that a card needs is forbidden by some other card and vice versa (no dead tags)');

select ok(
  private.tags_compatible('{needs:audio}', '{}')
  and private.tags_compatible('{needs:audio}', '{needs:audio,no:color}')
  and not private.tags_compatible('{needs:audio}', '{no:audio}')
  and not private.tags_compatible('{no:color}', '{needs:text,needs:color}')
  and private.tags_compatible(null, '{no:text}'),
  'tags_compatible: no:X conflicts with needs:X in either direction');

-- ─── Every BUILD stays playable (2) ───────────────────────────────────────
select is_empty(
  $$ select b.text
     from public.prompt_cards b
     where b.kind = 'build' and b.is_active
       and (select count(*) from public.prompt_cards r
            where r.kind = 'rule' and r.is_active and private.tags_compatible(b.tags, r.tags)) < 30 $$,
  'every BUILD card has at least 30 compatible RULE cards');

select is_empty(
  $$ select b.text, r.text
     from public.prompt_cards b
     join public.prompt_cards r on r.kind = 'rule' and r.is_active and private.tags_compatible(b.tags, r.tags)
     where b.kind = 'build' and b.is_active
       and (select count(*) from public.prompt_cards s
            where s.kind = 'style' and s.is_active
              and private.tags_compatible(b.tags, s.tags)
              and private.tags_compatible(r.tags, s.tags)) < 15 $$,
  'every compatible BUILD + RULE pair has at least 15 compatible STYLE cards');

-- ─── Shared constants (2) ─────────────────────────────────────────────────
-- Also compared with @br/game by packages/game/src/schema-drift.test.ts.
select is(private.build_time_limits_seconds(), array[180, 300, 600, 900, 1200, 1800],
  'allowed time limits: 3, 5, 10, 15, 20, 30 minutes');
select is(private.default_battle_settings(),
  '{"spinning_s": 6, "shipping_s": 15, "voting_s": 60, "results_s": 60, "capture_deadline_s": 600}'::jsonb,
  'default phase durations');

-- ─── The draw (12) ────────────────────────────────────────────────────────
insert into auth.users (id, is_anonymous) values
  ('3a000000-0000-0000-0000-000000000001', true),
  ('3a000000-0000-0000-0000-000000000002', true);
insert into public.profiles (id, display_name) values
  ('3a000000-0000-0000-0000-000000000001', 'drawer'),
  ('3a000000-0000-0000-0000-000000000002', 'fresh');

-- 300 draws for a player without history.
create temp table draws on commit drop as
select private.draw_challenge('3a000000-0000-0000-0000-000000000002', 300) as challenge_id
from generate_series(1, 300);

select is((select count(*)::int from draws), 300, '300 draws succeed');

select is_empty(
  $$ select c.id
     from draws d
     join public.challenges c on c.id = d.challenge_id
     join public.prompt_cards b on b.id = c.build_card_id
     join public.prompt_cards r on r.id = c.rule_card_id
     join public.prompt_cards s on s.id = c.style_card_id
     where b.kind <> 'build' or r.kind <> 'rule' or s.kind <> 'style'
        or not private.tags_compatible(b.tags, r.tags)
        or not private.tags_compatible(b.tags, s.tags)
        or not private.tags_compatible(r.tags, s.tags) $$,
  'every draw has one card of each kind and respects the tag rules');

select is_empty(
  $$ select c.id
     from draws d
     join public.challenges c on c.id = d.challenge_id
     join public.prompt_cards b on b.id = c.build_card_id
     join public.prompt_cards r on r.id = c.rule_card_id
     join public.prompt_cards s on s.id = c.style_card_id
     where c.build_text <> b.text or c.rule_text <> r.text or c.style_text <> s.text
        or c.build_hint is distinct from b.hint or c.rule_hint is distinct from r.hint
        or c.style_hint is distinct from s.hint
        or c.time_limit_seconds <> 300 $$,
  'the challenge snapshots the card texts, hints and the time limit');

select cmp_ok(
  (select count(distinct c.build_card_id)::int from draws d join public.challenges c on c.id = d.challenge_id),
  '>=', 40,
  '300 draws cover at least 40 different BUILD cards');

-- Ten recent battles for "drawer", using ten specific cards of each kind.
create temp table recent_cards on commit drop as
select kind, id, row_number() over (partition by kind order by id) as n
from public.prompt_cards
where kind in ('build', 'rule', 'style') and tags = '{}';
delete from recent_cards where n > 10;

insert into public.challenges (id, build_card_id, rule_card_id, style_card_id,
                               build_text, rule_text, style_text, time_limit_seconds)
select ('3c000000-0000-0000-0000-0000000000' || lpad(b.n::text, 2, '0'))::uuid,
       b.id, r.id, s.id, 'b', 'r', 's', 300
from recent_cards b
join recent_cards r on r.kind = 'rule'  and r.n = b.n
join recent_cards s on s.kind = 'style' and s.n = b.n
where b.kind = 'build';
insert into public.battles (id, challenge_id, host_id, phase, settings, created_at)
select ('3b000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('3c000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '3a000000-0000-0000-0000-000000000001', 'destroyed', '{"mode":"solo"}',
       now() - make_interval(mins => n)
from generate_series(1, 10) as n;
insert into public.battle_players (battle_id, user_id, display_name)
select ('3b000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '3a000000-0000-0000-0000-000000000001', 'drawer'
from generate_series(1, 10) as n;

select is((select count(*)::int from recent_cards), 30, 'fixture: 10 recent cards of each kind');

create temp table recent_draws on commit drop as
select private.draw_challenge('3a000000-0000-0000-0000-000000000001', 600) as challenge_id
from generate_series(1, 100);

select is_empty(
  $$ select c.id from recent_draws d join public.challenges c on c.id = d.challenge_id
     where c.build_card_id in (select id from recent_cards)
        or c.rule_card_id  in (select id from recent_cards)
        or c.style_card_id in (select id from recent_cards) $$,
  '100 draws never repeat a card from the player''s last 10 battles');

-- Only recent BUILD cards left active: the draw falls back to them.
update public.prompt_cards set is_active = false
where kind = 'build' and id not in (select id from recent_cards where kind = 'build');
-- (A function that inserts the challenge cannot be read back in the same
-- statement: its row is not in that statement's snapshot. Hence \gset.)
select private.draw_challenge('3a000000-0000-0000-0000-000000000001', 600) as fallback_id \gset
select ok(
  (select c.build_card_id in (select id from recent_cards where kind = 'build')
   from public.challenges c where c.id = :'fallback_id'),
  'when every playable card is recent, the draw falls back to recent cards');

-- Weighted: one card with weight 1000 against nine with weight 1.
update public.prompt_cards set weight = 1 where kind = 'build';
update public.prompt_cards set weight = 1000
where id = (select id from recent_cards where kind = 'build' and n = 1);
create temp table weighted_draws on commit drop as
select private.draw_challenge('3a000000-0000-0000-0000-000000000002', 600) as challenge_id
from generate_series(1, 50);
select cmp_ok(
  (select count(*)::int
   from weighted_draws d
   join public.challenges c on c.id = d.challenge_id
   where c.build_card_id = (select id from recent_cards where kind = 'build' and n = 1)),
  '>=', 40,
  'the draw is weighted (a 1000:9 card wins at least 40 of 50 draws)');

-- Tags are respected even when it leaves a single option.
update public.prompt_cards set is_active = false where kind = 'build';
update public.prompt_cards set is_active = true where text = 'A drum machine';
update public.prompt_cards set is_active = false
where kind = 'style' and text not in ('Silent film', 'Brutalist');
select private.draw_challenge('3a000000-0000-0000-0000-000000000002', 600) as drum_id \gset
select is(
  (select array[c.build_text, c.style_text]
   from public.challenges c where c.id = :'drum_id'),
  array['A drum machine', 'Brutalist'],
  'a BUILD that needs audio is never paired with a STYLE that forbids it');

update public.prompt_cards set is_active = false where text = 'Brutalist';
select throws_ok(
  $$ select private.draw_challenge('3a000000-0000-0000-0000-000000000002', 600) $$,
  'P0001', 'deck_empty',
  'no compatible combination left → deck_empty');

update public.prompt_cards set is_active = false;
select throws_ok(
  $$ select private.draw_challenge('3a000000-0000-0000-0000-000000000002', 600) $$,
  'P0001', 'deck_empty',
  'an empty deck → deck_empty');

select * from finish();
rollback;
