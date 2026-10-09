-- Build Roulette (T-034, free plan): capture, destroy and takedown jobs without an always-on
-- server. The Supabase Edge Function `jobs` (supabase/functions/jobs) processes the queue;
-- pg_cron starts it every minute through pg_net, and it renders screenshots with Cloudflare
-- Browser Rendering's REST API within a daily budget (Workers Free: 10 browser-minutes a
-- day). The self-hosted worker (apps/capture-worker) still works against the same queue.
--
-- ─── Who calls what ───────────────────────────────────────────────────────
--   pg_cron 'br-jobs-run' (every minute)
--     → private.run_jobs_function(): only when a job is due, net.http_post to the function
--       URL with the header x-br-cron-secret (both read from Supabase Vault)
--       → the function answers 202 and runs in the background (≤ ~110 s): claim_job,
--         Browser Rendering, Storage, complete_* / fail_job, browser_budget_*.
--
-- ─── The secret: Vault, not the service role key ──────────────────────────
-- The function URL is public; the cron secret is what lets a caller start a run. pg_cron
-- has to send it, so SQL has to read it:
--   * Vault (`vault.decrypted_secrets`) keeps it encrypted at rest and out of the
--     migration (git), of `cron.job.command` and of `cron.job_run_details`; it is the
--     pattern Supabase documents for pg_cron + Edge Functions.
--   * It is a narrow capability: a run only processes jobs that are due anyway, so a leak
--     costs function invocations, never data. The service role key in SQL would hand out
--     the whole database (it would also sit in plain text wherever the request is logged).
-- The function compares it with its own secret JOBS_CRON_SECRET in constant time. Set both
-- (apps/web/DEPLOY.md "Screenshots and jobs (Edge Function)"):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/jobs', 'br_jobs_function_url');
--   select vault.create_secret('<the same value as JOBS_CRON_SECRET>', 'br_jobs_cron_secret');
-- Without both secrets (a fresh database, the local stack) the cron job does nothing.
--
-- ─── The daily browser budget ─────────────────────────────────────────────
-- private.browser_budget: one row per UTC day. Before a render the function reserves a
-- worst case (browser_budget_reserve: granted while used + reserved + reserve <= limit);
-- afterwards it settles what the render was billed (browser_budget_settle). The limit is
-- the function's (BROWSER_BUDGET_MS_PER_DAY, default 570 000 ms = 9.5 min). A reservation
-- that is not settled within 2 minutes (the run died) is counted as used: we cannot know
-- what it cost, and the daily limit is a hard one at Cloudflare.

-- ─── Budget ───────────────────────────────────────────────────────────────
create table private.browser_budget (
  day            date primary key,              -- UTC
  used_ms        bigint not null default 0 check (used_ms >= 0),
  reserved_ms    bigint not null default 0 check (reserved_ms >= 0),
  -- The newest reservation's expiry: when it has passed, every reservation is stale.
  reserved_until timestamptz,
  renders        int not null default 0,        -- settled renders that used browser time
  refused        int not null default 0,        -- reservations refused: captures that fell back
  rate_limited   int not null default 0,        -- renders that ended on HTTP 429
  updated_at     timestamptz not null default now()
);
revoke all on private.browser_budget from public, anon, authenticated, service_role;

-- Reserves p_reserve_ms of today's (UTC) browser time if the day stays within p_limit_ms.
-- Returns {granted, day, used_ms, reserved_ms, limit_ms}. A refusal is counted.
create function public.browser_budget_reserve(p_reserve_ms int, p_limit_ms int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day     date := (now() at time zone 'utc')::date;
  b         private.browser_budget;
  v_granted boolean;
begin
  if p_reserve_ms is null or p_reserve_ms < 1 or p_reserve_ms > 600000 then
    raise exception using errcode = '22023', message = 'invalid_reserve_ms',
      detail = 'p_reserve_ms must be between 1 and 600000.';
  end if;
  if p_limit_ms is null or p_limit_ms < 0 or p_limit_ms > 86400000 then
    raise exception using errcode = '22023', message = 'invalid_limit_ms',
      detail = 'p_limit_ms must be between 0 and 86400000.';
  end if;

  insert into private.browser_budget (day) values (v_day) on conflict (day) do nothing;
  select * into b from private.browser_budget where day = v_day for update;

  -- Stale reservations (the run died between reserve and settle) count as used.
  if b.reserved_ms > 0 and b.reserved_until < now() then
    b.used_ms := b.used_ms + b.reserved_ms;
    b.reserved_ms := 0;
  end if;

  v_granted := b.used_ms + b.reserved_ms + p_reserve_ms <= p_limit_ms;
  if v_granted then
    b.reserved_ms := b.reserved_ms + p_reserve_ms;
    b.reserved_until := now() + interval '2 minutes';
  else
    b.refused := b.refused + 1;
  end if;

  update private.browser_budget
     set used_ms = b.used_ms, reserved_ms = b.reserved_ms, reserved_until = b.reserved_until,
         refused = b.refused, updated_at = now()
   where day = v_day;

  return jsonb_build_object('granted', v_granted, 'day', v_day, 'used_ms', b.used_ms,
                            'reserved_ms', b.reserved_ms, 'limit_ms', p_limit_ms);
end;
$$;

-- Settles a reservation of day p_day: releases p_reserved_ms and adds the browser time the
-- render was billed (0 for a 429, which starts no browser).
create function public.browser_budget_settle(
  p_day date, p_reserved_ms int, p_used_ms int, p_rate_limited boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_day is null or p_reserved_ms is null or p_reserved_ms < 0 or p_reserved_ms > 600000
     or p_used_ms is null or p_used_ms < 0 or p_used_ms > 3600000 then
    raise exception using errcode = '22023', message = 'invalid_settlement',
      detail = 'p_day is required; p_reserved_ms 0..600000, p_used_ms 0..3600000.';
  end if;
  insert into private.browser_budget (day) values (p_day) on conflict (day) do nothing;
  update private.browser_budget
     set reserved_ms  = greatest(reserved_ms - p_reserved_ms, 0),
         used_ms      = used_ms + p_used_ms,
         renders      = renders + (p_used_ms > 0)::int,
         rate_limited = rate_limited + coalesce(p_rate_limited, false)::int,
         updated_at   = now()
   where day = p_day;
end;
$$;

revoke all on function public.browser_budget_reserve(int, int)                  from public, anon, authenticated;
revoke all on function public.browser_budget_settle(date, int, int, boolean)    from public, anon, authenticated;
grant execute on function public.browser_budget_reserve(int, int)               to service_role;
grant execute on function public.browser_budget_settle(date, int, int, boolean) to service_role;

-- ─── The trigger: pg_cron → pg_net → the function ─────────────────────────
-- Calls the function when a job is due (queued or running with an expired lease, attempts
-- left: what claim_job hands out, minus its takedown/capture ordering). Returns the pg_net
-- request id, or null when nothing was sent: no job due, pg_net or Vault missing, or the
-- Vault secrets not set. The request is sent after the calling transaction commits.
-- pg_cron only; no API role can execute it (schema private).
create function private.run_jobs_function()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if not exists (select 1 from public.jobs
                 where status in ('queued', 'running') and run_after <= now() and attempts < 5) then
    return null;
  end if;
  if to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'br_jobs_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'br_jobs_cron_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;
  -- The function answers 202 at once and works in the background; 10 s covers a cold start.
  return net.http_post(
    url                  := v_url,
    body                 := '{}'::jsonb,
    headers              := jsonb_build_object('content-type', 'application/json',
                                               'x-br-cron-secret', v_secret),
    timeout_milliseconds := 10000);
end;
$$;

revoke all on function private.run_jobs_function() from public, anon, authenticated, service_role;

-- pg_net (Supabase installs it in `extensions`; it creates schema `net`) and the schedule.
-- Both are skipped with a NOTICE where the extension is missing, like the sweeps.
do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  else
    raise notice 'pg_net is not available: the jobs function is not called by pg_cron';
  end if;

  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule('br-jobs-run', '* * * * *', 'select private.run_jobs_function()');
  else
    raise notice 'pg_cron is not installed: br-jobs-run is not scheduled';
  end if;
end;
$$;
