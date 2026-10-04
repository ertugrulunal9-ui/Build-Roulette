#!/usr/bin/env node
// End-to-end check of the M2 solo loop against a running local Supabase stack, through
// the same HTTP APIs the app and the workers use: GoTrue (anonymous sign-in), PostgREST
// (RPCs) and the Storage API (uploads, RLS, MIME/size limits, public URLs). pg_cron is
// exercised for real: one battle is left for the 5-second sweep to advance.
//
//   node supabase/scripts/e2e-solo.mjs
//
// Needs `supabase start` (with auth, rest, storage and kong) and `psql` on PATH. Time is
// simulated by moving deadlines with psql, as the pgTAP tests do. Connection settings come
// from the environment (API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL, as printed by
// `supabase status -o env`); when they are missing the script asks the CLI.
//
// The script commits its data (users, battles, a few small files). Run it on a local stack
// you can `supabase db reset`. Exit code 0 only if every check passes. VERBOSE=1 also prints
// the response behind each passing check.

import { execFileSync } from 'node:child_process';

// ─── Environment ─────────────────────────────────────────────────────────
function loadEnv() {
  const keys = ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'DB_URL'];
  const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  if (keys.every((k) => env[k])) return env;
  const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m && keys.includes(m[1]) && !env[m[1]]) env[m[1]] = m[2];
  }
  for (const k of keys) if (!env[k]) throw new Error(`missing ${k} (is the stack running?)`);
  return env;
}

const { API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL } = loadEnv();

// ─── Tiny test harness (TAP-like output) ─────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`ok ${passed + failed} - ${name}`);
    if (process.env.VERBOSE && detail !== undefined) {
      console.log(`#   ${JSON.stringify(detail).slice(0, 300)}`);
    }
  } else {
    failed += 1;
    console.log(`not ok ${passed + failed} - ${name}`);
    if (detail !== undefined) console.log(`#   ${JSON.stringify(detail)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Clients ─────────────────────────────────────────────────────────────
function sql(query) {
  return execFileSync(
    'psql',
    [DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    {
      encoding: 'utf8',
    },
  ).trim();
}

async function request(method, path, { token, apikey = ANON_KEY, body, headers = {} } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      apikey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string'
        ? { 'content-type': 'application/json' }
        : {}),
      ...headers,
    },
    body:
      body === undefined || body instanceof Uint8Array || typeof body === 'string'
        ? body
        : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function signUpAnonymously() {
  const res = await request('POST', '/auth/v1/signup', { body: {} });
  if (res.status !== 200) throw new Error(`anonymous sign-up failed: ${JSON.stringify(res)}`);
  return { token: res.body.access_token, id: res.body.user.id };
}

const service = { token: SERVICE_ROLE_KEY, apikey: SERVICE_ROLE_KEY };

const rpc = (who, fn, args = {}) =>
  request('POST', `/rest/v1/rpc/${fn}`, { token: who.token, apikey: who.apikey, body: args });

const upload = (who, bucket, path, content, contentType, { upsert = false } = {}) =>
  request('POST', `/storage/v1/object/${bucket}/${path}`, {
    token: who.token,
    apikey: who.apikey,
    body: content,
    headers: { 'content-type': contentType, 'x-upsert': String(upsert) },
  });

const download = (who, bucket, path) =>
  request('GET', `/storage/v1/object/authenticated/${bucket}/${path}`, {
    token: who.token,
    apikey: who.apikey,
  });

const removeObjects = (who, bucket, paths) =>
  request('DELETE', `/storage/v1/object/${bucket}`, {
    token: who.token,
    apikey: who.apikey,
    body: { prefixes: paths },
  });

async function waitForPhase(who, battleId, phase, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await rpc(who, 'get_battle_snapshot', { p_battle_id: battleId });
    if (last.body?.battle?.phase === phase) return last.body;
    await sleep(500);
  }
  return last?.body;
}

const ok2xx = (res) => res.status >= 200 && res.status < 300;
// The Storage API answers HTTP 400 with the real status in the body.
const storageStatus = (res) => (ok2xx(res) ? String(res.status) : String(res.body?.statusCode));
const deniedByRls = (res) =>
  storageStatus(res) === '403' && /row-level security/.test(res.body?.message ?? '');
const SOURCE = JSON.stringify({ files: { 'src/main.ts': 'console.log("hi")' } });
const BUNDLE = 'document.body.textContent = "Snack Overflow";';

// ═════════════════════════════════════════════════════════════════════════
const alice = await signUpAnonymously();
const bob = await signUpAnonymously();
console.log(`# alice ${alice.id}, bob ${bob.id}`);

// ─── RPC basics ──────────────────────────────────────────────────────────
{
  const noSession = await request('POST', '/rest/v1/rpc/server_now', { body: {} });
  check('without a session, RPCs are refused', !ok2xx(noSession), noSession);
  const now = await rpc(alice, 'server_now');
  check(
    'server_now returns the server clock',
    ok2xx(now) && Math.abs(Date.parse(now.body) - Date.now()) < 60_000,
    now,
  );
  const claim = await rpc(alice, 'claim_job', { p_kind: 'capture' });
  check('a client cannot call worker functions', !ok2xx(claim), claim);
}

// ─── alice: start, spin, build ───────────────────────────────────────────
const start = await rpc(alice, 'start_solo_battle', {
  p_display_name: 'alice',
  p_time_limit_seconds: 300,
});
check(
  'start_solo_battle returns a battle id',
  ok2xx(start) && typeof start.body === 'string',
  start,
);
const battle = start.body;
const prefix = `${battle}/${alice.id}`;

{
  const again = await rpc(alice, 'start_solo_battle', { p_display_name: 'alice' });
  check(
    'a second start is refused with battle_in_progress',
    again.status === 400 &&
      again.body?.message === 'battle_in_progress' &&
      again.body?.details === battle,
    again,
  );
  const early = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/autosave/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check('no uploads while SPINNING', deniedByRls(early), early);

  const snap = await rpc(alice, 'get_battle_snapshot', { p_battle_id: battle });
  check(
    'the snapshot shows SPINNING with the challenge to land on',
    snap.body?.battle?.phase === 'spinning' &&
      typeof snap.body?.challenge?.build?.text === 'string',
    snap,
  );

  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battle}'`,
  );
  const adv = await rpc(alice, 'advance_battle', { p_battle_id: battle, p_expected_version: 1 });
  check(
    'advance_battle: SPINNING → BUILDING',
    adv.body?.changed === true && adv.body?.phase === 'building',
    adv,
  );
  const stale = await rpc(alice, 'advance_battle', { p_battle_id: battle, p_expected_version: 1 });
  check('a stale nudge is a no-op', ok2xx(stale) && stale.body?.changed === false, stale);
}

// ─── alice: storage while BUILDING ───────────────────────────────────────
{
  const put = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/autosave/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check('the owner uploads an autosave', ok2xx(put), put);
  const again = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/autosave/bundle.js`,
    BUNDLE + '//2',
    'text/javascript',
  );
  check(
    'a plain re-upload of an existing file is refused (no upsert)',
    storageStatus(again) === '409',
    again,
  );
  const upsert = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/autosave/bundle.js`,
    BUNDLE + '//2',
    'text/javascript',
    {
      upsert: true,
    },
  );
  check('an upsert overwrites the autosave', ok2xx(upsert), upsert);
  const read = await download(alice, 'ephemeral-builds', `${prefix}/autosave/bundle.js`);
  check(
    'the owner reads the overwritten file',
    read.status === 200 && read.body === BUNDLE + '//2',
    read,
  );

  const html = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/bundle.js`,
    '<h1>x</h1>',
    'text/html',
  );
  check('a MIME type outside the bucket list is refused', storageStatus(html) === '415', html);
  const big = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/bundle.js`,
    'x'.repeat(5 * 1024 * 1024 + 1),
    'text/javascript',
  );
  check('a file over 5 MB is refused', storageStatus(big) === '413', big);
  const evil = await upload(alice, 'ephemeral-builds', `${prefix}/index.html`, 'x', 'text/css');
  check('a file name outside the allowed list is refused', deniedByRls(evil), evil);
  const foreign = await upload(
    alice,
    'ephemeral-builds',
    `${battle}/${bob.id}/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check("writing under another user's folder is refused", deniedByRls(foreign), foreign);
  const shot = await upload(alice, 'screenshots', `${battle}/fake.webp`, 'x', 'image/webp');
  check('a client cannot write screenshots', deniedByRls(shot), shot);

  const bobRead = await download(bob, 'ephemeral-builds', `${prefix}/autosave/bundle.js`);
  check(
    "another player cannot read alice's files (hidden: 404)",
    storageStatus(bobRead) === '404',
    bobRead,
  );
  const bobWrite = await upload(
    bob,
    'ephemeral-builds',
    `${battle}/${bob.id}/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check(
    "a player not on the roster cannot write into alice's battle",
    deniedByRls(bobWrite),
    bobWrite,
  );

  const del = await removeObjects(alice, 'ephemeral-builds', [`${prefix}/autosave/bundle.js`]);
  const still = await download(alice, 'ephemeral-builds', `${prefix}/autosave/bundle.js`);
  check(
    'the owner cannot delete files (nothing deleted, the file is still there)',
    ok2xx(del) && Array.isArray(del.body) && del.body.length === 0 && still.status === 200,
    { del, still: still.status },
  );
}

// ─── alice: ship ─────────────────────────────────────────────────────────
let buildId;
{
  const missing = await rpc(alice, 'ship_build', {
    p_battle_id: battle,
    p_name: 'Snack Overflow',
    p_stats: {},
  });
  check(
    'ship_build without the final files: files_missing',
    missing.body?.message === 'files_missing',
    missing,
  );

  const src = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/source.json`,
    SOURCE,
    'application/json',
  );
  const js = await upload(
    alice,
    'ephemeral-builds',
    `${prefix}/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check('the final source.json and bundle.js upload', ok2xx(src) && ok2xx(js), { src, js });

  const ship = await rpc(alice, 'ship_build', {
    p_battle_id: battle,
    p_name: 'Snack Overflow',
    p_stats: { files: 2, lines: 1, deps: ['canvas-confetti'] },
  });
  check(
    'ship_build ships and the solo battle goes straight to RESULTS',
    ship.body?.build?.status === 'shipped' && ship.body?.battle?.phase === 'results',
    ship,
  );
  buildId = ship.body?.build?.id;

  const late = await upload(alice, 'ephemeral-builds', `${prefix}/thumb.webp`, 'x', 'image/webp');
  check('nothing can be uploaded after ship', deniedByRls(late), late);
  const twice = await rpc(alice, 'ship_build', {
    p_battle_id: battle,
    p_name: 'again',
    p_stats: {},
  });
  check('a second ship: already_shipped', twice.body?.message === 'already_shipped', twice);

  const pub = await rpc(bob, 'get_battle_snapshot', { p_battle_id: battle });
  check(
    'another signed-in user can read the results (public results page)',
    pub.body?.battle?.phase === 'results' && pub.body?.me?.is_player === false,
    pub,
  );
}

// ─── capture worker (simulated) ──────────────────────────────────────────
const shotPath = `${battle}/${buildId}.webp`;
{
  // Put our job first in line, so jobs left over from earlier runs do not interfere.
  sql(
    `update public.jobs set run_after = '-infinity' where kind = 'capture' and ref_id = '${buildId}'`,
  );
  const job = await rpc(service, 'claim_job', { p_kind: 'capture' });
  check(
    'the capture worker claims the job',
    job.body?.ref_id === buildId && job.body?.status === 'running',
    job,
  );
  const bundle = await download(service, 'ephemeral-builds', `${prefix}/bundle.js`);
  check(
    'the service role reads the shipped bundle',
    bundle.status === 200 && bundle.body === BUNDLE,
    bundle,
  );

  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const put = await upload(service, 'screenshots', shotPath, webp, 'image/webp');
  check('the service role writes the screenshot', ok2xx(put), put);
  const done = await rpc(service, 'complete_capture', {
    p_build_id: buildId,
    p_status: 'captured',
    p_path: shotPath,
  });
  check('complete_capture succeeds', ok2xx(done), done);

  const publicShot = await fetch(`${API_URL}/storage/v1/object/public/screenshots/${shotPath}`);
  check(
    'the screenshot is readable through its public URL without a session',
    publicShot.status === 200,
    {
      status: publicShot.status,
    },
  );
}

// ─── RESULTS → DESTROYED by pg_cron, then the destroy worker ─────────────
{
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battle}'`,
  );
  const snap = await waitForPhase(alice, battle, 'destroyed', 20_000);
  check(
    'pg_cron (sweep_deadlines) moves RESULTS → DESTROYED within 20 s',
    snap?.battle?.phase === 'destroyed',
    snap,
  );

  sql(
    `update public.jobs set run_after = '-infinity' where kind = 'destroy' and ref_id = '${battle}'`,
  );
  const job = await rpc(service, 'claim_job', { p_kind: 'destroy' });
  check('the destroy worker claims the job', job.body?.ref_id === battle, job);

  const paths = ['source.json', 'bundle.js', 'autosave/bundle.js'].map((f) => `${prefix}/${f}`);
  const del = await removeObjects(service, 'ephemeral-builds', paths);
  check(
    'the service role deletes the ephemeral files through the Storage API',
    ok2xx(del) && del.body?.length === 3,
    del,
  );
  const done = await rpc(service, 'complete_destroy', { p_battle_id: battle });
  check('complete_destroy succeeds', ok2xx(done), done);

  const left = sql(
    `select count(*) from storage.objects where bucket_id = 'ephemeral-builds' and name like '${battle}/%'`,
  );
  check('no ephemeral objects are left for the battle', left === '0', left);
  const after = await rpc(alice, 'get_battle_snapshot', { p_battle_id: battle });
  check(
    'the snapshot shows destroyed_at and source_destroyed_at; the screenshot stays',
    after.body?.battle?.destroyed_at &&
      after.body?.builds?.[0]?.source_destroyed_at &&
      after.body?.builds?.[0]?.screenshot_path === shotPath,
    after,
  );
}

// ─── bob: autosave only, deadlines driven by pg_cron → auto_shipped ──────
{
  const start2 = await rpc(bob, 'start_solo_battle', {
    p_display_name: 'bob',
    p_time_limit_seconds: 180,
  });
  const b2 = start2.body;
  check('bob starts a battle', ok2xx(start2), start2);
  sql(`update public.battles set phase_ends_at = now() - interval '1 second' where id = '${b2}'`);
  const building = await waitForPhase(bob, b2, 'building', 20_000);
  check('pg_cron moves SPINNING → BUILDING', building?.battle?.phase === 'building', building);

  const p2 = `${b2}/${bob.id}`;
  const a1 = await upload(
    bob,
    'ephemeral-builds',
    `${p2}/autosave/source.json`,
    SOURCE,
    'application/json',
  );
  const a2 = await upload(
    bob,
    'ephemeral-builds',
    `${p2}/autosave/bundle.js`,
    BUNDLE,
    'text/javascript',
  );
  check('bob autosaves', ok2xx(a1) && ok2xx(a2), { a1, a2 });

  // The build deadline passes; nobody nudges. The sweep enters SHIPPING with the 15 s grace;
  // move that deadline too instead of waiting it out.
  sql(`update public.battles set building_started_at = now() - interval '200 seconds',
         building_ends_at = now() - interval '20 seconds', phase_ends_at = now() - interval '20 seconds'
       where id = '${b2}'`);
  const shipping = await waitForPhase(bob, b2, 'shipping', 20_000);
  check('pg_cron moves BUILDING → SHIPPING', shipping?.battle?.phase === 'shipping', shipping);
  const late = await upload(
    bob,
    'ephemeral-builds',
    `${p2}/autosave/bundle.js`,
    BUNDLE,
    'text/javascript',
    {
      upsert: true,
    },
  );
  check(
    'after the deadline + grace, the autosave can no longer be overwritten',
    deniedByRls(late),
    late,
  );
  sql(`update public.battles set phase_ends_at = now() - interval '1 second' where id = '${b2}'`);
  const results = await waitForPhase(bob, b2, 'results', 20_000);
  check(
    'pg_cron moves SHIPPING → RESULTS and auto-ships the autosave',
    results?.battle?.phase === 'results' &&
      results?.builds?.[0]?.status === 'auto_shipped' &&
      results?.builds?.[0]?.completion_ms === 180_000,
    results,
  );
}

console.log(`1..${passed + failed}`);
console.log(`# passed ${passed}, failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);
