#!/usr/bin/env node
// Realtime proof for T-016, against the real local Realtime service with
// @supabase/supabase-js:
//   * members receive the database broadcasts of room:{id} and battle:{id} in order, with
//     gap-free versions;
//   * a non-member's subscription to a private topic is refused, and a public channel with
//     the same name receives none of the database broadcasts;
//   * Presence works for active members and is refused for a member who left;
//   * client broadcast sends are dropped (only the database broadcasts);
//   * a kicked member cannot subscribe again.
//
//   node supabase/scripts/e2e-realtime.mjs
//
// Needs `supabase start` WITH realtime, `psql` on PATH and `pnpm install` (supabase-js is
// resolved from apps/web). Commits data (users, a room, a battle). VERBOSE=1 prints details.

import {
  check,
  finish,
  isRun,
  newPlayer,
  payloads,
  rpc,
  sleep,
  sql,
  subscribe,
  waitFor,
} from './lib.mjs';

const roomVersion = (roomId) =>
  Number(sql(`select version from public.rooms where id = '${roomId}'`));
const battleVersion = (battleId) =>
  Number(sql(`select version from public.battles where id = '${battleId}'`));
const versionsOf = (sub) => payloads(sub).map((p) => p.version);

const alice = await newPlayer('alice');
const bob = await newPlayer('bob');
const carol = await newPlayer('carol');
const dave = await newPlayer('dave');
const mallory = await newPlayer('mallory');
console.log(`# alice ${alice.id}, bob ${bob.id}, carol ${carol.id}, dave ${dave.id}`);

// ─── Room topic ──────────────────────────────────────────────────────────
const created = await rpc(alice, 'create_room', { p_display_name: 'alice' });
check('alice creates a room', !created.error, created);
const roomId = created.data.room_id;
const code = created.data.code;
const roomTopic = `room:${roomId}`;
const joined = await rpc(bob, 'join_room', { p_code: code, p_display_name: 'bob' });
check('bob joins it', joined.data?.role === 'player', joined);

const aRoom = await subscribe(alice, roomTopic);
const bRoom = await subscribe(bob, roomTopic);
check('a member subscribes to the private room topic', aRoom.status === 'SUBSCRIBED', aRoom);
check('another member too', bRoom.status === 'SUBSCRIBED', bRoom);

const mRoom = await subscribe(mallory, roomTopic);
check(
  "a non-member's subscription to the private room topic is refused",
  mRoom.status === 'CHANNEL_ERROR' && /unauthori[sz]ed|permission/i.test(mRoom.error ?? ''),
  { status: mRoom.status, error: mRoom.error },
);
// supabase-js keeps one channel object per topic name: drop the refused one first.
await mallory.client.removeChannel(mRoom.channel);
const mPublic = await subscribe(mallory, roomTopic, { isPrivate: false });
check(
  'a public channel with the same name can be joined (Realtime allows public channels locally)',
  mPublic.status === 'SUBSCRIBED',
  mPublic.status,
);

{
  const from = roomVersion(roomId) + 1;
  await rpc(bob, 'set_ready', { p_room_id: roomId, p_ready: true });
  await rpc(alice, 'set_ready', { p_room_id: roomId, p_ready: true });
  await rpc(alice, 'update_room_settings', { p_room_id: roomId, p_settings: { max_players: 6 } });
  await rpc(bob, 'set_ready', { p_room_id: roomId, p_ready: false });
  await rpc(bob, 'set_ready', { p_room_id: roomId, p_ready: true });
  const to = roomVersion(roomId);
  const want = to - from + 1;
  await waitFor(() => aRoom.events.length >= want && bRoom.events.length >= want);
  check(
    `alice receives room versions ${from}..${to} in order, gap-free`,
    isRun(versionsOf(aRoom), from, to),
    versionsOf(aRoom),
  );
  check('bob receives the same sequence', isRun(versionsOf(bRoom), from, to), versionsOf(bRoom));
  const [first] = payloads(aRoom);
  check(
    'a member event carries only small fields',
    first?.type === 'member' &&
      first.change === 'member_ready' &&
      first.user_id === bob.id &&
      first.display_name === 'bob' &&
      first.is_ready === true &&
      first.state === 'active' &&
      Object.keys(first).sort().join() ===
        'change,display_name,id,is_ready,role,state,type,user_id,version',
    first,
  );
  const settings = payloads(aRoom).find((p) => p.change === 'settings');
  check(
    'a room event carries the new settings',
    settings?.type === 'room' && settings.settings?.max_players === 6 && !('code' in settings),
    settings,
  );
  check(
    'the event name is the payload type',
    aRoom.events.every((e) => e.event === e.payload.type),
    aRoom.events.map((e) => e.event),
  );
  check(
    'the public channel of the same name received none of the database broadcasts',
    mPublic.events.length === 0,
    mPublic.events,
  );
}

// ─── Client broadcast sends are refused ──────────────────────────────────
{
  const before = aRoom.events.length;
  const sent = await bRoom.channel.send({
    type: 'broadcast',
    event: 'room',
    payload: { type: 'room', version: 9999, status: 'closed' },
  });
  await sleep(1500);
  check(
    "a member's client broadcast is not delivered (only the database broadcasts)",
    aRoom.events.length === before && !versionsOf(aRoom).includes(9999),
    { sent, received: payloads(aRoom).slice(before) },
  );
}

// ─── Presence ────────────────────────────────────────────────────────────
{
  const aliceState = {
    user_id: alice.id,
    display_name: 'alice',
    device: 'desktop',
    activity: { lines: 0, last_build: 'ok', typing: false },
  };
  const t1 = await aRoom.channel.track(aliceState);
  const t2 = await bRoom.channel.track({ ...aliceState, user_id: bob.id, display_name: 'bob' });
  check('active members can track presence', t1 === 'ok' && t2 === 'ok', { t1, t2 });
  const seen = await waitFor(() => aRoom.presence[bob.id] && bRoom.presence[alice.id]);
  check(
    'members see each other in the presence state',
    Boolean(seen) && bRoom.presence[alice.id]?.[0]?.display_name === 'alice',
    { a: aRoom.presence, b: bRoom.presence },
  );

  // carol joins and leaves: she may still read the lobby, but not claim presence.
  await rpc(carol, 'join_room', { p_code: code, p_display_name: 'carol' });
  await rpc(carol, 'leave_room', { p_room_id: roomId });
  const cRoom = await subscribe(carol, roomTopic);
  check(
    'a member who left can still subscribe (read the lobby)',
    cRoom.status === 'SUBSCRIBED',
    cRoom,
  );
  const t3 = await cRoom.channel.track({ user_id: carol.id, display_name: 'carol' });
  await sleep(1500);
  check(
    'a member who left cannot claim presence (track is refused)',
    t3 === 'error' && !aRoom.presence[carol.id] && !bRoom.presence[carol.id],
    { t3, presence: Object.keys(aRoom.presence) },
  );
  await carol.client.removeChannel(cRoom.channel);
}

// ─── Battle topic ────────────────────────────────────────────────────────
const started = await rpc(alice, 'start_battle', { p_room_id: roomId });
check('alice starts a battle with bob', typeof started.data === 'string', started);
const battleId = started.data;
const battleTopic = `battle:${battleId}`;
await rpc(dave, 'join_room', { p_code: code, p_display_name: 'dave' });

const aBattle = await subscribe(alice, battleTopic);
const bBattle = await subscribe(bob, battleTopic);
const dBattle = await subscribe(dave, battleTopic);
const mBattle = await subscribe(mallory, battleTopic);
check(
  'roster players and a late spectator subscribe to the battle topic',
  [aBattle, bBattle, dBattle].every((s) => s.status === 'SUBSCRIBED'),
  [aBattle.status, bBattle.status, dBattle.status],
);
check(
  "a non-member's subscription to the battle topic is refused",
  mBattle.status === 'CHANNEL_ERROR',
  { status: mBattle.status, error: mBattle.error },
);
{
  const t = await dBattle.channel.track({ user_id: dave.id, display_name: 'dave' });
  const seen = await waitFor(() => aBattle.presence[dave.id]);
  check('the spectator tracks presence on the battle topic', t === 'ok' && Boolean(seen), t);
}

{
  const from = battleVersion(battleId) + 1;
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
  const adv = await rpc(bob, 'advance_battle', {
    p_battle_id: battleId,
    p_expected_version: from - 1,
  });
  check('SPINNING → BUILDING', adv.data?.phase === 'building', adv);

  // Both players ship; the second ship ends the battle early (SHIPPING without grace, then
  // RESULTS), all in one transaction: two versions arrive back to back.
  for (const who of [alice, bob]) {
    for (const [file, body, type] of [
      ['source.json', '{"files":{}}', 'application/json'],
      ['bundle.js', 'document.body.textContent = "hi";', 'text/javascript'],
    ]) {
      const { error } = await who.client.storage
        .from('ephemeral-builds')
        .upload(`${battleId}/${who.id}/${file}`, new Blob([body], { type }), { contentType: type });
      if (error) check(`${who.label} uploads ${file}`, false, error.message);
    }
  }
  const s1 = await rpc(alice, 'ship_build', {
    p_battle_id: battleId,
    p_name: 'Alpha',
    p_stats: {},
  });
  const s2 = await rpc(bob, 'ship_build', { p_battle_id: battleId, p_name: 'Bravo', p_stats: {} });
  check(
    'both ship; the last ship ends the battle early',
    s1.data?.build?.status === 'shipped' && s2.data?.battle?.phase === 'results',
    { s1, s2 },
  );
  const to = battleVersion(battleId);
  const want = to - from + 1;
  await waitFor(() =>
    [aBattle, bBattle, dBattle].every(
      (s) => s.events.filter((e) => e.payload.version >= from).length >= want,
    ),
  );
  for (const [name, s] of [
    ['alice', aBattle],
    ['bob', bBattle],
    ['dave (spectator)', dBattle],
  ]) {
    const got = versionsOf(s).filter((v) => v >= from);
    check(
      `${name} receives battle versions ${from}..${to} in order, gap-free`,
      isRun(got, from, to),
      got,
    );
  }
  const seq = payloads(aBattle)
    .filter((p) => p.version >= from)
    .map((p) => (p.type === 'phase' ? `phase:${p.phase}` : `${p.type}:${p.name ?? ''}`));
  check(
    'the sequence is building, Alpha shipped, Bravo shipped, shipping, results',
    seq.join(' ') === 'phase:building build:Alpha build:Bravo phase:shipping phase:results',
    seq,
  );
  const ship = payloads(aBattle).find((p) => p.type === 'build');
  check(
    'a build event has only small fields (no stats, no paths)',
    Object.keys(ship ?? {})
      .sort()
      .join() === 'build_id,completion_ms,id,name,status,type,user_id,version' &&
      ship.user_id === alice.id,
    ship,
  );
  check(
    'the stranger never received a battle event',
    mBattle.events.length === 0 && mPublic.events.length === 0,
  );
}

// ─── A kicked member cannot subscribe again ──────────────────────────────
{
  await dave.client.removeChannel(dBattle.channel);
  const dRoomOld = await subscribe(dave, roomTopic);
  check('before the kick, dave subscribes to the room topic', dRoomOld.status === 'SUBSCRIBED');
  await dave.client.removeChannel(dRoomOld.channel);

  const kick = await rpc(alice, 'kick_member', { p_room_id: roomId, p_user_id: dave.id });
  check('the host kicks dave', !kick.error, kick);
  const dRoom = await subscribe(dave, roomTopic);
  const dBattle2 = await subscribe(dave, battleTopic);
  check(
    'a kicked member cannot subscribe to the room topic again',
    dRoom.status === 'CHANNEL_ERROR',
    dRoom.status,
  );
  check(
    'nor to the battle topic of that room',
    dBattle2.status === 'CHANNEL_ERROR',
    dBattle2.status,
  );
}

for (const p of [alice, bob, carol, dave, mallory]) await p.client.removeAllChannels();
process.exit(finish());
