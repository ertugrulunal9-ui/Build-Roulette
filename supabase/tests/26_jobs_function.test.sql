-- The jobs Edge Function's SQL (T-034, 20261009120000_jobs_function.sql): the daily
-- Browser Rendering budget (browser_budget_reserve / browser_budget_settle), the pg_cron
-- trigger private.run_jobs_function (pg_net + Vault) and the grants. The schedule itself is
-- in 09_sweeps.test.sql; EXECUTE grants per role are also in 04_functions.test.sql.

begin;
create extension if not exists pgtap with schema extensions;

select plan(34);

-- A clean slate inside this transaction (rolled back): no budget rows, no jobs, no secrets.
delete from private.browser_budget;
delete from public.jobs;
delete from vault.secrets where name in ('br_jobs_function_url', 'br_jobs_cron_secret');

-- ─── Grants (6) ───────────────────────────────────────────────────────────
select ok(not has_table_privilege('anon', 'private.browser_budget', 'select')
          and not has_table_privilege('authenticated', 'private.browser_budget', 'select')
          and not has_table_privilege('service_role', 'private.browser_budget', 'select,insert,update,delete'),
  'no API role reaches private.browser_budget');
select ok(has_function_privilege('service_role', 'public.browser_budget_reserve(int, int)', 'execute')
          and has_function_privilege('service_role', 'public.browser_budget_settle(date, int, int, boolean)', 'execute'),
  'service_role can reserve and settle');
select ok(not has_function_privilege('authenticated', 'public.browser_budget_reserve(int, int)', 'execute')
          and not has_function_privilege('anon', 'public.browser_budget_settle(date, int, int, boolean)', 'execute'),
  'players cannot touch the budget');
select ok(not has_function_privilege('service_role', 'private.run_jobs_function()', 'execute')
          and not has_function_privilege('authenticated', 'private.run_jobs_function()', 'execute'),
  'only pg_cron (the owner) runs the trigger');
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pg_net'), 'extensions',
  'pg_net is installed (in extensions, as on Supabase)');
select ok(to_regclass('vault.decrypted_secrets') is not null, 'Vault is available');

-- ─── Reserve and settle (17) ──────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.browser_budget_reserve(20000, 570000) as r1 \gset
select is((:'r1'::jsonb) ->> 'granted', 'true', 'reserve: granted on an empty day');
select is((:'r1'::jsonb) ->> 'day', ((now() at time zone 'utc')::date)::text, 'reserve: the day is the UTC date');
select is((:'r1'::jsonb) -> 'reserved_ms', '20000'::jsonb, 'reserve: 20 s reserved');

select public.browser_budget_settle((:'r1'::jsonb ->> 'day')::date, 20000, 3500, false);
reset role;
select results_eq(
  $$ select used_ms, reserved_ms, renders, refused, rate_limited from private.browser_budget $$,
  $$ values (3500::bigint, 0::bigint, 1, 0, 0) $$,
  'settle: the reservation is released and the billed time added');

set local role service_role;
select is((public.browser_budget_reserve(20000, 23500)) ->> 'granted', 'true',
  'reserve: granted when it fills the day exactly (3.5 + 20 = 23.5 s)');
select is((public.browser_budget_reserve(1, 23500)) ->> 'granted', 'false',
  'reserve: refused one millisecond over the limit');
select is((public.browser_budget_reserve(20000, 23500)) -> 'reserved_ms', '20000'::jsonb,
  'reserve: a refusal reserves nothing');
reset role;
select is((select refused from private.browser_budget), 2, 'the refusals are counted');

set local role service_role;
select public.browser_budget_settle((now() at time zone 'utc')::date, 20000, 0, true);
reset role;
select results_eq(
  $$ select used_ms, reserved_ms, renders, rate_limited from private.browser_budget $$,
  $$ values (3500::bigint, 0::bigint, 1, 1) $$,
  'a 429 settles with no browser time and is counted as rate limited');

-- A reservation nobody settled (the run died): after 2 minutes it counts as used.
set local role service_role;
select public.browser_budget_reserve(20000, 570000);
reset role;
update private.browser_budget set reserved_until = now() - interval '1 second';
set local role service_role;
select public.browser_budget_reserve(15000, 570000) as r2 \gset
reset role;
select is((:'r2'::jsonb) -> 'used_ms', '23500'::jsonb, 'a stale reservation becomes used (3.5 + 20 s)');
select is((:'r2'::jsonb) -> 'reserved_ms', '15000'::jsonb, 'and only the new reservation is held');
select ok((select reserved_until > now() from private.browser_budget), 'the new reservation expires later');

-- The day is UTC whatever the session's time zone (the free plan resets at 00:00 UTC).
set local timezone = 'Pacific/Kiritimati';
set local role service_role;
select is((public.browser_budget_reserve(1, 570000)) ->> 'day', ((now() at time zone 'utc')::date)::text,
  'the day is UTC in a UTC+14 session too');
select public.browser_budget_settle('2000-01-01', 10, 5, false);
reset role;
reset timezone;
select results_eq(
  $$ select used_ms, reserved_ms from private.browser_budget where day = '2000-01-01' $$,
  $$ values (5::bigint, 0::bigint) $$,
  'settling a day without a row creates it (a reservation made before midnight)');

set local role service_role;
select throws_ok($$ select public.browser_budget_reserve(0, 570000) $$, '22023', 'invalid_reserve_ms',
  'reserve: the reservation must be positive');
select throws_ok($$ select public.browser_budget_reserve(1000, -1) $$, '22023', 'invalid_limit_ms',
  'reserve: the limit must not be negative');
select throws_ok($$ select public.browser_budget_settle(null, 1, 1, false) $$, '22023', 'invalid_settlement',
  'settle: the day is required');
select throws_ok($$ select public.browser_budget_settle('2026-10-09', 1, -5, false) $$, '22023', 'invalid_settlement',
  'settle: the browser time must not be negative');
reset role;

-- ─── The trigger (10) ─────────────────────────────────────────────────────
select is(private.run_jobs_function(), null, 'no job due: nothing is sent');

insert into public.jobs (kind, ref_id, run_after) values ('destroy', gen_random_uuid(), now() + interval '1 minute');
insert into public.jobs (kind, ref_id, status, attempts) values ('destroy', gen_random_uuid(), 'running', 5);
insert into public.jobs (kind, ref_id, status) values ('capture', gen_random_uuid(), 'done');
select is(private.run_jobs_function(), null,
  'jobs in backoff, out of attempts or done are not due: nothing is sent');

insert into public.jobs (kind, ref_id) values ('takedown', gen_random_uuid());
select is(private.run_jobs_function(), null, 'a job is due but the Vault secrets are not set: nothing is sent');

select vault.create_secret('https://ref.supabase.co/functions/v1/jobs', 'br_jobs_function_url');
select is(private.run_jobs_function(), null, 'the URL alone is not enough');
select vault.create_secret('cron-secret-0123456789abcdef0123456789abcdef', 'br_jobs_cron_secret');

select private.run_jobs_function() as request_id \gset
select ok(:'request_id' is not null, 'a job is due and both secrets are set: a request is queued');
select is((select url from net.http_request_queue where id = :request_id),
  'https://ref.supabase.co/functions/v1/jobs', 'to the function URL from Vault');
select is((select method::text from net.http_request_queue where id = :request_id), 'POST', 'as a POST');
select is((select headers ->> 'x-br-cron-secret' from net.http_request_queue where id = :request_id),
  'cron-secret-0123456789abcdef0123456789abcdef', 'with the cron secret from Vault');
select is((select timeout_milliseconds from net.http_request_queue where id = :request_id), 10000,
  'with a 10 s timeout (the function answers 202 at once)');
select ok((select position('service_role' in coalesce(headers::text, '')) = 0
             and not (headers ? 'authorization') from net.http_request_queue where id = :request_id),
  'never with a service key or a JWT');

select * from finish();
rollback;
