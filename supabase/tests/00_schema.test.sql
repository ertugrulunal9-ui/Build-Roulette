-- Schema shape, RLS coverage and privileges.
-- The RLS/privilege checks query the catalog generically, so tables added by
-- later migrations are covered automatically.

begin;
create extension if not exists pgtap with schema extensions;

select plan(66);

-- ─── Tables (14) ──────────────────────────────────────────────────────────
select has_table('public'::name, t::name, format('table public.%s exists', t))
from unnest(array[
  'profiles', 'prompt_cards', 'challenges', 'rooms', 'room_members', 'battles',
  'battle_players', 'builds', 'vote_categories', 'votes', 'awards',
  'battle_events', 'jobs', 'reports'
]) as t;

-- ─── Enums (8 × 2) ────────────────────────────────────────────────────────
select has_enum('public'::name, e.name::name, format('enum public.%s exists', e.name))
from (values ('card_kind'), ('room_status'), ('member_role'), ('battle_phase'),
             ('build_status'), ('capture_status'), ('job_kind'), ('job_status')) as e(name);

select enum_has_labels('public', 'card_kind',      array['build', 'rule', 'style'], 'card_kind labels');
select enum_has_labels('public', 'room_status',    array['open', 'in_battle', 'closed'], 'room_status labels');
select enum_has_labels('public', 'member_role',    array['player', 'spectator'], 'member_role labels');
select enum_has_labels('public', 'battle_phase',
  array['spinning', 'building', 'shipping', 'reveal', 'voting', 'results', 'destroyed', 'abandoned'],
  'battle_phase labels (in order)');
select enum_has_labels('public', 'build_status',
  array['draft', 'shipped', 'auto_shipped', 'dnf', 'disqualified'], 'build_status labels');
select enum_has_labels('public', 'capture_status',
  array['pending', 'captured', 'fallback', 'failed'], 'capture_status labels');
select enum_has_labels('public', 'job_kind',       array['capture', 'destroy'], 'job_kind labels');
select enum_has_labels('public', 'job_status',     array['queued', 'running', 'done', 'failed'], 'job_status labels');

-- ─── Indexes from the draft (5) ───────────────────────────────────────────
select has_index('public', 'battles', 'battles_active_deadline_idx', 'battles_active_deadline_idx exists');
select has_index('public', 'battles', 'battles_room_idx', 'battles_room_idx exists');
select has_index('public', 'builds', 'builds_builder_history_idx', 'builds_builder_history_idx exists');
select has_index('public', 'battle_events', 'battle_events_battle_idx', 'battle_events_battle_idx exists');
select has_index('public', 'jobs', 'jobs_ready_idx', 'jobs_ready_idx exists');

-- ─── Extensions (1) ───────────────────────────────────────────────────────
select is(
  (select extnamespace::regnamespace::text from pg_extension where extname = 'pgcrypto'),
  'extensions',
  'pgcrypto is installed in the extensions schema'
);

-- ─── RLS coverage (3) ─────────────────────────────────────────────────────
select cmp_ok(
  (select count(*)::int from pg_class
   where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')),
  '>=', 14,
  'the generic checks below see all public tables'
);

select is_empty(
  $$ select relname from pg_class
     where relnamespace = 'public'::regnamespace
       and relkind in ('r', 'p')
       and not relrowsecurity $$,
  'RLS is enabled on every table in public'
);

select is_empty(
  $$ select relname from pg_class
     where relnamespace = 'public'::regnamespace
       and (relkind = 'm'
            or (relkind = 'v'
                and not coalesce(reloptions @> array['security_invoker=true'], false))) $$,
  'no public view bypasses RLS (views must be security_invoker, no matviews)'
);

-- ─── Policies (4) ─────────────────────────────────────────────────────────
select is_empty(
  $$ select tablename, policyname, cmd from pg_policies
     where schemaname = 'public' and cmd <> 'SELECT' $$,
  'no INSERT/UPDATE/DELETE/ALL policies anywhere in public'
);

select is_empty(
  $$ select tablename, policyname, roles from pg_policies
     where schemaname = 'public' and roles <> '{authenticated}'::name[] $$,
  'every policy applies to role authenticated only'
);

select is_empty(
  $$ select tablename from pg_policies
     where schemaname = 'public'
       and tablename in ('prompt_cards', 'battle_events', 'jobs') $$,
  'prompt_cards, battle_events and jobs have no policies'
);

select set_eq(
  $$ select tablename::text from pg_policies where schemaname = 'public' $$,
  array['profiles', 'challenges', 'rooms', 'room_members', 'battles', 'battle_players',
        'builds', 'vote_categories', 'votes', 'awards', 'reports'],
  'exactly the expected tables have a SELECT policy'
);

-- ─── Privileges (8) ───────────────────────────────────────────────────────
select is_empty(
  $$ select c.relname, p.priv
     from pg_class c
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                             'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (has_table_privilege('anon', c.oid, p.priv)
            or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                and has_any_column_privilege('anon', c.oid, p.priv))) $$,
  'anon has no privilege (table or column level) on any public table'
);

select is_empty(
  $$ select c.relname, p.priv
     from pg_class c
     cross join unnest(array['INSERT', 'UPDATE', 'DELETE',
                             'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (has_table_privilege('authenticated', c.oid, p.priv)
            or (p.priv in ('INSERT', 'UPDATE', 'REFERENCES')
                and has_any_column_privilege('authenticated', c.oid, p.priv))) $$,
  'authenticated has no write privilege (table or column level) on any public table'
);

select is_empty(
  $$ select c.relname
     from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and has_any_column_privilege('authenticated', c.oid, 'SELECT')
       and not exists (select 1 from pg_policies p
                       where p.schemaname = 'public' and p.tablename = c.relname
                         and p.cmd = 'SELECT') $$,
  'authenticated can only SELECT from tables that have a SELECT policy'
);

select set_eq(
  $$ select c.relname::text from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and has_table_privilege('authenticated', c.oid, 'SELECT') $$,
  array['profiles', 'challenges', 'rooms', 'room_members', 'battles', 'battle_players',
        'builds', 'vote_categories', 'votes', 'awards', 'reports'],
  'authenticated has SELECT on exactly the tables with policies'
);

select is_empty(
  $$ select c.relname, r.role
     from pg_class c
     cross join unnest(array['anon', 'authenticated']) as r(role)
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'S'
       and (has_sequence_privilege(r.role, c.oid, 'USAGE')
            or has_sequence_privilege(r.role, c.oid, 'SELECT')
            or has_sequence_privilege(r.role, c.oid, 'UPDATE')) $$,
  'anon and authenticated have no privilege on any public sequence'
);

select is_empty(
  $$ select c.relname
     from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and not has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE') $$,
  'service_role keeps full DML on every public table'
);

-- Tables created later by the migration role are not auto-granted to clients.
create table public.__probe_default_acl (x int);
select ok(
  not has_table_privilege('authenticated', 'public.__probe_default_acl', 'SELECT')
  and not has_table_privilege('authenticated', 'public.__probe_default_acl', 'INSERT')
  and not has_table_privilege('anon', 'public.__probe_default_acl', 'SELECT'),
  'default privileges: a new public table is not granted to anon/authenticated'
);
select ok(
  has_table_privilege('service_role', 'public.__probe_default_acl', 'SELECT, INSERT, UPDATE, DELETE'),
  'default privileges: a new public table is still granted to service_role'
);
drop table public.__probe_default_acl;

-- ─── RLS helper functions (3 × 5 = 15) ────────────────────────────────────
select is_definer('public', f, array['uuid'], format('%s is SECURITY DEFINER', f))
from unnest(array['is_room_member', 'is_battle_member', 'can_view_battle']::name[]) as f;

select volatility_is('public', f, array['uuid'], 'stable', format('%s is STABLE', f))
from unnest(array['is_room_member', 'is_battle_member', 'can_view_battle']::name[]) as f;

select is(
  (select proconfig from pg_proc
   where pronamespace = 'public'::regnamespace and proname = f),
  array['search_path=""'],
  format('%s pins search_path to empty', f)
)
from unnest(array['is_room_member', 'is_battle_member', 'can_view_battle']) as f;

select ok(
  not has_function_privilege('anon', format('public.%s(uuid)', f), 'EXECUTE'),
  format('anon cannot execute %s', f)
)
from unnest(array['is_room_member', 'is_battle_member', 'can_view_battle']) as f;

select ok(
  has_function_privilege('authenticated', format('public.%s(uuid)', f), 'EXECUTE'),
  format('authenticated can execute %s (needed by policies)', f)
)
from unnest(array['is_room_member', 'is_battle_member', 'can_view_battle']) as f;

select * from finish();
rollback;
