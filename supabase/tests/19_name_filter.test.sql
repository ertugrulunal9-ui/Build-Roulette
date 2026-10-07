-- T-024: the name filter (private.blocked_terms, private.fold_name, private.blocked_term)
-- and `name_not_allowed` in create_room, join_room, start_solo_battle and ship_build.
--
-- The innocent words below are the Scunthorpe cases the word/substring rules exist for:
-- they must stay allowed. If a new term blocks one of them, make that term a `word` term
-- (or leave it out) instead of deleting the test.

begin;
create extension if not exists pgtap with schema extensions;

select plan(33);

\set ana '{"sub":"19a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"19a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set ana_id '19a00000-0000-0000-0000-000000000001'
\set ben_id '19a00000-0000-0000-0000-000000000002'
insert into auth.users (id, is_anonymous) values (:'ana_id', true), (:'ben_id', true);

-- ─── Normalisation (6) ────────────────────────────────────────────────────
select is(private.fold_name('FÜCK Çağrı İstanbul Iğdır'), 'fuck cagri istanbul igdir',
  'fold: lowercase, diacritics removed, Turkish İ/I/ı → i');
select is(private.fold_name('0r0spu 5h1t @ss $p4m 7est 3'), 'orospu shit ass spam test e',
  'fold: leetspeak 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s');
select is(private.fold_name('Straße Æsir Œuvre Ørsted Łódź Đorđe'), 'strasse aesir oeuvre orsted lodz dorde',
  'fold: ß, æ, œ, ø, ł, đ');
select is(private.term_regex('ass'), 'a{1,}s{2,}', 'a run of k letters must appear at least k times');
select is(private.term_regex('nigger'), 'n{1,}i{1,}g{2,}e{1,}r{1,}', 'term regex keeps double letters double');
select is(private.blocked_term(''), null, 'an empty name has no blocked term');

-- ─── Blocked: case, diacritics, leetspeak, repeats, separators (1 test, 30 names) ──
select is(
  (select array_agg(n || ' → ' || coalesce(private.blocked_term(n), 'ALLOWED') order by i)
   from unnest(array[
     'fuck', 'FUCK', 'FÜCK', 'fuuuuuck', 'f.u.c.k', 'f u c k', 'f-u-c-k', 'xXfuckXx',
     'F4GG0T', 'n1gg3r', 'sh1t', '5h1t', '$hit', '@ss', 'A S S', 'a.s.s', 'big dick', 'dicks',
     'Bitches', 'Hitler fan', 'retard', 'nazi',
     'OROSPU', '0r0spu', 'SİKTİR', 'amına koyim', 'AMK', 'aq', 'kahpe', 'şerefsiz'
   ]) with ordinality as t(n, i)
   where private.blocked_term(n) is null),
  null,
  'every one of 30 offensive spellings is blocked (the list shows any that got through)');

-- ─── Innocent words stay allowed (1 test, 40 names) ───────────────────────
select is(
  (select array_agg(n || ' → ' || private.blocked_term(n) order by i)
   from unnest(array[
     'Scunthorpe', 'class', 'assassin', 'Bass Player', 'Mr. Bassett', 'as', 'Essex', 'Sussex',
     'Dickens', 'cockpit', 'Peacock', 'Hancock', 'Cocktail', 'therapist', 'grape', 'drape',
     'spice', 'Nigeria', 'Niger', 'niggardly', 'shitake', 'Matsushita', 'fire retardant',
     'Arsenal', 'button', 'Analytics', 'Wankel', 'Kumquat', 'pic', 'Amina', 'Sıkı', 'Göteborg',
     'got', 'Ayşe', 'Çağrı', 'İstanbul', 'Player 1', 'Grace Hopper', 'Sushi Master', 'Pomodoro 3000'
   ]) with ordinality as t(n, i)
   where private.blocked_term(n) is not null),
  null,
  'none of 40 innocent names is blocked (the list shows any that was)');

-- ─── The list (5) ─────────────────────────────────────────────────────────
select ok((select count(*) from private.blocked_terms where lang = 'en') >= 20
          and (select count(*) from private.blocked_terms where lang = 'tr') >= 10,
  'a modest English + Turkish starting list');
select is_empty($$ select term from private.blocked_terms where term <> private.fold_name(term) $$,
  'every term is stored folded');
select throws_ok($$ insert into private.blocked_terms (term, match, lang) values ('Bad Word', 'word', 'en') $$,
  '23514', null, 'terms are lowercase letters only (check constraint)');
-- Editable: a new term blocks at once, a removed one no longer does.
insert into private.blocked_terms (term, match, lang) values ('zorblax', 'word', 'en');
select is(private.blocked_term('Zorblax 9000'), 'zorblax', 'a term added with SQL blocks at once');
delete from private.blocked_terms where term = 'zorblax';
select is(private.blocked_term('Zorblax 9000'), null, 'and stops when removed');

-- ─── Word vs substring rules (4) ──────────────────────────────────────────
select is(private.blocked_term('My Ass Game'), 'ass', 'a word term as a whole token');
select is(private.blocked_term('myassgame'), null, 'a word term glued to other letters passes (documented trade-off)');
select is(private.blocked_term('superfuckingcool'), 'fuck', 'a substring term anywhere');
select is(private.blocked_term('Dicks'), 'dick', 'word terms allow a plural s');

-- ─── The RPCs (17) ────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok($$ select public.create_room('Sh1t Lord') $$, '22023', 'name_not_allowed',
  'create_room: a blocked display name');
select throws_ok($$ select public.start_solo_battle('F U C K') $$, '22023', 'name_not_allowed',
  'start_solo_battle: a blocked display name');
select throws_ok($$ select public.start_solo_battle('') $$, '22023', 'invalid_display_name',
  'start_solo_battle: the length rule still comes first');
select throws_ok($$ select public.start_solo_battle(repeat('a', 25)) $$, '22023', 'invalid_display_name',
  'start_solo_battle: 25 characters is too long');
select lives_ok($$ select public.create_room('Scunthorpe Fan') $$, 'create_room: an innocent name');
select public.create_room('Ana') as created \gset
select (:'created'::jsonb) ->> 'code' as code, (:'created'::jsonb) ->> 'room_id' as room \gset
select set_config('request.jwt.claims', :'ben', true);
select throws_ok(format($$ select public.join_room(%L, 'orospu') $$, :'code'), '22023', 'name_not_allowed',
  'join_room: a blocked display name');
select throws_ok($$ select public.join_room('ZZZZZ', 'orospu') $$, '22023', 'name_not_allowed',
  'join_room: the name is checked before the code (and the failure is not counted)');
reset role;
select is((select count(*)::int from private.rate_events where user_id = :'ben_id' and action = 'join_room_failed'),
  0, 'a bad name is not a failed code attempt');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.join_room(:'code', 'Dickens') ->> 'role', 'player', 'join_room: an innocent name');
reset role;
select is((select display_name from public.profiles where id = :'ben_id'), 'Dickens',
  'the profile keeps the name as typed');

-- ship_build: a solo battle in BUILDING with the files uploaded.
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.start_solo_battle('Ben') as solo \gset
reset role;
update public.battles
   set phase = 'building', building_started_at = now() - interval '1 minute',
       building_ends_at = now() + interval '4 minutes', phase_ends_at = now() + interval '4 minutes'
 where id = :'solo';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'solo' || '/' || :'ben_id' || '/source.json'),
  ('ephemeral-builds', :'solo' || '/' || :'ben_id' || '/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select throws_ok(format($$ select public.ship_build(%L, 'Pussy Timer', '{}') $$, :'solo'), '22023',
  'name_not_allowed', 'ship_build: a blocked build name');
select throws_ok(format($$ select public.ship_build(%L, 'xXbitchXx', '{}') $$, :'solo'), '22023',
  'name_not_allowed', 'ship_build: a substring term');
select throws_ok(format($$ select public.ship_build(%L, '', '{}') $$, :'solo'), '22023',
  'invalid_name', 'ship_build: the length rule is unchanged');
reset role;
select is((select status::text from public.builds where battle_id = :'solo'), 'draft',
  'a refused name leaves the build a draft');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.ship_build(:'solo', 'Peacock Pomodoro', '{}') -> 'build' ->> 'name', 'Peacock Pomodoro',
  'ship_build: an innocent name ships');
reset role;
select throws_ok($$ select private.check_name_allowed('fuck', 'build') $$, '22023', 'name_not_allowed',
  'check_name_allowed raises for builds too');

select * from finish();
rollback;
