/**
 * Helpers to drive the solo loop on the real local Supabase stack, through the same HTTP
 * APIs the app uses (same patterns as supabase/scripts/e2e-solo.mjs). Time is simulated by
 * moving deadlines with psql as the superuser, as the pgTAP tests do.
 *
 * Connection settings: API_URL, ANON_KEY, SERVICE_ROLE_KEY and DB_URL from the environment,
 * or from `supabase status -o env`.
 */
import { execFileSync } from 'node:child_process';
import type { Job, JobKind } from '../src/backend';
import { SupabaseBackend, type SupabaseBackendOptions } from '../src/supabase';

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

  /**
   * A moderator (T-024): an email/password user created with the Auth admin API, listed in
   * private.admins, signed in with the password grant (a non-anonymous token).
   */
  async createAdmin(): Promise<User> {
    const email = `mod-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}@capture.test`;
    const password = `pw-${String(Math.random()).slice(2)}-Aa1`;
    const created = await this.request('POST', '/auth/v1/admin/users', {
      apikey: this.env.SERVICE_ROLE_KEY,
      token: this.env.SERVICE_ROLE_KEY,
      body: { email, password, email_confirm: true },
    });
    const id = (created.body as { id?: string }).id;
    if (created.status !== 200 || !id) {
      throw new Error(`admin user creation failed: ${JSON.stringify(created)}`);
    }
    this.sql(`insert into private.admins (user_id, note) values ('${id}', 'capture integration')`);
    const signedIn = await this.request('POST', '/auth/v1/token?grant_type=password', {
      body: { email, password },
    });
    const token = (signedIn.body as { access_token?: string }).access_token;
    if (signedIn.status !== 200 || !token) {
      throw new Error(`admin sign-in failed: ${JSON.stringify(signedIn)}`);
    }
    return new User(this, id, token);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The worker's backend in the integration test: the real SupabaseBackend, except that it
 * only claims jobs of the builds and battles this test created (`own()`).
 *
 * The stack's queue is shared: other scripts (the solo, multiplayer and Realtime e2e, the
 * web e2e) leave capture and destroy jobs behind, and the real `claim_job` rightly hands
 * them out first (oldest `run_after`). So the claim runs `claim_job` itself, as the
 * superuser, in one transaction that parks every foreign claimable job of that kind
 * (`run_after = infinity`) and restores it before committing: other sessions never see a
 * foreign job change, and the claim logic under test (order, lease, attempts) stays the
 * product's. Test-only: the product worker claims everything.
 */
export class OwnJobsBackend extends SupabaseBackend {
  private readonly refs = new Set<string>();

  constructor(
    private readonly stack: Stack,
    opts: SupabaseBackendOptions,
  ) {
    super(opts);
  }

  /** Lets the worker claim the jobs of this build (capture, takedown) or battle (destroy). */
  own(refId: string): void {
    if (!UUID.test(refId)) throw new Error(`not a uuid: ${refId}`);
    this.refs.add(refId);
  }

  override claimJob(kind: JobKind): Promise<Job | null> {
    if (this.refs.size === 0) return Promise.resolve(null);
    const refs = [...this.refs].map((r) => `'${r}'`).join(',');
    const k = ({ capture: 'capture', destroy: 'destroy', takedown: 'takedown' } as const)[kind];
    // One psql command string = one transaction; only the last statement prints a row.
    const out = this.stack.sql(`
      create temp table parked on commit drop as
        select id, run_after from public.jobs
        where kind = '${k}' and status in ('queued', 'running') and ref_id not in (${refs});
      update public.jobs j set run_after = 'infinity' from parked p where j.id = p.id;
      create temp table claimed on commit drop as select * from public.claim_job('${k}');
      update public.jobs j set run_after = p.run_after from parked p where j.id = p.id;
      select coalesce((select row_to_json(c) from claimed c where c.id is not null), 'null');`);
    const last = out.split('\n').pop() ?? 'null';
    return Promise.resolve(JSON.parse(last) as Job | null);
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
