-- T-051: the import_url rate limit (20 per 10 minutes per user) and public.claim_import_url,
-- which the import-url Edge Function calls as the user (docs/10 §10.3).

begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

\set eve '{"sub":"28a00000-0000-0000-0000-000000000001","role":"authenticated","is_anonymous":true}'
\set fay '{"sub":"28a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set eve_id '28a00000-0000-0000-0000-000000000001'
\set fay_id '28a00000-0000-0000-0000-000000000002'
insert into auth.users (id, is_anonymous)
values (:'eve_id', true), (:'fay_id', false);

create function pg_temp.events(p_user uuid) returns int language sql as $$
  select count(*)::int from private.rate_events where user_id = p_user and action = 'import_url'
$$;
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare v_m text; v_d text; v_h text; v_s text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_s = returned_sqlstate, v_m = message_text, v_d = pg_exception_detail,
                          v_h = pg_exception_hint;
  return jsonb_build_object('code', v_s, 'message', v_m, 'details', v_d, 'hint', v_h);
end;
$$;

-- ─── The configuration (1) ────────────────────────────────────────────────
select results_eq(
  $$ select max_count, window_s, label from private.rate_limits where action = 'import_url' $$,
  $$ values (20, 600, 'site links') $$,
  'import_url: 20 per 10 minutes (mirrored by @br/game RATE_LIMITS)');

-- ─── Grants (2) ───────────────────────────────────────────────────────────
select ok(has_function_privilege('authenticated', 'public.claim_import_url()', 'EXECUTE'),
  'authenticated can claim a slot');
select ok(not has_function_privilege('anon', 'public.claim_import_url()', 'EXECUTE'),
  'anon cannot (the anon key alone is no session)');

-- ─── The limit (8) ────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select lives_ok($$ select public.claim_import_url() from generate_series(1, 20) $$,
  'an anonymous player can import 20 links in a row');
reset role;
select is(pg_temp.events(:'eve_id'), 20, 'each claim is counted');

set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select throws_ok($$ select public.claim_import_url() $$, 'PT429', 'rate_limited',
  'the 21st within 10 minutes is refused (SQLSTATE PT429 → HTTP 429)');
reset role;
select is(pg_temp.events(:'eve_id'), 20, 'a refused claim is not counted');

-- The hint says when the oldest claim leaves the window.
update private.rate_events set created_at = now() - interval '500 seconds'
 where user_id = :'eve_id' and action = 'import_url';
-- (As the owner, with eve's claims: pg_temp is not the authenticated role's.)
select set_config('request.jwt.claims', :'eve', true);
select is(pg_temp.err($$ select public.claim_import_url() $$),
  '{"code":"PT429","message":"rate_limited","details":"You sent too many site links recently. Try again in 100 seconds.","hint":"{\"retry_after_s\": 100}"}'::jsonb,
  'details for people, hint {"retry_after_s": n} for the function');

-- Another user is not limited.
set local role authenticated;
select set_config('request.jwt.claims', :'fay', true);
select lives_ok($$ select public.claim_import_url() $$, 'limits are per user');
reset role;

-- Ten minutes later the slots are free again.
update private.rate_events set created_at = now() - interval '601 seconds'
 where user_id = :'eve_id' and action = 'import_url';
set local role authenticated;
select set_config('request.jwt.claims', :'eve', true);
select lives_ok($$ select public.claim_import_url() $$, 'after the window: allowed again');
reset role;
select is(pg_temp.events(:'eve_id'), 1, 'the expired claims were pruned');

-- ─── Without a user (1) ───────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.claim_import_url() $$, '42501', 'not_authenticated',
  'no user id in the token: not_authenticated');
reset role;

select * from finish();
rollback;
