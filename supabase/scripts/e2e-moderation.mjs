#!/usr/bin/env node
// Moderation through the real HTTP APIs (T-024), with @supabase/supabase-js like the app:
//   * join_room's failed codes are RETURNED as HTTP 404/400 errors and the failure is
//     COMMITTED (PostgREST commits a function that sets response.status), so 20 wrong
//     codes in 10 minutes lock the user out with HTTP 429 `rate_limited`;
//   * `rate_limited` carries {"retry_after_s": n} in the hint;
//   * the name filter answers `name_not_allowed` (HTTP 400);
//   * a player reports a public build; an email admin (seed-admin.mjs) signs in with a
//     password, sees the report in the queue and takes the build down; the anon-key
//     results page data hide it; a non-admin and an anonymous user get `not_admin`.
//
//   node supabase/scripts/e2e-moderation.mjs
//
// Needs the local stack, `psql` on PATH and `pnpm install`. Commits data (users, rooms, a
// finished battle inserted with psql, an admin). VERBOSE=1 prints details.

import { createRequire } from 'node:module';
import { check, env, finish, newPlayer, sql } from './lib.mjs';
import { seedAdmin } from './seed-admin.mjs';

const requireFromWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createClient } = requireFromWeb('@supabase/supabase-js');
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/** rpc with the HTTP status and the whole PostgREST error. */
async function call(who, fn, args = {}) {
  const res = await who.client.rpc(fn, args);
  return { data: res.data, status: res.status, error: res.error };
}
const failures = (id) =>
  Number(
    sql(
      `select count(*) from private.rate_events where user_id = '${id}' and action = 'join_room_failed'`,
    ),
  );

const host = await newPlayer('host');
const guesser = await newPlayer('guesser');
const reporter = await newPlayer('reporter');

// ─── join_room: failures are counted, then rate_limited ──────────────────
const room = await call(host, 'create_room', { p_display_name: 'Host' });
check('the host creates a room', room.status === 200 && room.data?.code, room);

const wrong = await call(guesser, 'join_room', { p_code: 'ZZZZZ', p_display_name: 'Guesser' });
check(
  'a wrong code: HTTP 404 room_not_found, as before (supabase-js error)',
  wrong.status === 404 &&
    wrong.error?.message === 'room_not_found' &&
    wrong.error?.code === 'P0002',
  wrong,
);
check('…and the failure was committed', failures(guesser.id) === 1, failures(guesser.id));

for (let i = 2; i <= 20; i++) {
  await call(guesser, 'join_room', { p_code: 'ZZZZZ', p_display_name: 'Guesser' });
}
check('20 failures are recorded', failures(guesser.id) === 20, failures(guesser.id));
const locked = await call(guesser, 'join_room', {
  p_code: room.data.code,
  p_display_name: 'Guesser',
});
let retry = null;
try {
  retry = JSON.parse(locked.error?.hint ?? 'null')?.retry_after_s ?? null;
} catch {
  retry = null;
}
check(
  'the 21st attempt (even with the right code): HTTP 429 rate_limited with retry_after_s',
  locked.status === 429 && locked.error?.message === 'rate_limited' && retry > 0 && retry <= 600,
  locked,
);
check(
  'the details are a sentence for people',
  /Try again in \d+ (seconds|minutes)\./.test(locked.error?.details ?? ''),
  locked.error,
);
const ok = await call(reporter, 'join_room', {
  p_code: room.data.code,
  p_display_name: 'Reporter',
});
check('another user still joins', ok.status === 200 && ok.data?.role === 'player', ok);

// ─── The name filter ─────────────────────────────────────────────────────
const bad = await call(reporter, 'create_room', { p_display_name: 'F u c k' });
check(
  'a blocked display name: HTTP 400 name_not_allowed',
  bad.status === 400 && bad.error?.message === 'name_not_allowed',
  bad,
);
const badSolo = await call(reporter, 'start_solo_battle', { p_display_name: 'sh1t' });
check('start_solo_battle too', badSolo.error?.message === 'name_not_allowed', badSolo);

// ─── Report → admin → takedown ───────────────────────────────────────────
// A finished battle (inserted as the superuser): the host's build is public.
const ids = JSON.parse(
  sql(`with c as (insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
                   values ('Moderation e2e', 'Rule', 'Style', 300) returning id),
            b as (insert into public.battles (challenge_id, host_id, settings, phase, finished_at, is_complete)
                  select id, '${host.id}', '{"mode":"solo"}', 'results', now(), true from c returning id),
            p as (insert into public.battle_players (battle_id, user_id, display_name)
                  select id, '${host.id}', 'Host' from b returning battle_id),
            u as (insert into public.builds (battle_id, builder_id, name, status, final_rank, capture_status,
                                             screenshot_path, shipped_at, completion_ms)
                  select battle_id, '${host.id}', 'Free Gift Card', 'shipped', 1, 'captured',
                         battle_id || '/x.webp', now(), 1000 from p returning id, battle_id)
       select json_build_object('battle', battle_id, 'build', id) from u`),
);

const rep = await call(reporter, 'report_build', {
  p_build_id: ids.build,
  p_reason: 'phishing',
  p_details: 'Asks for my password',
});
check(
  'a player reports the public build',
  rep.status === 200 && rep.data?.build_id === ids.build,
  rep,
);
const again = await call(reporter, 'report_build', { p_build_id: ids.build, p_reason: 'spam' });
check(
  'a second report by the same user: already_reported',
  again.error?.message === 'already_reported',
  again,
);
const own = await call(host, 'report_build', { p_build_id: ids.build, p_reason: 'spam' });
check('the builder cannot report their own build', own.error?.message === 'own_build', own);

const notAdmin = await call(reporter, 'admin_report_queue');
check(
  'an anonymous player gets not_admin (HTTP 403)',
  notAdmin.status === 403 && notAdmin.error?.message === 'not_admin',
  notAdmin,
);
const anonClient = { client: createClient(env.API_URL, env.ANON_KEY, clientOptions) };
const noSession = await call(anonClient, 'admin_report_queue');
check('no session at all: refused by the grant (401)', noSession.status === 401, noSession);

const adminCreds = {
  email: `mod-${Date.now()}@moderation.e2e`,
  password: `pw-${Math.random().toString(36).slice(2)}-Aa1`,
};
await seedAdmin(adminCreds);
const admin = { client: createClient(env.API_URL, env.ANON_KEY, clientOptions) };
const signIn = await admin.client.auth.signInWithPassword(adminCreds);
check(
  'the admin signs in with email and password',
  !signIn.error && signIn.data.session,
  signIn.error,
);
const isAdmin = await call(admin, 'is_admin');
check('is_admin() is true for them', isAdmin.data === true, isAdmin);
const queue = await call(admin, 'admin_report_queue');
const item = queue.data?.builds?.find((b) => b.build_id === ids.build);
check(
  'the report queue lists the build with its reason and details',
  item?.reasons?.phishing === 1 &&
    item?.reports?.[0]?.details === 'Asks for my password' &&
    item?.name === 'Free Gift Card',
  item,
);
const td = await call(admin, 'admin_take_down_build', { p_build_id: ids.build, p_note: 'e2e' });
check(
  'the admin takes it down',
  td.status === 200 && td.data?.disqualified === false && td.data?.actioned_reports === 1,
  td,
);
const pub = await call(anonClient, 'get_public_battle', { p_battle_id: ids.battle });
const shown = pub.data?.builds?.[0];
check(
  'the anon-key results: taken_down, no name, no screenshot, rank kept',
  shown?.taken_down === true &&
    shown?.name === null &&
    shown?.screenshot_path === null &&
    shown?.final_rank === 1,
  shown,
);
check(
  'a takedown job is queued for the worker',
  sql(`select status from public.jobs where kind = 'takedown' and ref_id = '${ids.build}'`) ===
    'queued',
);
const log = await call(admin, 'admin_action_log', { p_limit: 5 });
check(
  'the action log has the takedown',
  log.data?.[0]?.action === 'take_down_build' &&
    log.data?.[0]?.admin_email === adminCreds.email.toLowerCase(),
  log.data?.[0],
);
// The queued job stays: a worker that claims it finds no screenshot (the fixture never had
// a file) and completes it, which the capture integration test does for a real one.

process.exit(finish());
