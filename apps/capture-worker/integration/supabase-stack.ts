/**
 * Helpers to drive the solo loop on the real local Supabase stack, through the same HTTP
 * APIs the app uses (same patterns as supabase/scripts/e2e-solo.mjs). Time is simulated by
 * moving deadlines with psql as the superuser, as the pgTAP tests do.
 *
 * Connection settings: API_URL, ANON_KEY, SERVICE_ROLE_KEY and DB_URL from the environment,
 * or from `supabase status -o env`.
 */
import { execFileSync } from 'node:child_process';

export interface StackEnv {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
  DB_URL: string;
}

const KEYS = ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'DB_URL'] as const;

export function loadStackEnv(): StackEnv {
  const env: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const k of KEYS) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (KEYS.some((k) => !env[k])) {
    const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
      const key = m?.[1] as (typeof KEYS)[number] | undefined;
      if (key && KEYS.includes(key) && !env[key] && m?.[2]) env[key] = m[2];
    }
  }
  for (const k of KEYS) if (!env[k]) throw new Error(`missing ${k} (is the local stack running?)`);
  return env as StackEnv;
}

export class Stack {
  constructor(readonly env: StackEnv) {}

  /** Runs SQL as the superuser; returns the unaligned, tuples-only output. */
  sql(query: string): string {
    return execFileSync(
      'psql',
      [this.env.DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
      { encoding: 'utf8' },
    ).trim();
  }

  async request(
    method: string,
    path: string,
    opts: {
      token?: string;
      apikey?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const raw = opts.body instanceof Uint8Array || typeof opts.body === 'string';
    const res = await fetch(`${this.env.API_URL}${path}`, {
      method,
      headers: {
        apikey: opts.apikey ?? this.env.ANON_KEY,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body === undefined
        ? {}
        : { body: raw ? (opts.body as BodyInit) : JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body };
  }

  async signUp(): Promise<User> {
    const res = await this.request('POST', '/auth/v1/signup', { body: {} });
    const body = res.body as { access_token?: string; user?: { id: string } };
    if (res.status !== 200 || !body.access_token || !body.user) {
      throw new Error(`anonymous sign-up failed: ${JSON.stringify(res)}`);
    }
    return new User(this, body.user.id, body.access_token);
  }

  /** Moves the battle's current deadline into the past. */
  expirePhase(battleId: string): void {
    this.sql(
      `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battleId}'`,
    );
  }
}

export class User {
  constructor(
    readonly stack: Stack,
    readonly id: string,
    readonly token: string,
  ) {}

  async rpc(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const res = await this.stack.request('POST', `/rest/v1/rpc/${fn}`, {
      token: this.token,
      body: args,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${fn}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  async snapshot(battleId: string): Promise<Snapshot> {
    return (await this.rpc('get_battle_snapshot', { p_battle_id: battleId })) as Snapshot;
  }

  /** Calls advance_battle with the current version (after the caller moved a deadline). */
  async advance(battleId: string): Promise<Snapshot> {
    const snap = await this.snapshot(battleId);
    await this.rpc('advance_battle', {
      p_battle_id: battleId,
      p_expected_version: snap.battle.version,
    });
    return this.snapshot(battleId);
  }

  async upload(path: string, content: Uint8Array | string, contentType: string): Promise<void> {
    const res = await this.stack.request('POST', `/storage/v1/object/ephemeral-builds/${path}`, {
      token: this.token,
      body: content,
      headers: { 'content-type': contentType, 'x-upsert': 'true' },
    });
    if (res.status !== 200) throw new Error(`upload ${path}: ${JSON.stringify(res.body)}`);
  }

  /** start_solo_battle, then SPINNING → BUILDING. */
  async startBuilding(): Promise<string> {
    const battle = (await this.rpc('start_solo_battle', {
      p_display_name: 'capture-test',
      p_time_limit_seconds: 300,
    })) as string;
    this.stack.expirePhase(battle);
    const snap = await this.advance(battle);
    if (snap.battle.phase !== 'building')
      throw new Error(`expected building, got ${snap.battle.phase}`);
    return battle;
  }
}

export interface Snapshot {
  battle: { id: string; phase: string; version: number; destroyed_at: string | null };
  builds: {
    id: string;
    status: string;
    capture_status: string;
    screenshot_path: string | null;
    source_destroyed_at: string | null;
  }[];
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
