#!/usr/bin/env node
// Keeps docs/runbooks/*.md true (T-030): every SQL block is run against the LOCAL stack.
//
//   node supabase/scripts/check-runbooks.mjs          # SQL blocks + shell syntax
//   node supabase/scripts/check-runbooks.mjs --sh     # also runs the `sh check` blocks
//
// Fenced blocks are classified by their info string:
//   ```sql          read-only: run inside a READ ONLY transaction (a write fails the check)
//   ```sql write    changes data: run inside a transaction that is rolled back
//   ```sh check     a local command: `bash -n`, and with --sh run with the local targets
//                   (APP_ORIGIN, PKG_CDN_URL, SUPABASE_URL, SUPABASE_ANON_KEY, BATTLE_ID)
//   ```sh check-cf  like `sh check`, but needs the local Workers preview's state (cf:preview)
//   ```sh / sh prod production or external only: `bash -n`
// Every SQL block runs after the fixtures below (inserted in the same transaction, so nothing
// is committed); `{{placeholder}}` values are the fixtures' ids. An unknown placeholder, a
// block of an unknown kind, or a block that fails makes the run fail (exit 1). `begin;` and
// `commit;` lines in a block are dropped (the check owns the transaction). Needs psql on PATH
// and the stack running (DB_URL from the environment or `supabase status`).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUNBOOKS = join(ROOT, 'docs/runbooks');
const RUN_SH = process.argv.includes('--sh');

// ─── Environment (dependency-free, like e2e-solo.mjs) ────────────────────
function stackEnv() {
  const keys = ['API_URL', 'ANON_KEY', 'DB_URL'];
  const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  if (keys.every((k) => env[k])) return env;
  const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
    cwd: ROOT,
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
const env = stackEnv();

// ─── Fixtures ────────────────────────────────────────────────────────────
// One of each thing the runbooks look at: a room battle in BUILDING 10 minutes past its
// deadline with a shipped build (reported) and a draft; a RESULTS battle waiting for a
// screenshot; failed and expired jobs; an admin; a leftover build file.
const ID = {
  player: 'cb000000-0000-4000-8000-000000000001',
  other: 'cb000000-0000-4000-8000-000000000002',
  admin: 'cb000000-0000-4000-8000-000000000003',
  room: 'cb000000-0000-4000-8000-0000000000a1',
  stuck: 'cb000000-0000-4000-8000-0000000000b1',
  results: 'cb000000-0000-4000-8000-0000000000b2',
  shipped: 'cb000000-0000-4000-8000-0000000000c1',
  draft: 'cb000000-0000-4000-8000-0000000000c2',
  pending: 'cb000000-0000-4000-8000-0000000000c3',
};
const PLACEHOLDERS = {
  battle_id: ID.stuck,
  build_id: ID.shipped,
  user_id: ID.player,
  room_code: 'RBK2M',
  admin_email: 'runbook-admin@runbooks.check',
};

const FIXTURES = `
insert into auth.users (id, is_anonymous, email) values
  ('${ID.player}', true, null), ('${ID.other}', true, null),
  ('${ID.admin}', false, '${PLACEHOLDERS.admin_email}');
insert into private.admins (user_id, note) values ('${ID.admin}', 'runbook check');
insert into public.profiles (id, display_name) values ('${ID.player}', 'Rita'), ('${ID.other}', 'Otto');
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds) values
  ('cb000000-0000-4000-8000-0000000000d1', 'A pomodoro timer', 'One button', 'Brutalist', 300),
  ('cb000000-0000-4000-8000-0000000000d2', 'A dice roller', 'No mouse', 'Neon', 300);
insert into public.rooms (id, code, host_id, status, settings)
values ('${ID.room}', '${PLACEHOLDERS.room_code}', '${ID.player}', 'in_battle', '{"max_players": 8}');
insert into public.room_members (room_id, user_id, role, last_seen_at) values
  ('${ID.room}', '${ID.player}', 'player', now()), ('${ID.room}', '${ID.other}', 'player', now());
insert into public.battles (id, room_id, challenge_id, host_id, settings, phase, version,
                            phase_started_at, phase_ends_at, building_started_at, building_ends_at)
values ('${ID.stuck}', '${ID.room}', 'cb000000-0000-4000-8000-0000000000d1', '${ID.player}',
        '{"mode":"multiplayer","reveal_vote":true}', 'building', 4,
        now() - interval '15 minutes', now() - interval '10 minutes',
        now() - interval '15 minutes', now() - interval '10 minutes');
update public.rooms set current_battle_id = '${ID.stuck}' where id = '${ID.room}';
insert into public.battles (id, challenge_id, host_id, settings, phase, version, phase_started_at,
                            phase_ends_at, shipping_ended_at, finished_at, is_complete)
values ('${ID.results}', 'cb000000-0000-4000-8000-0000000000d2', '${ID.other}', '{"mode":"solo"}',
        'results', 6, now() - interval '3 minutes', now() - interval '2 minutes',
        now() - interval '3 minutes', now() - interval '3 minutes', true);
insert into public.battle_players (battle_id, user_id, display_name) values
  ('${ID.stuck}', '${ID.player}', 'Rita'), ('${ID.stuck}', '${ID.other}', 'Otto'),
  ('${ID.results}', '${ID.other}', 'Otto');
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms,
                           capture_status, screenshot_path) values
  ('${ID.shipped}', '${ID.stuck}', '${ID.player}', 'Free Gift Card', 'shipped',
   now() - interval '12 minutes', 180000, 'captured', '${ID.stuck}/${ID.shipped}.webp'),
  ('${ID.draft}', '${ID.stuck}', '${ID.other}', null, 'draft', null, null, 'pending', null),
  ('${ID.pending}', '${ID.results}', '${ID.other}', 'Dice', 'shipped',
   now() - interval '4 minutes', 60000, 'pending', null);
insert into public.battle_events (battle_id, version, type, actor_id, payload) values
  ('${ID.stuck}', 1, 'phase', '${ID.player}', '{"from":null,"to":"spinning"}'),
  ('${ID.stuck}', 2, 'phase', null, '{"from":"spinning","to":"building"}'),
  ('${ID.stuck}', 3, 'ship', '${ID.player}', '{"name":"Free Gift Card"}');
insert into public.reports (build_id, reporter_id, reason, details)
values ('${ID.shipped}', '${ID.other}', 'phishing', 'Asks for a password');
insert into public.jobs (kind, ref_id, status, attempts, run_after, last_error, created_at, updated_at) values
  ('capture', '${ID.pending}', 'queued', 0, now(), null, now() - interval '20 minutes', now() - interval '20 minutes'),
  ('capture', '${ID.shipped}', 'running', 2, now() - interval '30 seconds', 'render timeout',
   now() - interval '13 minutes', now() - interval '3 minutes'),
  ('destroy', '${ID.results}', 'failed', 5, now(), 'storage: 503', now() - interval '1 hour', now() - interval '10 minutes');
insert into private.rate_events (action, user_id) values ('create_room', '${ID.player}'), ('create_room', '${ID.player}');
insert into storage.objects (bucket_id, name, created_at)
values ('screenshots', '${ID.stuck}/${ID.shipped}.webp', now() - interval '12 minutes');
`;

// ─── Markdown ────────────────────────────────────────────────────────────
function blocks(markdown) {
  const out = [];
  const re = /^( *)```([^\n`]*)\n([\s\S]*?)^\1```[ \t]*$/gm;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const indent = m[1].length;
    const body = m[3]
      .split('\n')
      .map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)))
      .join('\n');
    const line = markdown.slice(0, m.index).split('\n').length;
    out.push({ info: m[2].trim(), body, line });
  }
  return out;
}

function fill(body) {
  const unknown = [];
  const text = body.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (name in PLACEHOLDERS) return PLACEHOLDERS[name];
    unknown.push(name);
    return `{{${name}}}`;
  });
  return { text, unknown };
}

// ─── Runners ─────────────────────────────────────────────────────────────
function runSql(body, readOnly) {
  const statements = body
    .split('\n')
    .filter((l) => !/^\s*(begin|commit)\s*;\s*$/i.test(l))
    .join('\n');
  const script = [
    '\\set ON_ERROR_STOP 1',
    'begin;',
    FIXTURES,
    readOnly ? 'set transaction read only;' : '',
    statements,
    'rollback;',
  ].join('\n');
  return spawnSync('psql', [env.DB_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: script,
    encoding: 'utf8',
  });
}

function runSh(body, extraEnv) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', body], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 60_000,
  });
}

// ─── Main ────────────────────────────────────────────────────────────────
let n = 0;
let failed = 0;
const counts = { sql: 0, 'sql write': 0, sh: 0, ran: 0 };
function report(ok, name, detail) {
  n++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'not ok'} ${n} - ${name}`);
  if (!ok && detail) console.log(detail.trim().replace(/^/gm, '#   '));
}

const shEnv = {
  APP_ORIGIN: process.env.APP_ORIGIN ?? 'http://localhost:3100',
  PKG_CDN_URL: process.env.PKG_CDN_URL ?? 'http://127.0.0.1:4400',
  SUPABASE_URL: process.env.SUPABASE_URL ?? env.API_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? env.ANON_KEY,
  BATTLE_ID: process.env.BATTLE_ID ?? ID.stuck,
};
const cfState = existsSync(join(ROOT, 'apps/web/.wrangler/state'));

const files = readdirSync(RUNBOOKS)
  .filter((f) => f.endsWith('.md'))
  .sort();
for (const file of files) {
  const md = readFileSync(join(RUNBOOKS, file), 'utf8');
  for (const b of blocks(md)) {
    const where = `${file}:${String(b.line)}`;
    const kind = b.info;
    if (kind === 'sql' || kind === 'sql write') {
      const { text, unknown } = fill(b.body);
      if (unknown.length > 0) {
        report(false, `${where} (${kind})`, `unknown placeholder(s): ${unknown.join(', ')}`);
        continue;
      }
      const res = runSql(text, kind === 'sql');
      counts[kind]++;
      report(res.status === 0, `${where} (${kind})`, `${res.stderr}${res.stdout.slice(-400)}`);
      if (process.env.VERBOSE)
        console.log(`${res.stdout}${res.stderr}`.trim().replace(/^/gm, '#   '));
    } else if (/^sh( (check|check-cf|prod))?$/.test(kind)) {
      counts.sh++;
      const syntax = spawnSync('bash', ['-n', '-c', b.body], { encoding: 'utf8' });
      report(syntax.status === 0, `${where} (${kind}: bash -n)`, syntax.stderr);
      const runnable = kind === 'sh check' || (kind === 'sh check-cf' && cfState);
      if (RUN_SH && runnable) {
        const res = runSh(b.body, shEnv);
        counts.ran++;
        report(res.status === 0, `${where} (${kind}: ran)`, `${res.stderr}${res.stdout}`);
        if (process.env.VERBOSE) console.log(res.stdout.trim().replace(/^/gm, '#   '));
      }
    } else if (kind !== '' && kind !== 'text') {
      report(
        false,
        `${where}`,
        `unknown block kind "${kind}" (sql, sql write, sh, sh check, sh check-cf, sh prod)`,
      );
    }
  }
}
console.log(`1..${String(n)}`);
console.log(
  `# ${String(files.length)} runbooks: ${String(counts.sql)} read-only and ${String(counts['sql write'])} writing SQL blocks run, ${String(counts.sh)} shell blocks checked${RUN_SH ? `, ${String(counts.ran)} run` : ''}; ${String(failed)} failed`,
);
process.exit(failed === 0 ? 0 : 1);
