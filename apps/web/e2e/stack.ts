/**
 * The local Supabase stack from the solo e2e's point of view: psql as the superuser to move
 * deadlines and inspect storage (like the pgTAP tests and supabase/scripts/e2e-solo.mjs).
 * Connection settings come from the environment or `supabase status -o env`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let statusEnv: Record<string, string> | null = null;

/** DB_URL, API_URL, SERVICE_ROLE_KEY…: from the environment or `supabase status -o env`. */
function stackEnv(key: 'DB_URL' | 'API_URL' | 'SERVICE_ROLE_KEY' | 'ANON_KEY'): string {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  if (!statusEnv) {
    const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    statusEnv = {};
    for (const line of out.split('\n')) {
      const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
      if (m?.[1] && m[2]) statusEnv[m[1]] = m[2];
    }
  }
  const value = statusEnv[key];
  if (!value) throw new Error(`${key} not found: is the local Supabase stack running?`);
  return value;
}

/**
 * An object of the `ephemeral-builds` bucket as text (service role), or null if missing.
 * E.g. `{battle}/{user}/autosave/source.json`.
 */
export async function ephemeralText(path: string): Promise<string | null> {
  const key = stackEnv('SERVICE_ROLE_KEY');
  const res = await fetch(
    `${stackEnv('API_URL')}/storage/v1/object/authenticated/ephemeral-builds/${path}`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`download ${path}: HTTP ${String(res.status)}`);
  return res.text();
}

/** Uploads a file to the public `screenshots` bucket (service role), like the capture worker. */
export async function uploadScreenshot(path: string, body: Uint8Array, contentType: string) {
  const key = stackEnv('SERVICE_ROLE_KEY');
  const res = await fetch(`${stackEnv('API_URL')}/storage/v1/object/screenshots/${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': contentType,
      'x-upsert': 'true',
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`upload ${path}: HTTP ${String(res.status)} ${await res.text()}`);
}

/** The public URL of a `screenshots` object. */
export function publicScreenshotUrl(path: string): string {
  return `${stackEnv('API_URL')}/storage/v1/object/public/screenshots/${path}`;
}

/** A new anonymous auth user (Auth API sign-up, like a first visit); returns its id. */
export async function anonymousUserId(): Promise<string> {
  const anon = stackEnv('ANON_KEY');
  const res = await fetch(`${stackEnv('API_URL')}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as { user?: { id?: string } };
  if (!res.ok || !body.user?.id) throw new Error(`anonymous sign-up: HTTP ${String(res.status)}`);
  return body.user.id;
}

/** Creates (or resets) an email/password admin with supabase/scripts/seed-admin.mjs. */
export function seedAdmin(email: string, password: string): void {
  execFileSync('node', ['supabase/scripts/seed-admin.mjs', email, password], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      API_URL: stackEnv('API_URL'),
      SERVICE_ROLE_KEY: stackEnv('SERVICE_ROLE_KEY'),
      DB_URL: stackEnv('DB_URL'),
    },
  });
}

/** Runs SQL as the superuser; returns the unaligned, tuples-only output. */
export function sql(query: string): string {
  return execFileSync(
    'psql',
    [stackEnv('DB_URL'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertUuid(id: string): string {
  if (!UUID.test(id)) throw new Error(`not a uuid: ${id}`);
  return id;
}

/** Names of the battle's objects in `ephemeral-builds`. */
export function ephemeralObjects(battleId: string): string[] {
  const out = sql(
    `select name from storage.objects where bucket_id = 'ephemeral-builds' and name like '${assertUuid(battleId)}/%' order by name`,
  );
  return out === '' ? [] : out.split('\n');
}

export function battleRow(battleId: string): {
  phase: string;
  destroyed_at: string | null;
} {
  return JSON.parse(
    sql(
      `select json_build_object('phase', phase, 'destroyed_at', destroyed_at) from public.battles where id = '${assertUuid(battleId)}'`,
    ),
  ) as { phase: string; destroyed_at: string | null };
}

/** The local stack's Realtime container (`supabase_<service>_<project_id>`). */
const REALTIME_CONTAINER = 'supabase_realtime_build-roulette';

function realtimeRpc(expr: string): string {
  return execFileSync('docker', ['exec', REALTIME_CONTAINER, '/app/bin/realtime', 'rpc', expr], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Realtime stops forwarding the database's broadcasts (`realtime.send`), with every channel
 * still subscribed, until the next channel join: what the local stack's Realtime does by
 * itself every 10 minutes ("Rebalancing Tenant database connection for a closer region":
 * the node's region is `local`, the tenant's `us-east-1`). Whatever is sent meanwhile is
 * never delivered. Needs docker (the stack runs in it).
 */
export function dropRealtimeDatabaseFeed(): void {
  realtimeRpc('Realtime.Tenants.Connect.shutdown("realtime-dev")');
}

/** Whether Realtime is connected to the database (and forwards its broadcasts). */
export function realtimeDatabaseFeedUp(): boolean {
  const out = realtimeRpc('IO.puts(Realtime.Tenants.Connect.whereis("realtime-dev") != nil)');
  return out.split('\n').at(-1) === 'true';
}
