-- Build Roulette: storage buckets and storage RLS (docs/05 §5.5).
--
-- ephemeral-builds (private)
--   {battle_id}/{user_id}/source.json | bundle.js | bundle.css | thumb.webp
--   {battle_id}/{user_id}/autosave/source.json | autosave/bundle.js
--   Written by the owner through storage RLS, only while their build is still
--   a draft, the battle is in BUILDING or SHIPPING, and
--   now() <= building_ends_at + shipping grace. Any other file name is
--   refused, so a player cannot use the bucket as free file hosting.
--   Read by the owner (any time, until DESTROY deletes the prefix) and by the
--   service role (capture and destroy workers).
--   Other battle members read NOTHING in M2. Solo battles have no other
--   members, and the multiplayer read rule ("battle members once
--   phase >= reveal") arrives with REVEAL in M3.
--   No client deletes: the destroy-worker deletes through the Storage API.
--
-- screenshots (public, unguessable paths)
--   {battle_id}/{build_id}.webp (or .png)
--   Written by the service role only (no client policy at all). Read through
--   the public URL, which does not go through RLS.
--
-- Storage RLS policies apply to `authenticated` only. `anon` (no session) has
-- no policy, so it can neither read nor write either bucket through the API.

-- ─── Buckets ──────────────────────────────────────────────────────────────
-- Upsert so that re-applying (or an earlier manual bucket) converges on the
-- documented settings. Lifecycle columns are left alone (service-role only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('ephemeral-builds', 'ephemeral-builds', false, 5 * 1024 * 1024,
   array['application/json', 'text/javascript', 'text/css', 'image/webp']),
  -- DEVIATION from §5.5 (which only names .webp): PNG is allowed too, so the
  -- capture worker can store the renderer's PNG when it cannot transcode.
  ('screenshots', 'screenshots', true, 2 * 1024 * 1024,
   array['image/webp', 'image/png'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ─── Write guard ──────────────────────────────────────────────────────────
-- True when the caller may create or overwrite `p_name` in ephemeral-builds
-- right now. Same rule as ship_build's deadline (docs/04 §4.5): the battle is
-- in BUILDING or SHIPPING, the caller's build is still a draft (so the
-- caller is on the roster, and nothing changes after SHIP), and
-- now() <= building_ends_at + shipping grace.
--
-- In `public` (like the other RLS helpers) because the storage policies run
-- as `authenticated` and must be able to call it. It only answers a question
-- about the caller.
create function public.can_write_build_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
begin
  if v_uid is null or p_name is null then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  -- The battle id must be the canonical (lowercase) uuid text, so that one
  -- battle cannot have two prefixes that the destroy-worker might miss.
  if coalesce(array_length(v_parts, 1), 0) not in (3, 4)
     or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] <> v_uid::text
     or array_to_string(v_parts[3:], '/') not in (
          'source.json', 'bundle.js', 'bundle.css', 'thumb.webp',
          'autosave/source.json', 'autosave/bundle.js')
  then
    return false;
  end if;

  return exists (
    select 1
    from public.battles b
    join public.builds bu on bu.battle_id = b.id and bu.builder_id = v_uid
    where b.id = v_parts[1]::uuid
      and b.phase in ('building'::public.battle_phase, 'shipping'::public.battle_phase)
      and bu.status = 'draft'::public.build_status
      and now() <= b.building_ends_at + private.setting_interval(b.settings, 'shipping_s')
  );
end;
$$;

revoke all on function public.can_write_build_object(text) from public, anon;
grant execute on function public.can_write_build_object(text) to authenticated, service_role;

-- ─── Policies on storage.objects ──────────────────────────────────────────
create policy "ephemeral-builds: owner inserts own files while building"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ephemeral-builds'
    and public.can_write_build_object(name)
  );

-- Upserts (autosave overwrites) need UPDATE as well as SELECT on the row.
create policy "ephemeral-builds: owner overwrites own files while building"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'ephemeral-builds'
    and public.can_write_build_object(name)
  )
  with check (
    bucket_id = 'ephemeral-builds'
    and public.can_write_build_object(name)
  );

create policy "ephemeral-builds: owner reads own files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'ephemeral-builds'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- Deliberately absent: any DELETE policy, any policy on `screenshots`, and
-- any policy for `anon`.
