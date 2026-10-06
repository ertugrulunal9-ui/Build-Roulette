// Shared helpers for the multiplayer and Realtime end-to-end scripts (T-016). They drive
// the local Supabase stack through @supabase/supabase-js, the client the web app uses.
// `supabase/` is not a workspace package, so supabase-js is resolved from apps/web (run
// `pnpm install` first). e2e-solo.mjs predates this file and stays dependency-free.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireFromWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createClient } = requireFromWeb('@supabase/supabase-js');

// ─── Environment ─────────────────────────────────────────────────────────
export function loadEnv() {
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

export const env = loadEnv();

// ─── Tiny test harness (TAP-like output) ─────────────────────────────────
let passed = 0;
let failed = 0;

// JSON for diagnostics: skips the (circular) Realtime channel objects.
function show(detail) {
  const seen = new WeakSet();
  return JSON.stringify(detail, (key, value) => {
    if (key === 'channel') return undefined;
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  });
}

export function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`ok ${passed + failed} - ${name}`);
    if (process.env.VERBOSE && detail !== undefined) {
      console.log(`#   ${show(detail).slice(0, 400)}`);
    }
  } else {
    failed += 1;
    console.log(`not ok ${passed + failed} - ${name}`);
    if (detail !== undefined) console.log(`#   ${show(detail)}`);
  }
  return ok;
}

export function finish() {
  console.log(`1..${passed + failed}`);
  console.log(`# passed ${passed}, failed ${failed}`);
  return failed === 0 ? 0 : 1;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, timeoutMs = 10_000, intervalMs = 100) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) return value;
    await sleep(intervalMs);
  }
}

// ─── Database (time travel, as the pgTAP tests do) ───────────────────────
export function sql(query) {
  return execFileSync(
    'psql',
    [env.DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

// ─── Clients ─────────────────────────────────────────────────────────────
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { params: { log_level: 'error' } },
};

/** An anonymous player with their own supabase-js client (and Realtime connection). */
export async function newPlayer(label) {
  const client = createClient(env.API_URL, env.ANON_KEY, clientOptions);
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw new Error(`anonymous sign-in failed for ${label}: ${error.message}`);
  await client.realtime.setAuth(data.session.access_token);
  return { label, client, id: data.user.id, token: data.session.access_token };
}

export function serviceClient() {
  return createClient(env.API_URL, env.SERVICE_ROLE_KEY, clientOptions);
}

/** Calls an RPC; returns { data, error } with error = the stable snake_case code or null. */
export async function rpc(who, fn, args = {}) {
  const { data, error } = await who.client.rpc(fn, args);
  return { data, error: error ? error.message : null, details: error?.details };
}

/**
 * Subscribes `who` to a private topic and records every broadcast (all events) and the
 * presence state. Resolves once the join is decided: { status: 'SUBSCRIBED' | 'CHANNEL_ERROR'
 * | 'TIMED_OUT' | 'CLOSED', error }.
 */
export async function subscribe(who, topic, { isPrivate = true, timeoutMs = 10_000 } = {}) {
  const sub = { topic, events: [], presence: {}, status: 'PENDING', error: null };
  const channel = who.client.channel(topic, {
    config: { private: isPrivate, presence: { key: who.id } },
  });
  sub.channel = channel;
  channel
    .on('broadcast', { event: '*' }, (msg) => sub.events.push(msg))
    .on('presence', { event: 'sync' }, () => {
      sub.presence = channel.presenceState();
    });
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.status = 'TIMED_OUT';
      resolve();
    }, timeoutMs);
    channel.subscribe((status, err) => {
      if (sub.status === 'SUBSCRIBED' && status !== 'SUBSCRIBED') return;
      sub.status = status;
      sub.error = err ? String(err.message ?? err) : null;
      if (status !== 'PENDING') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return sub;
}

/** The payloads of the broadcasts received on a subscription, in arrival order. */
export const payloads = (sub) => sub.events.map((e) => e.payload);

/** True when `versions` is exactly from..to in order (gap-free, no duplicates). */
export function isRun(versions, from, to) {
  if (versions.length !== to - from + 1) return false;
  return versions.every((v, i) => v === from + i);
}
