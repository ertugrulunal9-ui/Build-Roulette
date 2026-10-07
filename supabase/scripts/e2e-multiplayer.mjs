#!/usr/bin/env node
// End-to-end check of an M3 multiplayer battle (a room with reveal_vote = false; REVEAL and
// VOTING are in e2e-reveal-vote.mjs) against a running local Supabase stack,
// through the APIs the web app uses (supabase-js: Auth, PostgREST RPCs, Storage, Realtime),
// with pg_cron driving the deadlines:
//
//   lobby (create, join, ready, heartbeat) → start_battle → SPINNING → BUILDING →
//   alice ships, bob only autosaves, cleo has nothing → SHIPPING → RESULTS (shipped,
//   auto_shipped, dnf; ranks; awards; capture jobs) → captures → DESTROYED → room open,
//   the late spectator is promoted → rematch.
//
// Every player and the late spectator listen on the private battle topic; each must receive
// every version in order. Time is simulated by moving deadlines with psql.
//
//   node supabase/scripts/e2e-multiplayer.mjs
//
// Needs `supabase start` WITH realtime, `psql` on PATH and `pnpm install` (supabase-js is
// resolved from apps/web). Commits data; run it on a stack you can reset. VERBOSE=1 prints
// the response behind each check.

import {
  check,
  finish,
  isRun,
  newPlayer,
  payloads,
  rpc,
  serviceClient,
  sql,
  subscribe,
  waitFor,
} from './lib.mjs';

const SOURCE = JSON.stringify({ files: { 'src/main.ts': 'console.log("hi")' } });
const BUNDLE = 'document.body.textContent = "Pomodoro Pro";';

const upload = (who, path, body, type, upsert = false) =>
  who.client.storage
    .from('ephemeral-builds')
    .upload(path, new Blob([body], { type }), { contentType: type, upsert });

async function snapshot(who, battleId) {
  return rpc(who, 'get_battle_snapshot', { p_battle_id: battleId });
}

async function waitForPhase(who, battleId, phase, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const s = await snapshot(who, battleId);
      return s.data?.battle?.phase === phase ? s.data : null;
    },
    timeoutMs,
    500,
  );
}

const alice = await newPlayer('alice');
const bob = await newPlayer('bob');
const cleo = await newPlayer('cleo');
const dave = await newPlayer('dave');
const mallory = await newPlayer('mallory');
const service = { label: 'service', client: serviceClient() };
console.log(`# alice ${alice.id}, bob ${bob.id}, cleo ${cleo.id}, dave ${dave.id}`);

// ─── Lobby ───────────────────────────────────────────────────────────────
const created = await rpc(alice, 'create_room', { p_display_name: 'Alice' });
check(
  'alice creates a room and gets a 5-character code',
  /^[A-HJ-NP-Z2-9]{5}$/.test(created.data?.code ?? ''),
  created,
);
const roomId = created.data.room_id;
const code = created.data.code;
{
  // This script covers the quick M3 flow (SHIPPING → RESULTS); e2e-reveal-vote.mjs covers
  // REVEAL and VOTING, which new battles run by default.
  const quick = await rpc(alice, 'update_room_settings', {
    p_room_id: roomId,
    p_settings: { reveal_vote: false },
  });
  check(
    'the host turns reveal and vote off for this room',
    quick.data?.reveal_vote === false,
    quick,
  );
}
for (const who of [bob, cleo]) {
  const j = await rpc(who, 'join_room', { p_code: code.toLowerCase(), p_display_name: who.label });
  check(`${who.label} joins with the code`, j.data?.role === 'player', j);
}
const aRoom = await subscribe(alice, `room:${roomId}`);
check('alice listens on the room topic', aRoom.status === 'SUBSCRIBED', aRoom.status);
{
  const early = await rpc(alice, 'start_battle', { p_room_id: roomId });
  check('nobody is ready: not_enough_players', early.error === 'not_enough_players', early);
  for (const who of [alice, bob, cleo]) {
    const r = await rpc(who, 'set_ready', { p_room_id: roomId, p_ready: true });
    check(`${who.label} is ready`, !r.error, r);
  }
  const hb = await rpc(bob, 'heartbeat', { p_room_id: roomId });
  check(
    'heartbeat answers with the server time, room version and host',
    typeof hb.data?.server_now === 'string' && hb.data?.host_id === alice.id,
    hb,
  );
  const snap = await rpc(bob, 'get_room_snapshot', { p_room_id: roomId });
  check(
    'the room snapshot lists three ready players, alice hosting',
    snap.data?.members?.length === 3 &&
      snap.data.members.every((m) => m.is_ready && m.role === 'player') &&
      snap.data.room.host_id === alice.id &&
      snap.data.room.code === code,
    snap,
  );
  const stranger = await rpc(mallory, 'get_room_snapshot', { p_room_id: roomId });
  check('a stranger cannot read the room', stranger.error === 'room_not_found', stranger);
  const notHost = await rpc(bob, 'start_battle', { p_room_id: roomId });
  check('only the host starts', notHost.error === 'not_host', notHost);
}

// ─── Start ───────────────────────────────────────────────────────────────
const started = await rpc(alice, 'start_battle', { p_room_id: roomId });
check('alice starts the battle', typeof started.data === 'string', started);
const battleId = started.data;
const battleTopic = `battle:${battleId}`;
{
  const late = await rpc(dave, 'join_room', { p_code: code, p_display_name: 'dave' });
  check('dave joins during the battle as a spectator', late.data?.role === 'spectator', late);
}
const subs = {};
for (const who of [alice, bob, cleo, dave]) subs[who.label] = await subscribe(who, battleTopic);
check(
  'the three players and the spectator listen on the battle topic',
  Object.values(subs).every((s) => s.status === 'SUBSCRIBED'),
  Object.fromEntries(Object.entries(subs).map(([k, s]) => [k, s.status])),
);
const firstVersion = 2; // version 1 (SPINNING) happened before anyone subscribed
{
  const snap = await snapshot(bob, battleId);
  check(
    'SPINNING, 3 drafts, the server picked the time limit',
    snap.data?.battle?.phase === 'spinning' &&
      snap.data?.battle?.mode === 'multiplayer' &&
      snap.data?.builds?.length === 3 &&
      [300, 600, 900].includes(snap.data?.challenge?.time_limit_seconds),
    snap,
  );
  const spec = await snapshot(dave, battleId);
  check('the spectator reads the battle as a spectator', spec.data?.me?.role === 'spectator', spec);
  const nope = await snapshot(mallory, battleId);
  check('a stranger cannot read the running battle', nope.error === 'battle_not_found', nope);
  const roomSnap = await rpc(alice, 'get_room_snapshot', { p_room_id: roomId });
  check(
    'the room is in_battle with the battle summary',
    roomSnap.data?.room?.status === 'in_battle' && roomSnap.data?.battle?.roster?.length === 3,
    roomSnap,
  );
}

// ─── SPINNING → BUILDING by pg_cron ──────────────────────────────────────
sql(
  `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
);
{
  const s = await waitForPhase(bob, battleId, 'building');
  check('pg_cron moves SPINNING → BUILDING', s?.battle?.phase === 'building', s);
}
// A 300 s battle, 100 s in (the time limit is random; pin it for the award checks).
sql(`update public.challenges set time_limit_seconds = 300
       where id = (select challenge_id from public.battles where id = '${battleId}');
     update public.battles set building_started_at = now() - interval '100 seconds',
       building_ends_at = now() + interval '200 seconds', phase_ends_at = now() + interval '200 seconds'
     where id = '${battleId}'`);

// ─── Building: ship, autosave, nothing ───────────────────────────────────
{
  const a1 = await upload(alice, `${battleId}/${alice.id}/source.json`, SOURCE, 'application/json');
  const a2 = await upload(alice, `${battleId}/${alice.id}/bundle.js`, BUNDLE, 'text/javascript');
  check('alice uploads her build', !a1.error && !a2.error, { a1, a2 });
  const b1 = await upload(
    bob,
    `${battleId}/${bob.id}/autosave/source.json`,
    SOURCE,
    'application/json',
  );
  const b2 = await upload(
    bob,
    `${battleId}/${bob.id}/autosave/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check('bob autosaves', !b1.error && !b2.error, { b1, b2 });
  const d1 = await upload(dave, `${battleId}/${dave.id}/bundle.js`, BUNDLE, 'text/javascript');
  check('the spectator cannot upload into the battle', Boolean(d1.error), d1.error?.message);
  const peek = await bob.client.storage
    .from('ephemeral-builds')
    .download(`${battleId}/${alice.id}/bundle.js`);
  check("another player cannot read alice's files during BUILDING", Boolean(peek.error));
  const dShip = await rpc(dave, 'ship_build', { p_battle_id: battleId, p_name: 'x', p_stats: {} });
  check('the spectator cannot ship', dShip.error === 'not_on_roster', dShip);

  const ship = await rpc(alice, 'ship_build', {
    p_battle_id: battleId,
    p_name: 'Pomodoro Pro',
    p_stats: { files: 2, lines: 40, deps: ['canvas-confetti'] },
  });
  check(
    'alice ships; bob and cleo still build, so no early end',
    ship.data?.build?.status === 'shipped' && ship.data?.battle?.phase === 'building',
    ship,
  );
  const twice = await rpc(alice, 'ship_build', {
    p_battle_id: battleId,
    p_name: 'again',
    p_stats: {},
  });
  check('ship is final', twice.error === 'already_shipped', twice);
}

// ─── The deadline passes; pg_cron ends SHIPPING ──────────────────────────
// Move the whole timeline 220 s into the past (alice's ship included).
sql(`update public.builds set shipped_at = shipped_at - interval '220 seconds'
       where battle_id = '${battleId}' and status = 'shipped';
     update public.battles set building_started_at = now() - interval '320 seconds',
       building_ends_at = now() - interval '20 seconds', phase_ends_at = now() - interval '20 seconds'
     where id = '${battleId}'`);
{
  const s = await waitForPhase(bob, battleId, 'shipping');
  check('pg_cron moves BUILDING → SHIPPING', s?.battle?.phase === 'shipping', s);
  const late = await upload(
    bob,
    `${battleId}/${bob.id}/autosave/bundle.js`,
    BUNDLE + '//late',
    'text/javascript',
    true,
  );
  check('after the deadline + grace, nothing can be written', Boolean(late.error));
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
}
let results;
{
  results = await waitForPhase(bob, battleId, 'results');
  check('pg_cron moves SHIPPING → RESULTS', results?.battle?.phase === 'results', results);
  const by = Object.fromEntries((results?.builds ?? []).map((b) => [b.builder_id, b]));
  check(
    'alice shipped (rank 1), bob auto-shipped (rank 2), cleo DNF (no rank)',
    by[alice.id]?.status === 'shipped' &&
      by[alice.id]?.final_rank === 1 &&
      by[bob.id]?.status === 'auto_shipped' &&
      by[bob.id]?.final_rank === 2 &&
      by[bob.id]?.completion_ms === 300_000 &&
      by[cleo.id]?.status === 'dnf' &&
      by[cleo.id]?.final_rank === null,
    results?.builds,
  );
  check(
    "awards: alice's speedrun only (one hand-shipped build: no fastest_ship)",
    JSON.stringify(results?.awards?.map((a) => [a.award, a.build_id])) ===
      JSON.stringify([['speedrun', by[alice.id]?.id]]),
    results?.awards,
  );
  const jobs = sql(`select count(*) from public.jobs j join public.builds b on b.id = j.ref_id
                    where b.battle_id = '${battleId}' and j.kind = 'capture'`);
  check('two capture jobs (shipped + auto-shipped), none for the DNF', jobs === '2', jobs);
  const pub = await rpc(mallory, 'get_battle_snapshot', { p_battle_id: battleId });
  check(
    'RESULTS are public: a stranger reads them as a viewer',
    pub.data?.me?.role === 'viewer',
    pub,
  );
}

// ─── Captures (simulated worker) ─────────────────────────────────────────
{
  const ids = results.builds
    .filter((b) => ['shipped', 'auto_shipped'].includes(b.status))
    .map((b) => b.id);
  sql(`update public.jobs set run_after = '-infinity'
       where kind = 'capture' and ref_id in (${ids.map((id) => `'${id}'`).join(',')})`);
  for (let i = 0; i < ids.length; i += 1) {
    const job = await service.client.rpc('claim_job', { p_kind: 'capture' });
    const id = job.data?.ref_id;
    const path = `${battleId}/${id}.webp`;
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const put = await service.client.storage
      .from('screenshots')
      .upload(path, new Blob([webp], { type: 'image/webp' }), { contentType: 'image/webp' });
    const done = await service.client.rpc('complete_capture', {
      p_build_id: id,
      p_status: 'captured',
      p_path: path,
    });
    check(
      `capture ${i + 1}: claimed, stored, completed`,
      ids.includes(id) && !put.error && !done.error,
      {
        job: job.data,
        put: put.error,
        done: done.error,
      },
    );
  }
}

// ─── RESULTS → DESTROYED by pg_cron; the room reopens ────────────────────
sql(
  `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
);
{
  const s = await waitForPhase(alice, battleId, 'destroyed');
  check('pg_cron moves RESULTS → DESTROYED', s?.battle?.phase === 'destroyed', s);
  const roomSnap = await rpc(alice, 'get_room_snapshot', { p_room_id: roomId });
  const daveRow = roomSnap.data?.members?.find((m) => m.user_id === dave.id);
  check(
    'the room is open again; the late spectator is promoted to player',
    roomSnap.data?.room?.status === 'open' &&
      roomSnap.data?.room?.current_battle_id === battleId &&
      daveRow?.role === 'player',
    roomSnap,
  );

  sql(
    `update public.jobs set run_after = '-infinity' where kind = 'destroy' and ref_id = '${battleId}'`,
  );
  const job = await service.client.rpc('claim_job', { p_kind: 'destroy' });
  const { data: listed } = await service.client.storage.from('ephemeral-builds').list(battleId);
  const paths = [];
  for (const folder of listed ?? []) {
    const { data: files } = await service.client.storage
      .from('ephemeral-builds')
      .list(`${battleId}/${folder.name}`);
    for (const f of files ?? []) {
      if (f.id) paths.push(`${battleId}/${folder.name}/${f.name}`);
      else {
        const { data: sub } = await service.client.storage
          .from('ephemeral-builds')
          .list(`${battleId}/${folder.name}/${f.name}`);
        for (const g of sub ?? []) paths.push(`${battleId}/${folder.name}/${f.name}/${g.name}`);
      }
    }
  }
  const del = await service.client.storage.from('ephemeral-builds').remove(paths);
  const done = await service.client.rpc('complete_destroy', { p_battle_id: battleId });
  const left = sql(
    `select count(*) from storage.objects where bucket_id = 'ephemeral-builds' and name like '${battleId}/%'`,
  );
  check(
    'the destroy worker removes every ephemeral file and completes',
    job.data?.ref_id === battleId &&
      !del.error &&
      !done.error &&
      left === '0' &&
      paths.length === 4,
    { paths, del: del.error, done: done.error, left },
  );
}

// ─── Realtime: every listener got every version, in order ────────────────
{
  const to = Number(sql(`select version from public.battles where id = '${battleId}'`));
  await waitFor(() =>
    Object.values(subs).every(
      (s) =>
        s.events.filter((e) => e.payload.version >= firstVersion).length >= to - firstVersion + 1,
    ),
  );
  for (const [name, s] of Object.entries(subs)) {
    const got = payloads(s)
      .map((p) => p.version)
      .filter((v) => v >= firstVersion);
    check(
      `${name} received battle versions ${firstVersion}..${to} in order, gap-free`,
      isRun(got, firstVersion, to),
      got,
    );
  }
  const kinds = payloads(subs.dave)
    .filter((p) => p.version >= firstVersion)
    .map((p) => (p.type === 'phase' ? p.phase : p.type));
  check(
    'the sequence: building, build (alice), shipping, results, 2 captures, destroyed (phase), destroyed',
    kinds.join(' ') === 'building build shipping results capture capture destroyed destroyed',
    kinds,
  );
  const roomEvents = payloads(aRoom).map((p) => p.change);
  check(
    'the room topic told alice about the start, the late joiner, the end and the promotion',
    ['battle_started', 'member_joined', 'battle_ended', 'member_promoted'].every((c) =>
      roomEvents.includes(c),
    ),
    roomEvents,
  );
  const rv = payloads(aRoom).map((p) => p.version);
  check('room versions arrived in order, gap-free', isRun(rv, rv[0], rv[rv.length - 1]), rv);
}

// ─── Rematch ─────────────────────────────────────────────────────────────
{
  for (const who of [alice, bob, dave])
    await rpc(who, 'set_ready', { p_room_id: roomId, p_ready: true });
  const again = await rpc(alice, 'start_battle', { p_room_id: roomId });
  check(
    'a rematch is a new battle in the same room',
    typeof again.data === 'string' && again.data !== battleId,
    again,
  );
  const snap = await snapshot(dave, again.data);
  check('the promoted spectator plays the rematch', snap.data?.me?.role === 'player', snap);
}

for (const p of [alice, bob, cleo, dave, mallory]) await p.client.removeAllChannels();
process.exit(finish());
