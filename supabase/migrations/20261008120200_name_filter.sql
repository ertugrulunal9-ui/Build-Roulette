-- Build Roulette (T-024, M5): a server-side filter for display names and build names
-- (docs/02 R9). `private.check_display_name` (create_room, join_room) and, in the next
-- migration, start_solo_battle and ship_build raise `name_not_allowed` (22023) for a name
-- the filter blocks.
--
-- ─── The list ─────────────────────────────────────────────────────────────
-- `private.blocked_terms` is a SMALL STARTING POINT (English and Turkish basics), meant to
-- be edited with SQL as moderation learns (service side only):
--   insert into private.blocked_terms (term, match, lang) values ('xyz', 'word', 'en');
-- Terms are stored already folded (lowercase a–z, see below).
--
-- ─── Normalisation (private.fold_name) ────────────────────────────────────
--   1. lowercase, with Turkish İ/I/ı → i;
--   2. diacritics removed (NFD, combining marks dropped: ü → u, ş → s, ç → c, é → e …),
--      plus ß → ss, æ → ae, œ → oe, ø → o, ł → l, đ → d;
--   3. leetspeak: 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s;
--   4. everything that is not a–z or 0–9 is a separator.
-- Repeated characters are not collapsed in the name. Instead each term becomes a regex in
-- which every run of k equal letters must appear at least k times (`ass` → a{1,}s{2,}),
-- so "fuuuck" matches `fuck` while "as" does not match `ass` (collapsing both sides would
-- make the innocent "as" equal to "ass", and "Niger" equal to a slur).
--
-- ─── Matching: word vs substring (the Scunthorpe problem) ─────────────────
-- Each term has a rule:
--   word       the term (with optional trailing s's: plurals) must be a WHOLE token: a
--              run of letters/digits between separators. Also tried against every run of
--              single-character tokens joined together ("a s s", "a.s.s") and against the
--              whole name with the separators removed. Used for short or ambiguous terms
--              that hide inside innocent words: "ass" (class, bass, assassin), "cunt"
--              (Scunthorpe), "rape" (grape), "rapist" (therapist), "cock" (peacock,
--              cockpit), "dick" (Dickens), "spic" (spice), "retard" (fire retardant).
--   substring  the term may appear anywhere in the name with the separators removed
--              ("xXfuckXx", "f.u.c.k", "f u c k"). Only for long, distinctive terms that no
--              common innocent word contains.
-- Known trade-offs: a word term glued to other letters ("myass") passes, and some terms
-- are left out because their folded form is an innocent word (Turkish "piç" folds to the
-- English "pic", "göt" to "got", "sık" (often) and "sik" fold together). The tests in
-- supabase/tests/19_name_filter.test.sql list the innocent words that must stay allowed.

create table private.blocked_terms (
  term       text primary key check (term ~ '^[a-z]{2,}$'),
  match      text not null check (match in ('word', 'substring')),
  lang       text not null check (lang in ('en', 'tr')),
  created_at timestamptz not null default now()
);
revoke all on private.blocked_terms from public, anon, authenticated, service_role;

-- A deliberately modest starting list.
insert into private.blocked_terms (term, match, lang) values
  -- English: substring (long, distinctive)
  ('fuck',        'substring', 'en'),
  ('nigger',      'substring', 'en'),
  ('faggot',      'substring', 'en'),
  ('asshole',     'substring', 'en'),
  ('bitch',       'substring', 'en'),
  ('whore',       'substring', 'en'),
  ('hitler',      'substring', 'en'),
  ('porn',        'substring', 'en'),
  -- English: whole words only (would hide inside innocent words)
  ('shit',        'word', 'en'),
  ('bullshit',    'word', 'en'),
  ('cunt',        'word', 'en'),
  ('nigga',       'word', 'en'),
  ('fag',         'word', 'en'),
  ('ass',         'word', 'en'),
  ('dick',        'word', 'en'),
  ('cock',        'word', 'en'),
  ('pussy',       'word', 'en'),
  ('slut',        'word', 'en'),
  ('rape',        'word', 'en'),
  ('rapist',      'word', 'en'),
  ('retard',      'word', 'en'),
  ('nazi',        'word', 'en'),
  ('kike',        'word', 'en'),
  ('spic',        'word', 'en'),
  ('chink',       'word', 'en'),
  ('twat',        'word', 'en'),
  ('wank',        'word', 'en'),
  ('wanker',      'word', 'en'),
  -- Turkish: substring
  ('orospu',      'substring', 'tr'),
  ('siktir',      'substring', 'tr'),
  ('sikerim',     'substring', 'tr'),
  ('sikeyim',     'substring', 'tr'),
  ('yarrak',      'substring', 'tr'),
  ('amcik',       'substring', 'tr'),
  ('aminakoyim',  'substring', 'tr'),
  ('aminakoyayim','substring', 'tr'),
  ('pezevenk',    'substring', 'tr'),
  -- Turkish: whole words only
  ('amk',         'word', 'tr'),
  ('aq',          'word', 'tr'),
  ('yarak',       'word', 'tr'),
  ('kahpe',       'word', 'tr'),
  ('gavat',       'word', 'tr'),
  ('ibne',        'word', 'tr'),
  ('serefsiz',    'word', 'tr')
on conflict (term) do nothing;

-- Steps 1–3 of the normalisation (separators are kept; the matcher splits on them).
create function private.fold_name(p_name text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v text := coalesce(p_name, '');
begin
  v := lower(translate(v, 'İIı', 'iii'));
  v := regexp_replace(normalize(v, NFD), '[̀-ͯ]', '', 'g');
  v := replace(replace(replace(v, 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe');
  v := translate(v, 'øłđ', 'old');
  -- By position: 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s.
  v := translate(v, '013457@$', 'oieastas');
  return v;
end;
$$;

-- The regex of a folded term: each run of k equal letters → letter{k,}.
create function private.term_regex(p_term text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select string_agg(m[2] || '{' || char_length(m[1]) || ',}', '' order by n)
  from regexp_matches(p_term, '(([a-z])\2*)', 'g') with ordinality as r(m, n)
$$;

-- The first blocked term the name contains (by the rules above), or null.
create function private.blocked_term(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folded text := private.fold_name(p_name);
  v_joined text := regexp_replace(v_folded, '[^a-z0-9]', '', 'g');
  v_tokens text[];
  v_words  text[];
  v_run    text := '';
  v_tok    text;
  v_term   text;
begin
  if v_joined = '' then
    return null;
  end if;
  v_tokens := array_remove(regexp_split_to_array(v_folded, '[^a-z0-9]+'), '');

  -- Candidates for whole-word terms: every token, every run of 2+ single-character tokens
  -- joined ("a s s" → "ass"), and the whole name without separators.
  v_words := v_tokens || v_joined;
  foreach v_tok in array v_tokens || array['']::text[] loop
    if char_length(v_tok) = 1 then
      v_run := v_run || v_tok;
    else
      if char_length(v_run) >= 2 then
        v_words := v_words || v_run;
      end if;
      v_run := '';
    end if;
  end loop;

  select t.term into v_term
  from private.blocked_terms t
  where (t.match = 'substring' and v_joined ~ private.term_regex(t.term))
     or (t.match = 'word' and exists (
           select 1 from unnest(v_words) w
           where w ~ ('^' || private.term_regex(t.term) || 's*$')))
  order by t.term
  limit 1;
  return v_term;
end;
$$;

-- Raises name_not_allowed when the filter blocks the name. p_kind: 'display' or 'build'
-- (only the sentence differs).
create function private.check_name_allowed(p_name text, p_kind text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.blocked_term(p_name) is not null then
    raise exception using errcode = '22023', message = 'name_not_allowed',
      detail = case when p_kind = 'build'
                    then 'That build name is not allowed. Pick another one.'
                    else 'That name is not allowed. Pick another one.' end;
  end if;
end;
$$;

-- ─── check_display_name (replaces T-016's) ────────────────────────────────
-- Same length and control-character rule, plus the filter. Now STABLE (it reads the term
-- table). Used by create_room and join_room; start_solo_battle uses it from the next
-- migration on.
create or replace function private.check_display_name(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 1 and 24 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_display_name',
      detail = 'The display name must be 1 to 24 characters.';
  end if;
  perform private.check_name_allowed(v_name, 'display');
  return v_name;
end;
$$;

revoke all on function private.fold_name(text)                from public, anon, authenticated, service_role;
revoke all on function private.term_regex(text)               from public, anon, authenticated, service_role;
revoke all on function private.blocked_term(text)             from public, anon, authenticated, service_role;
revoke all on function private.check_name_allowed(text, text) from public, anon, authenticated, service_role;
