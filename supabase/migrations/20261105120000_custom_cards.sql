-- Build Roulette (T-053): custom cards. The host of a room may write the room's own BUILD,
-- RULE and STYLE cards and pick its build time limit. Four new room settings:
--
--   key            value                                   at start_battle
--   custom_build   text, 3–80 characters (see below)       the BUILD card's text
--   custom_rule    text, 3–80 characters                   the RULE card's text
--   custom_style   text, 3–80 characters                   the STYLE card's text
--   time_limit_s   one of private.build_time_limits_seconds()  the build time limit
--
-- Each one is optional: a card that is not set is drawn from the deck as before, and without
-- time_limit_s the limit is drawn from private.random_build_time_limits_seconds(). Like the
-- other settings they change only while the room is open, only by the host, and a key set to
-- null is removed. They stay for the next battles of the room until the host changes them.
--
-- A custom card's text is trimmed and its runs of whitespace become one space. It must be 3 to
-- 80 characters with no control characters (invalid_settings), and pass the name filter
-- (card_not_allowed): it is shown to every player and kept with the results, which are public.
-- The filter checks each word of the card on its own (plus runs of single characters, "f u c
-- k"), not the whole card with its spaces removed: across word boundaries a sentence makes
-- too many false matches ("who really" → "whoreally"). @br/game CUSTOM_CARD_LIMITS mirrors the
-- length limits (drift-tested).
--
-- In the challenge row a custom card has no card id (build_card_id etc. null) and no hint; its
-- text is in build_text etc., like a drawn card's snapshot. room_recent_cards and the solo draw
-- already skip null card ids.

-- ─── The filter, word by word ─────────────────────────────────────────────
-- The first blocked term in any word of p_text (words split on whitespace), or in any run of
-- 2+ one-character words joined, or null.
create function private.blocked_card_term(p_text text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_word text;
  v_run  text := '';
  v_term text;
begin
  foreach v_word in array regexp_split_to_array(coalesce(p_text, ''), '\s+') || array['']::text[] loop
    if char_length(v_word) = 1 then
      v_run := v_run || v_word;
      continue;
    end if;
    if char_length(v_run) >= 2 then
      v_term := private.blocked_term(v_run);
      if v_term is not null then
        return v_term;
      end if;
    end if;
    v_run := '';
    if v_word <> '' then
      v_term := private.blocked_term(v_word);
      if v_term is not null then
        return v_term;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

-- The cleaned text of a custom card, or raises invalid_settings / card_not_allowed (22023).
-- packages/game/src/schema-drift.test.ts reads the `between 3 and 80` below.
create function private.check_custom_card(p_key text, p_value jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if jsonb_typeof(p_value) <> 'string' then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = format('%s must be text.', p_key);
  end if;
  v := btrim(regexp_replace(p_value #>> '{}', '\s+', ' ', 'g'));
  if char_length(v) not between 3 and 80 or v ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = format('%s must be 3 to 80 characters.', p_key);
  end if;
  if private.blocked_card_term(v) is not null then
    raise exception using errcode = '22023', message = 'card_not_allowed',
      detail = 'That card is not allowed. Write another one.';
  end if;
  return v;
end;
$$;

revoke all on function private.blocked_card_term(text)        from public, anon, authenticated;
revoke all on function private.check_custom_card(text, jsonb) from public, anon, authenticated;

-- ─── Room settings (replaces T-019's) ─────────────────────────────────────
-- Host only, while the room is open. Merges p_settings into rooms.settings; a
-- key set to null is removed (back to the default). Accepted keys:
--   max_players    2–8, not below the current number of active players
--   reveal_slot_s  30–60 (seconds per build in REVEAL; default: the 300/n rule)
--   voting_s       30–180 (VOTING length; default 60)
--   reveal_vote    boolean: false skips REVEAL and VOTING (SHIPPING → RESULTS
--                  with M3 ranking by completion time); default true
--   custom_build, custom_rule, custom_style
--                  text (T-053): the room's own card, cleaned by
--                  private.check_custom_card; default: drawn from the deck
--   time_limit_s   one of private.build_time_limits_seconds() (T-053);
--                  default: drawn from private.random_build_time_limits_seconds()
-- Returns the new settings.
create or replace function public.update_room_settings(p_room_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  r         public.rooms;
  v_key     text;
  v_val     jsonb;
  v_num     numeric;
  v_new     jsonb;
  v_players int;
begin
  r := private.lock_room_for(p_room_id);
  perform private.require_active_member(p_room_id, v_uid);
  perform private.touch_member(p_room_id, v_uid);
  perform private.ensure_host(p_room_id, v_uid);
  select * into r from public.rooms where id = p_room_id;
  if r.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host can change the room settings.';
  end if;
  if r.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'wrong_room_state',
      detail = format('Settings can only change while the room is open (it is %s).', r.status);
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = 'settings must be a JSON object.';
  end if;

  v_new := r.settings;
  for v_key, v_val in select key, value from jsonb_each(p_settings) loop
    if v_key not in ('max_players', 'reveal_slot_s', 'voting_s', 'reveal_vote',
                     'custom_build', 'custom_rule', 'custom_style', 'time_limit_s') then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('Unknown setting %s.', v_key);
    end if;
    if v_val = 'null'::jsonb then
      v_new := v_new - v_key;
      continue;
    end if;
    if v_key = 'reveal_vote' then
      if jsonb_typeof(v_val) <> 'boolean' then
        raise exception using errcode = '22023', message = 'invalid_settings',
          detail = 'reveal_vote must be true or false.';
      end if;
      v_new := v_new || jsonb_build_object(v_key, v_val);
      continue;
    end if;
    if v_key in ('custom_build', 'custom_rule', 'custom_style') then
      v_new := v_new || jsonb_build_object(v_key, private.check_custom_card(v_key, v_val));
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'number' then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('%s must be a number.', v_key);
    end if;
    v_num := v_val::text::numeric;
    if v_num <> trunc(v_num)
       or (v_key = 'max_players' and v_num not between private.room_limit('min_players') and private.room_limit('max_players'))
       or (v_key = 'reveal_slot_s' and v_num not between private.reveal_vote_limit('reveal_slot_min_s')
                                                     and private.reveal_vote_limit('reveal_slot_max_s'))
       or (v_key = 'voting_s' and v_num not between private.reveal_vote_limit('voting_min_s')
                                                and private.reveal_vote_limit('voting_max_s'))
       or (v_key = 'time_limit_s' and not v_num = any (private.build_time_limits_seconds())) then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('%s is out of range.', v_key);
    end if;
    v_new := v_new || jsonb_build_object(v_key, v_num::int);
  end loop;

  select count(*) into v_players from public.room_members
  where room_id = p_room_id and role = 'player' and left_at is null and kicked_at is null;
  if private.room_max_players(v_new) < v_players then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = format('The room already has %s players.', v_players);
  end if;

  if v_new is distinct from r.settings then
    update public.rooms set settings = v_new where id = p_room_id;
    perform private.room_bump(p_room_id, 'settings', v_uid, jsonb_build_object('settings', v_new));
    perform private.fill_player_slots(p_room_id, v_uid);
  end if;
  return v_new;
end;
$$;

-- ─── start_battle (replaces T-046's) ──────────────────────────────────────
-- Unchanged except for the room's custom cards and time limit (T-053): the deck draw runs as
-- before, then each custom card replaces the drawn card of its kind in the new challenge
-- (no card id, no hint). A time_limit_s that is no longer allowed falls back to the draw.
create or replace function public.start_battle(p_room_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := private.require_auth();
  r           public.rooms;
  v_roster    uuid[];
  v_limit     int;
  v_challenge uuid;
  v_settings  jsonb;
  v_battle    uuid;
  v_user      uuid;
begin
  r := private.lock_room_for(p_room_id);
  perform private.require_active_member(p_room_id, v_uid);
  perform private.touch_member(p_room_id, v_uid);
  perform private.ensure_host(p_room_id, v_uid);
  select * into r from public.rooms where id = p_room_id;
  if r.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host can start the battle.';
  end if;
  if r.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'wrong_room_state',
      detail = format('A battle can only start while the room is open (it is %s).', r.status);
  end if;

  select coalesce(array_agg(user_id order by joined_at, user_id), '{}') into v_roster
  from (
    select m.user_id, m.joined_at
    from public.room_members m
    where m.room_id = p_room_id
      and m.role = 'player'
      and m.is_ready
      and private.is_present(m)
    order by m.joined_at, m.user_id
    limit private.room_max_players(r.settings)
  ) ready;
  if cardinality(v_roster) < private.room_limit('min_players') then
    raise exception using errcode = 'P0001', message = 'not_enough_players',
      detail = format('%s ready players are needed; %s are ready and here.',
                      private.room_limit('min_players'), cardinality(v_roster));
  end if;

  -- T-053: the host's time limit, else 10, 15 or 20 minutes (T-046).
  v_limit := (r.settings ->> 'time_limit_s')::int;
  if v_limit is null or not v_limit = any (private.build_time_limits_seconds()) then
    v_limit := private.draw_build_time_limit();
  end if;
  v_challenge := private.draw_challenge_avoiding(private.room_recent_cards(p_room_id, v_roster), v_limit);

  -- T-053: the host's own cards replace the drawn ones.
  if r.settings ?| array['custom_build', 'custom_rule', 'custom_style'] then
    update public.challenges c
       set build_card_id = case when r.settings ? 'custom_build' then null else c.build_card_id end,
           build_text    = coalesce(r.settings ->> 'custom_build', c.build_text),
           build_hint    = case when r.settings ? 'custom_build' then null else c.build_hint end,
           rule_card_id  = case when r.settings ? 'custom_rule' then null else c.rule_card_id end,
           rule_text     = coalesce(r.settings ->> 'custom_rule', c.rule_text),
           rule_hint     = case when r.settings ? 'custom_rule' then null else c.rule_hint end,
           style_card_id = case when r.settings ? 'custom_style' then null else c.style_card_id end,
           style_text    = coalesce(r.settings ->> 'custom_style', c.style_text),
           style_hint    = case when r.settings ? 'custom_style' then null else c.style_hint end
     where c.id = v_challenge;
  end if;

  v_settings  := private.default_battle_settings()
              || jsonb_build_object(
                   'mode', 'multiplayer',
                   'reveal_vote', coalesce((r.settings ->> 'reveal_vote')::boolean,
                                           private.reveal_vote_default()))
              || jsonb_strip_nulls(jsonb_build_object(
                   'reveal_slot_s', r.settings -> 'reveal_slot_s',
                   'voting_s', r.settings -> 'voting_s'));

  insert into public.battles (room_id, challenge_id, host_id, phase, version,
                              phase_started_at, phase_ends_at, settings)
  values (p_room_id, v_challenge, v_uid, 'spinning', 0,
          now(), now() + private.setting_interval(v_settings, 'spinning_s'), v_settings)
  returning id into v_battle;

  insert into public.battle_players (battle_id, user_id, display_name)
  select v_battle, p.id, p.display_name
  from public.profiles p
  where p.id = any (v_roster);

  insert into public.builds (battle_id, builder_id)
  select v_battle, u from unnest(v_roster) as u;

  perform private.bump(v_battle, 'phase', v_uid,
    jsonb_build_object('from', null, 'to', 'spinning', 'mode', 'multiplayer',
                       'challenge_id', v_challenge, 'roster', to_jsonb(v_roster)));

  update public.rooms set status = 'in_battle', current_battle_id = v_battle where id = p_room_id;
  perform private.room_bump(p_room_id, 'battle_started', v_uid, jsonb_build_object('battle_id', v_battle));

  for v_user in
    select m.user_id from public.room_members m
    where m.room_id = p_room_id and m.is_ready
    order by m.joined_at, m.user_id
  loop
    update public.room_members set is_ready = false where room_id = p_room_id and user_id = v_user;
    perform private.room_bump(p_room_id, 'member_ready', null,
      jsonb_build_object('user_id', v_user, 'is_ready', false));
  end loop;

  return v_battle;
end;
$$;
