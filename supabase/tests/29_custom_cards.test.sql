-- Custom cards (T-053): the host's own BUILD / RULE / STYLE cards and build time limit, as
-- room settings (update_room_settings), and how start_battle uses them.
--
-- Room A (ana hosts, ben plays): a custom BUILD card and a 45-minute limit; RULE and STYLE
--   are drawn from the deck.
-- Room B (cy hosts, dee plays): all three cards custom, no time limit (drawn: 10, 15 or 20).
-- Room C (eli hosts, fay plays): a stored limit that is no longer allowed.

begin;
create extension if not exists pgtap with schema extensions;

select plan(39);

\set ana '{"sub":"29a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"29a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cy  '{"sub":"29a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dee '{"sub":"29a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set eli '{"sub":"29a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set fay '{"sub":"29a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set ana_id '29a00000-0000-0000-0000-000000000001'
\set ben_id '29a00000-0000-0000-0000-000000000002'

insert into auth.users (id, is_anonymous)
select ('29a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 6) n;

-- ═══ The filter, word by word (5) ═════════════════════════════════════════
select is(private.blocked_card_term('Guess who really did it'), null,
  'words are checked one by one: "who really" is not "whoreally"');
select is(private.blocked_card_term('Keep or nothing'), null,
  'no match across a word boundary ("keepornothing")');
select is(private.blocked_card_term('A shit detector'), 'shit', 'a blocked word in a card');
select is(private.blocked_card_term('Say f u c k twice'), 'fuck', 'a run of single letters is joined');
select is(private.blocked_card_term('Ask A.S.S nicely'), 'ass', 'separators inside a word still fold');

-- ═══ Room A: settings ═════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.create_room('ana') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room_a, (:'created'::jsonb) ->> 'code' as code_a \gset

set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.join_room(:'code_a', 'ben');

-- ─── Guards (13) ──────────────────────────────────────────────────────
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_build": "A lava lamp"}') $$, :'room_a'),
  '42501', 'not_host', 'only the host writes cards');
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_build": 42}') $$, :'room_a'),
  '22023', 'invalid_settings', 'a card must be text');
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_rule": "  ab  "}') $$, :'room_a'),
  '22023', 'invalid_settings', 'a card needs 3 characters after trimming');
select throws_ok(format($$ select public.update_room_settings(%L, %L) $$, :'room_a',
                        jsonb_build_object('custom_style', repeat('x', 81))),
  '22023', 'invalid_settings', 'a card has 80 characters at most');
select lives_ok(format($$ select public.update_room_settings(%L, %L) $$, :'room_a',
                       jsonb_build_object('custom_style', repeat('x', 80))),
  '80 characters are allowed');
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_build": "A bell\u0007 app"}') $$, :'room_a'),
  '22023', 'invalid_settings', 'no control characters');
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_build": "A shit detector"}') $$, :'room_a'),
  '22023', 'card_not_allowed', 'the name filter applies to cards');
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_rule": "Say f u c k twice"}') $$, :'room_a'),
  '22023', 'card_not_allowed', 'spaced-out letters are caught');
select throws_ok(format($$ select public.update_room_settings(%L, '{"time_limit_s": 300}') $$, :'room_a'),
  '22023', 'invalid_settings', '5 minutes is not an allowed limit');
select throws_ok(format($$ select public.update_room_settings(%L, '{"time_limit_s": 1800.5}') $$, :'room_a'),
  '22023', 'invalid_settings', 'the limit is whole seconds');
select throws_ok(format($$ select public.update_room_settings(%L, '{"time_limit_s": "1800"}') $$, :'room_a'),
  '22023', 'invalid_settings', 'the limit is a number');
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_build": "A lava lamp", "time_limit_s": 61}') $$, :'room_a'),
  '22023', 'invalid_settings', 'one bad key rejects the whole change');
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_card": "A lava lamp"}') $$, :'room_a'),
  '22023', 'invalid_settings', 'unknown keys are still rejected');

-- ─── Accepted (5) ─────────────────────────────────────────────────────
select is(public.update_room_settings(:'room_a',
            '{"custom_style": null, "custom_build": "  A pet rock\n\n  that   judges you ", "time_limit_s": 2700}'),
          '{"max_players": 8, "custom_build": "A pet rock that judges you", "time_limit_s": 2700}'::jsonb,
  'the card is trimmed and its whitespace collapsed; null removes a card');
select is(public.update_room_settings(:'room_a', '{"custom_rule": "Guess who really did it"}') ->> 'custom_rule',
          'Guess who really did it', 'a card the old whole-name check would block is allowed');
select is(public.update_room_settings(:'room_a', '{"custom_rule": null}'),
          '{"max_players": 8, "custom_build": "A pet rock that judges you", "time_limit_s": 2700}'::jsonb,
  'null clears a card');
reset role;
select ok((select (payload -> 'settings') ->> 'custom_build' = 'A pet rock that judges you'
           from public.room_events
           where room_id = :'room_a' and type = 'settings'
           order by id desc limit 1),
  'the settings event carries the cards to the room');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.update_room_settings(:'room_a', '{"custom_build": "A pet rock that judges you"}'),
          '{"max_players": 8, "custom_build": "A pet rock that judges you", "time_limit_s": 2700}'::jsonb,
  'the same card again changes nothing');

-- ═══ Room A: the battle (8) ═══════════════════════════════════════════════
select public.set_ready(:'room_a', true);
select set_config('request.jwt.claims', :'ben', true);
select public.set_ready(:'room_a', true);
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room_a') as battle_a \gset
reset role;

select b.challenge_id as challenge_a from public.battles b where b.id = :'battle_a' \gset
select is((select build_text from public.challenges where id = :'challenge_a'),
  'A pet rock that judges you', 'the BUILD card is the host''s');
select ok((select build_card_id is null and build_hint is null from public.challenges where id = :'challenge_a'),
  'a custom card has no card id and no hint');
select ok((select rule_card_id is not null and style_card_id is not null from public.challenges where id = :'challenge_a'),
  'RULE and STYLE are drawn from the deck');
select is((select rule_text from public.challenges c join public.prompt_cards p on p.id = c.rule_card_id
           where c.id = :'challenge_a'),
          (select p.text from public.challenges c join public.prompt_cards p on p.id = c.rule_card_id
           where c.id = :'challenge_a'),
  'a drawn card keeps its text');
select is((select time_limit_seconds from public.challenges where id = :'challenge_a'), 2700,
  'the host''s time limit: 45 minutes');

set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.get_battle_snapshot(:'battle_a') as snap_a \gset
reset role;
select is((:'snap_a'::jsonb) #> '{challenge,build}',
          '{"text": "A pet rock that judges you", "hint": null}'::jsonb,
  'players get the custom card in the battle snapshot');

set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.update_room_settings(%L, '{"custom_build": "A lava lamp"}') $$, :'room_a'),
  'P0001', 'wrong_room_state', 'cards cannot change during a battle');
reset role;

select is(array_position(private.room_recent_cards(:'room_a', array[:'ana_id', :'ben_id']::uuid[]), null), null,
  'the recent cards of the room leave out the custom card');

-- ═══ Room B: three custom cards, no time limit (6) ═══════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select public.create_room('cy') as created_b \gset
reset role;
select (:'created_b'::jsonb) ->> 'room_id' as room_b, (:'created_b'::jsonb) ->> 'code' as code_b \gset

set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select public.join_room(:'code_b', 'dee');
select public.set_ready(:'room_b', true);
select set_config('request.jwt.claims', :'cy', true);
select lives_ok(format($$ select public.update_room_settings(%L, %L) $$, :'room_b',
  '{"custom_build": "Bir hava durumu uygulaması", "custom_rule": "Sadece emoji", "custom_style": "Windows 95", "time_limit_s": 600}'),
  'three cards (in any language) and a limit');
select is(public.update_room_settings(:'room_b', '{"time_limit_s": null}') ? 'time_limit_s', false,
  'null clears the time limit');
select public.set_ready(:'room_b', true);
select public.start_battle(:'room_b') as battle_b \gset
reset role;

select b.challenge_id as challenge_b from public.battles b where b.id = :'battle_b' \gset
select is((select array[build_text, rule_text, style_text] from public.challenges where id = :'challenge_b'),
          array['Bir hava durumu uygulaması', 'Sadece emoji', 'Windows 95'],
  'all three cards are the host''s');
select ok((select build_card_id is null and rule_card_id is null and style_card_id is null
                  and build_hint is null and rule_hint is null and style_hint is null
           from public.challenges where id = :'challenge_b'),
  'no card ids and no hints');
select ok((select time_limit_seconds = any (private.random_build_time_limits_seconds())
           from public.challenges where id = :'challenge_b'),
  'without a limit setting the limit is drawn (10, 15 or 20 minutes)');
select is((select settings ->> 'custom_style' from public.rooms where id = :'room_b'), 'Windows 95',
  'the cards stay in the room settings for the next battle');

-- ═══ Room C: a stored limit that is no longer allowed (1) ═════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'eli', true);
select public.create_room('eli') as created_c \gset
reset role;
select (:'created_c'::jsonb) ->> 'room_id' as room_c, (:'created_c'::jsonb) ->> 'code' as code_c \gset
-- As if written when 5 minutes was allowed.
update public.rooms set settings = '{"time_limit_s": 300}' where id = :'room_c';
set local role authenticated;
select set_config('request.jwt.claims', :'fay', true);
select public.join_room(:'code_c', 'fay');
select public.set_ready(:'room_c', true);
select set_config('request.jwt.claims', :'eli', true);
select public.set_ready(:'room_c', true);
select public.start_battle(:'room_c') as battle_c \gset
reset role;
select ok((select c.time_limit_seconds = any (private.random_build_time_limits_seconds())
           from public.battles b join public.challenges c on c.id = b.challenge_id
           where b.id = :'battle_c'),
  'a stored limit that is no longer allowed falls back to the draw');

-- ═══ Privileges (1) ═══════════════════════════════════════════════════════
select ok(not has_function_privilege('authenticated', 'private.check_custom_card(text, jsonb)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.blocked_card_term(text)', 'EXECUTE'),
  'the card checks are not callable by clients');

select * from finish();
rollback;
