-- Build Roulette (T-051, M7): the rate limit of the `import-url` Edge Function, which copies a
-- player's published site from its link into a site pack (docs/10 §10.3).
--
--   action      limit           counted                          used by
--   import_url  20 per 10 min   links the function starts to     claim_import_url (called by
--                               copy (a failed copy counts too)  supabase/functions/import-url)
--
-- @br/game `RATE_LIMITS` mirrors the seed (drift-tested), like the T-024 limits
-- (20261008120100_rate_limits.sql).
--
-- The function calls public.claim_import_url() AS THE USER: with the user's JWT and the anon
-- key, through PostgREST. That one round trip both verifies the session (PostgREST checks the
-- JWT; auth.uid() is the caller) and takes a slot, with the existing helper and its error:
-- SQLSTATE PT429 (HTTP 429), `hint` {"retry_after_s": n}. Without a user (the anon key alone)
-- the call is refused (not_authenticated, or no EXECUTE for anon). The function maps those to
-- its own 401 and 429 answers. A link the function refuses before copying (not a link, a host
-- that is not allowed) is checked before this call and costs no slot.

insert into private.rate_limits (action, max_count, window_s, label) values
  ('import_url', 20, 600, 'site links')
on conflict (action) do nothing;

-- Takes one import_url slot for the signed-in user (anonymous sign-ins too), or raises
-- not_authenticated (42501) / rate_limited (PT429).
create function public.claim_import_url()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.rate_limit('import_url', private.require_auth());
end;
$$;

revoke all on function public.claim_import_url() from public, anon;
grant execute on function public.claim_import_url() to authenticated;
