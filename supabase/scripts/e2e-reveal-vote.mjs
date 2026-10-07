#!/usr/bin/env node
// End-to-end check of REVEAL and VOTING (T-019, M4) against a running local Supabase stack,
// through the APIs the web app uses (supabase-js: Auth, PostgREST RPCs, Storage, Realtime),
// with pg_cron driving some of the deadlines:
//
//   4 players + a late spectator + a stranger. alice and bob ship by hand, cleo only
//   autosaves (auto-ship), dave has nothing (DNF) → SHIPPING → REVEAL (3 builds, shuffled):
//   storage reads of the revealed bundles (allowed from REVEAL, refused before, never the
//   sources), get_reveal_builds, host reveal_next (CAS), a slot deadline by pg_cron,
//   skip_to_vote → VOTING: guards, revotes, secret ballots, vote_progress counts, the
//   early end when everyone voted → RESULTS with tallies, vote ranks and category awards →
//   DESTROYED (reads refused again). Every listener must receive every battle version in
//   order, `phase` events carry reveal_index during REVEAL.
//
//   node supabase/scripts/e2e-reveal-vote.mjs
//
// Needs `supabase start` WITH realtime, `psql` on PATH and `pnpm install` (supabase-js is
// resolved from apps/web). Commits data; run it on a stack you can reset. VERBOSE=1 prints
// the response behind each check.

import {
  check,
  env,
  finish,
  isRun,
  newPlayer,
  payloads,
  rpc,
  sql,
  subscribe,
  waitFor,
} from './lib.mjs';

const SOURCE = JSON.stringify({ files: { 'src/main.ts': 'secret source' } });
const MANIFEST = JSON.stringify({ dependencies: { react: '19.2.0' } });
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const bundle = (name) => `document.body.textContent = ${JSON.stringify(name)};`;

const upload = (who, path, body, type) =>
  who.client.storage
    .from('ephemeral-builds')
    .upload(path, new Blob([body], { type }), { contentType: type });

async function download(who, path) {
  const { data, error } = await who.client.storage.from('ephemeral-builds').download(path);
  return { text: data ? await data.text() : null, error: error ? error.message : null };
}

const snapshot = (who, battleId) => rpc(who, 'get_battle_snapshot', { p_battle_id: battleId });
const version = (battleId) =>
  Number(sql(`select version from public.battles where id = '${battleId}'`));

async function waitForSnapshot(who, battleId, predicate, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const s = await snapshot(who, battleId);
      return s.data && predicate(s.data) ? s.data : null;
    },
    timeoutMs,
    500,
  );
}

const alice = await newPlayer('alice');
const bob = await newPlayer('bob');
const cleo = await newPlayer('cleo');
const dave = await newPlayer('dave');
const eve = await newPlayer('eve');
const mallory = await newPlayer('mallory');
console.log(`# alice ${alice.id}, bob ${bob.id}, cleo ${cleo.id}, dave ${dave.id}, eve ${eve.id}`);

// ─── Lobby and start ─────────────────────────────────────────────────────
const created = await rpc(alice, 'create_room', { p_display_name: 'alice' });
const roomId = created.data?.room_id;
const code = created.data?.code;
for (const who of [bob, cleo, dave]) {
  await rpc(who, 'join_room', { p_code: code, p_display_name: who.label });
}
for (const who of [alice, bob, cleo, dave]) {
  await rpc(who, 'set_ready', { p_room_id: roomId, p_ready: true });
}
// Like the web client: a heartbeat every few seconds keeps the players "present" (the early
// end of VOTING waits for every present voter).
const heartbeats = setInterval(() => {
  for (const who of [alice, bob, cleo, dave]) void rpc(who, 'heartbeat', { p_room_id: roomId });
}, 5_000);
const started = await rpc(alice, 'start_battle', { p_room_id: roomId });
check('alice starts a 4-player battle', typeof started.data === 'string', { created, started });
const battleId = started.data;
{
  const late = await rpc(eve, 'join_room', { p_code: code, p_display_name: 'eve' });
  check('eve joins late as a spectator', late.data?.role === 'spectator', late);
}
const subs = {};
for (const who of [alice, bob, cleo, dave, eve]) {
  subs[who.label] = await subscribe(who, `battle:${battleId}`);
}
check(
  'the players and the spectator listen on the battle topic',
  Object.values(subs).every((s) => s.status === 'SUBSCRIBED'),
  Object.fromEntries(Object.entries(subs).map(([k, s]) => [k, s.status])),
);
const firstVersion = 2;
{
  const snap = await snapshot(bob, battleId);
  check(
    'the battle reveals and votes (settings.reveal_vote = true)',
    snap.data?.battle?.reveal_vote === true && snap.data?.battle?.settings?.reveal_vote === true,
    snap.data?.battle,
  );
}

// ─── BUILDING ────────────────────────────────────────────────────────────
sql(
  `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
);
{
  const adv = await rpc(eve, 'advance_battle', { p_battle_id: battleId, p_expected_version: 1 });
  check('SPINNING → BUILDING (nudged by the spectator)', adv.data?.phase === 'building', adv);
}
const path = (who, file) => `${battleId}/${who.id}/${file}`;
{
  const results = await Promise.all([
    upload(alice, path(alice, 'source.json'), SOURCE, 'application/json'),
    upload(alice, path(alice, 'bundle.js'), bundle('Alpha'), 'text/javascript'),
    upload(alice, path(alice, 'bundle.css'), 'body { color: red }', 'text/css'),
    upload(alice, path(alice, 'manifest.json'), MANIFEST, 'application/json'),
    upload(alice, path(alice, 'thumb.webp'), WEBP, 'image/webp'),
    upload(bob, path(bob, 'source.json'), SOURCE, 'application/json'),
    upload(bob, path(bob, 'bundle.js'), bundle('Bravo'), 'text/javascript'),
    upload(cleo, path(cleo, 'autosave/source.json'), SOURCE, 'application/json'),
    upload(cleo, path(cleo, 'autosave/bundle.js'), bundle('Charlie'), 'text/javascript'),
    upload(cleo, path(cleo, 'autosave/bundle.css'), 'body { color: blue }', 'text/css'),
    upload(cleo, path(cleo, 'autosave/manifest.json'), MANIFEST, 'application/json'),
    upload(dave, path(dave, 'autosave/source.json'), SOURCE, 'application/json'),
  ]);
  check(
    'uploads: two full builds (with CSS, manifest.json, thumb), one autosave, one lone source',
    results.every((r) => !r.error),
    results.map((r) => r.error?.message ?? 'ok'),
  );
  for (const [who, name] of [
    [alice, 'Alpha'],
    [bob, 'Bravo'],
  ]) {
    const ship = await rpc(who, 'ship_build', { p_battle_id: battleId, p_name: name, p_stats: {} });
    check(`${who.label} ships ${name}`, ship.data?.build?.status === 'shipped', ship);
  }
  const peek = await download(bob, path(alice, 'bundle.js'));
  check(
    "before REVEAL another player cannot read alice's shipped bundle",
    Boolean(peek.error),
    peek,
  );
  const peek2 = await download(eve, path(alice, 'bundle.js'));
  check('nor can the spectator', Boolean(peek2.error), peek2);
  const early = await rpc(eve, 'get_reveal_builds', { p_battle_id: battleId });
  check('get_reveal_builds before REVEAL: wrong_phase', early.error === 'wrong_phase', early);
}

// ─── SHIPPING → REVEAL by pg_cron ────────────────────────────────────────
sql(`update public.battles set building_ends_at = now() - interval '20 seconds',
       phase_ends_at = now() - interval '20 seconds' where id = '${battleId}'`);
{
  const s = await waitForSnapshot(bob, battleId, (d) => d.battle.phase === 'shipping');
  check('pg_cron: BUILDING → SHIPPING', s?.battle?.phase === 'shipping', s?.battle);
  const peek = await download(bob, path(alice, 'bundle.js'));
  check('during SHIPPING the bundle is still private', Boolean(peek.error), peek);
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
}
let reveal;
{
  reveal = await waitForSnapshot(bob, battleId, (d) => d.battle.phase === 'reveal');
  const by = Object.fromEntries((reveal?.builds ?? []).map((b) => [b.builder_id, b]));
  check(
    'pg_cron: SHIPPING → REVEAL; cleo auto-shipped, dave DNF',
    reveal?.battle?.phase === 'reveal' &&
      by[cleo.id]?.status === 'auto_shipped' &&
      by[dave.id]?.status === 'dnf',
    reveal?.builds,
  );
  const order = reveal?.battle?.reveal_order ?? [];
  check(
    'reveal_order: the 3 final builds, index 0, 60 s slots (300 / 3 clamped)',
    order.length === 3 &&
      [alice, bob, cleo].every((w) => order.includes(by[w.id]?.id)) &&
      reveal.battle.reveal_index === 0 &&
      reveal.battle.reveal_slot_s === 60 &&
      Date.parse(reveal.battle.phase_ends_at) - Date.parse(reveal.battle.phase_started_at) ===
        60_000,
    reveal?.battle,
  );
}
const buildOf = Object.fromEntries(reveal.builds.map((b) => [b.builder_id, b.id]));

// ─── Storage during REVEAL ───────────────────────────────────────────────
{
  const rb = await rpc(eve, 'get_reveal_builds', { p_battle_id: battleId });
  const list = rb.data ?? [];
  check(
    'get_reveal_builds (spectator): 3 builds in reveal order with their paths',
    list.length === 3 &&
      list.every((b, i) => b.position === i && b.build_id === reveal.battle.reveal_order[i]),
    rb,
  );
  const byName = Object.fromEntries(list.map((b) => [b.builder_name, b]));
  check(
    'paths: shipped builds at the top level, the auto-shipped one under autosave/; missing files are null',
    byName.alice?.files?.js === path(alice, 'bundle.js') &&
      byName.alice?.files?.css === path(alice, 'bundle.css') &&
      byName.alice?.files?.manifest === path(alice, 'manifest.json') &&
      byName.alice?.files?.thumb === path(alice, 'thumb.webp') &&
      byName.bob?.files?.css === null &&
      byName.bob?.files?.manifest === null &&
      byName.cleo?.files?.js === path(cleo, 'autosave/bundle.js') &&
      byName.cleo?.files?.manifest === path(cleo, 'autosave/manifest.json') &&
      byName.cleo?.files?.thumb === null,
    list,
  );
  const reads = await Promise.all([
    download(eve, byName.alice.files.js),
    download(eve, byName.bob.files.js),
    download(eve, byName.cleo.files.js),
    download(dave, byName.cleo.files.css),
    download(bob, byName.alice.files.manifest),
  ]);
  check(
    'the spectator and the players download the revealed bundles, CSS and manifest',
    reads[0].text === bundle('Alpha') &&
      reads[1].text === bundle('Bravo') &&
      reads[2].text === bundle('Charlie') &&
      reads[3].text === 'body { color: blue }' &&
      reads[4].text === MANIFEST,
    reads,
  );
  const signed = await bob.client.storage
    .from('ephemeral-builds')
    .createSignedUrl(byName.alice.files.css, 60);
  const fetched = signed.data ? await (await fetch(signed.data.signedUrl)).text() : null;
  check(
    'a signed URL works too (what an iframe would load)',
    fetched === 'body { color: red }',
    signed.error?.message ?? fetched,
  );
  const denied = await Promise.all([
    download(bob, path(alice, 'source.json')),
    download(alice, path(cleo, 'autosave/source.json')),
    download(eve, path(dave, 'autosave/source.json')),
    download(mallory, byName.alice.files.js),
  ]);
  check(
    "never the sources, never a DNF player's autosave, never for a stranger",
    denied.every((d) => d.error && d.text === null),
    denied,
  );
  const stranger = await rpc(mallory, 'get_reveal_builds', { p_battle_id: battleId });
  check('a stranger gets battle_not_found', stranger.error === 'battle_not_found', stranger);
}

// ─── Host controls ───────────────────────────────────────────────────────
{
  const v = version(battleId);
  const notHost = await rpc(bob, 'reveal_next', { p_battle_id: battleId, p_expected_version: v });
  check('only the host reveals the next build', notHost.error === 'not_host', notHost);
  const next = await rpc(alice, 'reveal_next', { p_battle_id: battleId, p_expected_version: v });
  check(
    'the host moves to build 2',
    next.data?.changed === true && next.data?.reveal_index === 1 && next.data?.version === v + 1,
    next,
  );
  const stale = await rpc(alice, 'reveal_next', { p_battle_id: battleId, p_expected_version: v });
  check('a double click (stale version) is a no-op', stale.data?.changed === false, stale);
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
  );
  const s = await waitForSnapshot(dave, battleId, (d) => d.battle.reveal_index === 2);
  check('pg_cron ends slot 2 on its deadline: build 3', s?.battle?.reveal_index === 2, s?.battle);
  const early = await rpc(bob, 'cast_vote', {
    p_battle_id: battleId,
    p_category: 'overall',
    p_build_id: buildOf[alice.id],
  });
  check('no votes during REVEAL', early.error === 'wrong_phase', early);
  const skip = await rpc(alice, 'skip_to_vote', {
    p_battle_id: battleId,
    p_expected_version: version(battleId),
  });
  check('the host skips to the vote', skip.data?.phase === 'voting', skip);
}

// ─── VOTING ──────────────────────────────────────────────────────────────
const A = buildOf[alice.id];
const B = buildOf[bob.id];
const C = buildOf[cleo.id];
const D = buildOf[dave.id];
{
  const guards = await Promise.all([
    rpc(eve, 'cast_vote', { p_battle_id: battleId, p_category: 'overall', p_build_id: A }),
    rpc(alice, 'cast_vote', { p_battle_id: battleId, p_category: 'overall', p_build_id: A }),
    rpc(alice, 'cast_vote', { p_battle_id: battleId, p_category: 'overall', p_build_id: D }),
    rpc(alice, 'cast_vote', { p_battle_id: battleId, p_category: 'best_ever', p_build_id: B }),
  ]);
  check(
    'guards: spectator, self-vote, DNF build, unknown category',
    guards.map((g) => g.error).join() === 'not_on_roster,self_vote,not_votable,invalid_category',
    guards,
  );
  const snap = await snapshot(dave, battleId);
  check(
    'the DNF player can vote; progress 0 of 4',
    snap.data?.me?.can_vote === true &&
      snap.data?.vote_progress?.voted_count === 0 &&
      snap.data?.vote_progress?.eligible_count === 4,
    { me: snap.data?.me, progress: snap.data?.vote_progress },
  );
}
const ballots = [
  [alice, { overall: B, rule: C, style: B, chaos: C }],
  [bob, { overall: C, rule: C, style: A, chaos: C }],
  [cleo, { overall: A, rule: A, style: B, chaos: B }],
  [dave, { overall: A, rule: B, style: C, chaos: C }],
];
let lastVote;
for (const [who, ballot] of ballots) {
  for (const [category, build] of Object.entries(ballot)) {
    lastVote = await rpc(who, 'cast_vote', {
      p_battle_id: battleId,
      p_category: category,
      p_build_id: build,
    });
    if (lastVote.error) check(`${who.label} votes ${category}`, false, lastVote);
  }
  if (who === bob) {
    const re = await rpc(bob, 'cast_vote', {
      p_battle_id: battleId,
      p_category: 'overall',
      p_build_id: A,
    });
    const mine = await rpc(bob, 'get_my_votes', { p_battle_id: battleId });
    check(
      'bob changes his Best Build vote (revote); get_my_votes shows his ballot',
      !re.error &&
        mine.data?.complete === true &&
        mine.data?.votes?.overall === A &&
        mine.data?.votes?.rule === C,
      mine,
    );
    const table = await bob.client.from('votes').select('*').eq('battle_id', battleId);
    check(
      'ballot secrecy: bob reads only his own 4 votes from the table',
      table.data?.length === 4 && table.data.every((v) => v.voter_id === bob.id),
      table,
    );
    const spy = await eve.client.from('votes').select('*').eq('battle_id', battleId);
    check('the spectator reads no votes', spy.data?.length === 0, spy);
    const progress = await snapshot(eve, battleId);
    check(
      'progress: 2 of 4, counts only, no tallies yet',
      progress.data?.vote_progress?.voted_count === 2 &&
        progress.data?.builds?.every((b) => b.votes === null),
      progress.data?.vote_progress,
    );
  }
}
check(
  'the last ballot ends VOTING early (everyone present voted)',
  lastVote?.data?.battle?.phase === 'results' && lastVote?.data?.ballot_complete === true,
  lastVote,
);

// ─── RESULTS ─────────────────────────────────────────────────────────────
{
  const res = await snapshot(bob, battleId);
  const by = Object.fromEntries((res.data?.builds ?? []).map((b) => [b.id, b]));
  // A: overall 3 (bob, cleo, dave), rule 1, style 1 → 5;  B: overall 1, rule 1, style 2,
  // chaos 1 → 5;  C: rule 2, style 1, chaos 3 → 6.
  check(
    'tallies and ranks: Best Build first, then total votes',
    by[A]?.final_rank === 1 &&
      by[B]?.final_rank === 2 &&
      by[C]?.final_rank === 3 &&
      by[D]?.final_rank === null &&
      ['overall', 'rule', 'style', 'chaos'].map((c) => by[A]?.votes?.[c]).join() === '3,1,1,0' &&
      by[C]?.total_votes === 6,
    res.data?.builds,
  );
  const voteAwards = (res.data?.awards ?? [])
    .filter((a) => a.source === 'vote')
    .map((a) => `${a.award}:${a.build_id === A ? 'A' : a.build_id === B ? 'B' : 'C'}:${a.votes}`)
    .sort();
  check(
    'category awards: overall A, rule C, style B, chaos C',
    voteAwards.join(' ') === 'chaos:C:3 overall:A:3 rule:C:2 style:B:2',
    voteAwards,
  );
  const phaseEvent = sql(`select payload ->> 'reason' from public.battle_events
                          where battle_id = '${battleId}' and type = 'phase' order by id desc limit 1`);
  check('the early end is logged as all_voted', phaseEvent === 'all_voted', phaseEvent);
  const anonRes = await fetch(`${env.API_URL}/rest/v1/rpc/get_public_battle`, {
    method: 'POST',
    headers: {
      apikey: env.ANON_KEY,
      authorization: `Bearer ${env.ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_battle_id: battleId }),
  });
  const pub = await anonRes.json();
  check(
    'the permanent page (anon) shows the per-category counts and no voters',
    pub.builds?.[0]?.votes?.overall === 3 &&
      !JSON.stringify(pub).includes('voter') &&
      !JSON.stringify(pub).includes(bob.id),
    pub,
  );
  const spy = await mallory.client.from('votes').select('*').eq('battle_id', battleId);
  check('after RESULTS a stranger still reads no votes', spy.data?.length === 0, spy);
  const last = await download(eve, path(alice, 'bundle.js'));
  check('the last look still reads the revealed bundles', last.text === bundle('Alpha'), last);
}

// ─── DESTROYED: reads refused again ──────────────────────────────────────
sql(`update public.battles set phase_ends_at = now() - interval '1 second',
       shipping_ended_at = now() - interval '11 minutes' where id = '${battleId}'`);
{
  const s = await waitForSnapshot(alice, battleId, (d) => d.battle.phase === 'destroyed');
  check('pg_cron: RESULTS → DESTROYED (capture deadline passed)', s?.battle?.phase === 'destroyed');
  const after = await download(eve, path(alice, 'bundle.js'));
  check('after DESTROYED nobody else reads the bundle', Boolean(after.error), after);
}

// ─── Realtime ────────────────────────────────────────────────────────────
{
  const to = version(battleId);
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
      `${name} received versions ${firstVersion}..${to} in order, gap-free`,
      isRun(got, firstVersion, to),
      got,
    );
  }
  const seen = payloads(subs.eve).filter((p) => p.version >= firstVersion);
  const reveals = seen.filter((p) => p.type === 'phase' && p.phase === 'reveal');
  check(
    'phase events during REVEAL carry reveal_index 0, 1, 2 (with the host reason on the 2nd)',
    reveals.map((p) => p.reveal_index).join() === '0,1,2' && reveals[1]?.reason === 'host_next',
    reveals,
  );
  const progress = seen.filter((p) => p.type === 'vote_progress');
  check(
    'vote_progress: one per completed ballot, counts only',
    progress.map((p) => `${p.voted_count}/${p.eligible_count}`).join() === '1/4,2/4,3/4,4/4' &&
      progress.every(
        (p) => Object.keys(p).sort().join() === 'eligible_count,id,type,version,voted_count',
      ),
    progress,
  );
  const kinds = seen.map((p) => (p.type === 'phase' ? p.phase : p.type));
  check(
    'the sequence: building, 2 builds, shipping, 3 reveal slots, voting, 4 vote_progress, results, destroyed',
    kinds.join(' ') ===
      'building build build shipping reveal reveal reveal voting vote_progress vote_progress vote_progress vote_progress results destroyed',
    kinds,
  );
}

clearInterval(heartbeats);
for (const p of [alice, bob, cleo, dave, eve, mallory]) await p.client.removeAllChannels();
process.exit(finish());
