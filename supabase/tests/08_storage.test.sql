-- Storage buckets and the RLS policies on storage.objects (docs/05 §5.5),
-- exercised with real INSERT/SELECT/UPDATE/DELETE statements as the API
-- roles, which is what the Storage API does on behalf of a request.
-- scripts/e2e-solo.mjs repeats the important cases through the Storage REST
-- API (size limit, MIME types, upsert, public screenshot URL).
--
-- Cast: liam (plays), mia (a stranger with her own battle in SPINNING).

begin;
create extension if not exists pgtap with schema extensions;

select plan(35);

\set liam '{"sub":"8a000000-0000-0000-0000-000000000001","role":"authenticated"}'
\set mia  '{"sub":"8a000000-0000-0000-0000-000000000002","role":"authenticated"}'
\set liam_id '8a000000-0000-0000-0000-000000000001'
\set mia_id  '8a000000-0000-0000-0000-000000000002'

insert into auth.users (id, is_anonymous) values (:'liam_id', true), (:'mia_id', true);

set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select public.start_solo_battle('liam', 300) as l_battle \gset
select set_config('request.jwt.claims', :'mia', true);
select public.start_solo_battle('mia', 300) as m_battle \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'l_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select public.advance_battle(:'l_battle', 1) ->> 'phase' as l_phase \gset
reset role;

-- liam's folder: {battle_id}/{user_id}
\set lp :l_battle '/' :liam_id

select is(:'l_phase'::text, 'building', 'fixture: liam is BUILDING');

-- ─── Buckets (2) ──────────────────────────────────────────────────────────
select results_eq(
  $$ select id collate "default", public, file_size_limit, allowed_mime_types from storage.buckets
     where id in ('ephemeral-builds', 'screenshots') order by id $$,
  $$ values ('ephemeral-builds', false, 5242880::bigint,
             array['application/json', 'text/javascript', 'text/css', 'image/webp']),
            ('screenshots', true, 2097152::bigint, array['image/webp', 'image/png']) $$,
  'ephemeral-builds is private (5 MB, json/js/css/webp); screenshots is public (2 MB, webp/png)');

select results_eq(
  $$ select cmd collate "default", array_to_string(roles, ',') collate "default",
            coalesce(qual, with_check) like '%ephemeral-builds%'
     from pg_policies where schemaname = 'storage' and tablename = 'objects' order by cmd $$,
  $$ values ('INSERT', 'authenticated', true),
            ('SELECT', 'authenticated', true),
            ('UPDATE', 'authenticated', true) $$,
  'storage.objects has exactly an INSERT, a SELECT and an UPDATE policy, for authenticated, on ephemeral-builds only');

-- ─── Owner writes while BUILDING (9) ──────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select lives_ok(
  format($$ insert into storage.objects (bucket_id, name, owner_id)
            select 'ephemeral-builds', %L || '/' || f, %L
            from unnest(array['source.json', 'bundle.js', 'bundle.css', 'thumb.webp',
                              'autosave/source.json', 'autosave/bundle.js', 'autosave/bundle.css']) f $$, :'lp', :'liam_id'),
  'the owner can create all seven allowed files under {battle}/{uid}/ while BUILDING');

select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'lp' || '/index.html'),
  '42501', null, 'any other file name is refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'lp' || '/autosave/old/bundle.js'),
  '42501', null, 'deeper paths are refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'l_battle' || '/bundle.js'),
  '42501', null, 'a file without the user folder is refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'l_battle' || '/' || :'mia_id' || '/bundle.js'),
  '42501', null, 'writing under another user''s folder is refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        upper(:'l_battle') || '/' || :'liam_id' || '/bundle.js'),
  '42501', null, 'a non-canonical (uppercase) battle id is refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        gen_random_uuid() || '/' || :'liam_id' || '/bundle.js'),
  '42501', null, 'an unknown battle is refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('screenshots', %L) $$,
                        :'l_battle' || '/x.webp'),
  '42501', null, 'clients cannot write to screenshots');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        'not-a-uuid/' || :'liam_id' || '/bundle.js'),
  '42501', null, 'a malformed battle id is refused (not an error)');
reset role;

-- ─── Strangers (2) ────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'mia', true);
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'l_battle' || '/' || :'mia_id' || '/bundle.js'),
  '42501', null, 'a player not on the roster cannot write into the battle, even under her own folder');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'m_battle' || '/' || :'mia_id' || '/bundle.js'),
  '42501', null, 'no writes while her own battle is SPINNING');
reset role;

-- ─── Reads (5) ────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select is((select count(*)::int from storage.objects where bucket_id = 'ephemeral-builds'), 7,
  'the owner reads their own files');
select set_config('request.jwt.claims', :'mia', true);
select is((select count(*)::int from storage.objects where bucket_id = 'ephemeral-builds'), 0,
  'another player reads nothing (M2: no reveal, so no reads by battle members)');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from storage.objects), 0, 'anon reads nothing');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'lp' || '/bundle.js'),
  '42501', null, 'anon cannot write');
reset role;
insert into storage.objects (bucket_id, name) values ('screenshots', :'l_battle' || '/shot.webp');
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select is((select count(*)::int from storage.objects where bucket_id = 'screenshots'), 0,
  'screenshot rows are not listable through RLS (the public URL does not need it)');
reset role;

-- ─── Overwrite (upsert) and delete (4) ────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
with u as (
  update storage.objects set user_metadata = '{"v": 2}'
  where bucket_id = 'ephemeral-builds' and name = :'lp' || '/autosave/bundle.js'
  returning 1)
select count(*) as n from u \gset
select is(:n, 1, 'the owner can overwrite an autosave while BUILDING');
select throws_ok(
  format($$ update storage.objects set name = %L where bucket_id = 'ephemeral-builds' and name = %L $$,
         :'lp' || '/index.html', :'lp' || '/autosave/bundle.js'),
  '42501', null, '...but cannot rename it to a path outside the rules (WITH CHECK)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'mia', true);
with u as (
  update storage.objects set user_metadata = '{"pwned": true}'
  where bucket_id = 'ephemeral-builds'
  returning 1)
select count(*) as n from u \gset
select is(:n, 0, 'another player cannot overwrite the owner''s files');
-- Supabase blocks direct DELETEs with a trigger; lift it to see RLS alone.
select set_config('storage.allow_delete_query', 'true', true);
select set_config('request.jwt.claims', :'liam', true);
with d as (delete from storage.objects where bucket_id = 'ephemeral-builds' returning 1)
select count(*) as n from d \gset
select is(:n, 0, 'the owner cannot delete files (no DELETE policy; the destroy-worker deletes)');
reset role;

-- ─── Deadline (5) ─────────────────────────────────────────────────────────
-- 10 s after the build deadline, still in BUILDING (nobody nudged): grace.
update public.battles
   set building_ends_at = now() - interval '10 seconds', phase_ends_at = now() - interval '10 seconds'
 where id = :'l_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select ok(public.can_write_build_object(:'lp' || '/bundle.js'), 'writes are allowed inside the 15 s grace');
reset role;
update public.battles set phase = 'shipping', phase_ends_at = now() + interval '5 seconds'
 where id = :'l_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select ok(public.can_write_build_object(:'lp' || '/bundle.js'), 'writes are allowed during SHIPPING (grace)');
reset role;
update public.battles set building_ends_at = now() - interval '16 seconds' where id = :'l_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'lp' || '/thumb.webp'),
  '42501', null, 'after building_ends_at + grace, inserts are refused');
with u as (
  update storage.objects set user_metadata = '{"late": true}'
  where bucket_id = 'ephemeral-builds' and name = :'lp' || '/autosave/bundle.js'
  returning 1)
select count(*) as n from u \gset
select is(:n, 0, 'after building_ends_at + grace, overwrites are refused');
select is((select count(*)::int from storage.objects where bucket_id = 'ephemeral-builds'), 7,
  'the owner still reads their files after the deadline');
reset role;

-- ─── After ship (3) ───────────────────────────────────────────────────────
update public.battles
   set building_ends_at = now() + interval '60 seconds', phase = 'building', phase_ends_at = now() + interval '60 seconds'
 where id = :'l_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'liam', true);
select is(public.ship_build(:'l_battle', 'Done', '{}') -> 'build' ->> 'status', 'shipped', 'liam ships');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
                        :'lp' || '/thumb.webp'),
  '42501', null, 'nothing can be written after ship (the build is final)');
select is((select count(*)::int from storage.objects where bucket_id = 'ephemeral-builds'), 7,
  'the owner still reads their files after ship');
reset role;

-- ─── Service role (2) ─────────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('screenshots', %L) $$,
                       :'l_battle' || '/' || gen_random_uuid() || '.webp'),
  'the service role writes screenshots');
select is((select count(*)::int from storage.objects where bucket_id = 'ephemeral-builds'
           and name like :'l_battle' || '/%'), 7,
  'the service role reads every ephemeral file (capture and destroy workers)');
reset role;

-- ─── The helper itself (2) ────────────────────────────────────────────────
select ok(not public.can_write_build_object(:'lp' || '/bundle.js'),
  'can_write_build_object is false without a user');
select ok(not public.can_write_build_object(null), 'can_write_build_object(null) is false');

select * from finish();
rollback;
