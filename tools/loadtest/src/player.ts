/**
 * One simulated player: its own supabase-js client (its own Realtime WebSocket), signed in
 * as its own user, with timed RPCs, storage calls and private-topic subscriptions.
 *
 * Sign-in (`--auth`):
 * - `admin` (default): the user is created through the Auth admin API with the service key
 *   (`auth.admin.createUser`, email + password, confirmed), then signs in with
 *   `signInWithPassword` like any client. The local stack limits anonymous sign-ups to 300
 *   per hour (supabase/config.toml), which a 400-client run exceeds; the admin API has no
 *   such limit, and password sign-ins were not limited locally at this scale (measured:
 *   45 in 12 s, no 429). The users are regular (non-anonymous) users; nothing in the game
 *   RPCs treats them differently (only `is_admin` looks at `is_anonymous`).
 * - `anonymous`: `signInAnonymously`, exactly like the web app. Fine for the smoke profile.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Metrics } from './metrics';
import type { Rng } from './rng';

export interface ClientDeps {
  apiUrl: string;
  anonKey: string;
  serviceKey: string;
  metrics: Metrics;
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
  auth: 'admin' | 'anonymous';
  runId: string;
}

export type RpcResult<T> = { data: T; error: null } | { data: null; error: string };

export const now = (): number => performance.timeOrigin + performance.now();

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

let adminClient: SupabaseClient | null = null;

function makeClient(deps: ClientDeps, key: string): SupabaseClient {
  return createClient<unknown>(deps.apiUrl, key, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: deps.fetch },
    realtime: { transport: deps.WebSocket, params: { log_level: 'error' } },
  });
}

/** Maps a supabase-js error to a stable code for the error table. */
export function errorCode(
  e: {
    message?: string | undefined;
    code?: string | undefined;
    status?: number | undefined;
  } | null,
): string {
  if (!e) return 'unknown';
  const msg = e.message ?? '';
  if (e.code === 'PT429' || msg === 'rate_limited') return 'rate_limited';
  if (/abort|timed? ?out/i.test(msg)) return 'timeout';
  if (/fetch failed|network|ECONN/i.test(msg)) return 'network';
  if (/^[a-z][a-z0-9_]{2,60}$/.test(msg)) return msg;
  return `other:${msg.slice(0, 60)}`;
}

export class SimPlayer {
  readonly client: SupabaseClient;
  id = '';
  private stopped = false;

  constructor(
    readonly deps: ClientDeps,
    readonly label: string,
    readonly name: string,
    readonly rng: Rng,
  ) {
    this.client = makeClient(deps, deps.anonKey);
  }

  get metrics(): Metrics {
    return this.deps.metrics;
  }

  async signIn(): Promise<void> {
    const d = this.deps;
    let token: string;
    if (d.auth === 'anonymous') {
      const { data, error } = await this.client.auth.signInAnonymously();
      if (error || !data.session)
        throw new Error(`anonymous sign-in: ${error?.message ?? 'no session'}`);
      this.id = data.user?.id ?? '';
      token = data.session.access_token;
    } else {
      adminClient ??= makeClient(d, d.serviceKey);
      const email = `${this.label}@${d.runId}.loadtest.local`;
      const password = `pw-${d.runId}-loadtest`;
      const created = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) throw new Error(`admin createUser: ${created.error.message}`);
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(`password sign-in: ${error.message}`);
      this.id = data.user.id;
      token = data.session.access_token;
    }
    await this.client.realtime.setAuth(token);
    this.metrics.clientStarted(this.id);
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<RpcResult<T>> {
    try {
      const res = await this.client.rpc(fn, args);
      if (res.error) {
        const code = errorCode(res.error);
        this.metrics.rpcError(fn, code);
        return { data: null, error: code };
      }
      return { data: res.data as T, error: null };
    } catch (e) {
      const code = errorCode(e as Error);
      this.metrics.rpcError(fn, code);
      return { data: null, error: code };
    }
  }

  /** `select version from battles where id = …` (the T-023 check with every heartbeat). */
  async battleVersion(battleId: string): Promise<number | null> {
    try {
      const res = await this.client
        .from('battles')
        .select('version')
        .eq('id', battleId)
        .maybeSingle<{ version: number }>();
      if (res.error) {
        this.metrics.rpcError('rest:battles', errorCode(res.error));
        return null;
      }
      return res.data?.version ?? null;
    } catch (e) {
      this.metrics.rpcError('rest:battles', errorCode(e as Error));
      return null;
    }
  }

  async upload(
    path: string,
    body: string | Uint8Array<ArrayBuffer>,
    type: string,
  ): Promise<boolean> {
    try {
      const { error } = await this.client.storage
        .from('ephemeral-builds')
        .upload(path, new Blob([body], { type }), { contentType: type, upsert: true });
      if (error) {
        this.metrics.rpcError('storage:upload', errorCode(error));
        return false;
      }
      return true;
    } catch (e) {
      this.metrics.rpcError('storage:upload', errorCode(e as Error));
      return false;
    }
  }

  async download(path: string): Promise<number | null> {
    try {
      const { data, error } = await this.client.storage.from('ephemeral-builds').download(path);
      if (error) {
        this.metrics.rpcError('storage:download', errorCode(error));
        return null;
      }
      return data.size;
    } catch (e) {
      this.metrics.rpcError('storage:download', errorCode(e as Error));
      return null;
    }
  }

  /** A permanent screenshot through its public URL (what an <img> on RESULTS loads). */
  async downloadPublic(path: string): Promise<number | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    try {
      const res = await this.deps.fetch(
        `${this.deps.apiUrl}/storage/v1/object/public/screenshots/${encoded}`,
      );
      const buf = await res.arrayBuffer();
      if (!res.ok) {
        this.metrics.rpcError('storage:public', `http_${String(res.status)}`);
        return null;
      }
      return buf.byteLength;
    } catch (e) {
      this.metrics.rpcError('storage:public', errorCode(e as Error));
      return null;
    }
  }

  subscribe(
    topic: string,
    opts: { presence: boolean },
    onBroadcast: (payload: Record<string, unknown>, at: number) => void,
  ): Topic {
    return new Topic(this, topic, opts.presence, onBroadcast);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.client.removeAllChannels();
      void this.client.realtime.disconnect();
      await this.client.auth.stopAutoRefresh();
    } catch {
      // best effort
    }
    this.metrics.clientStopped(this.id);
  }
}

/**
 * A private topic with the web client's rules: `config.private`, a presence key on the room
 * topic only, Presence at most once per 2 s and 4 times per 30 s (Realtime closes a channel
 * after more than 5 per 30 s), and a re-subscribe with backoff when the server closes it.
 */
export class Topic {
  private channel: RealtimeChannel | null = null;
  private closed = false;
  private subscribedOnce = false;
  private resubscribeMs = 1000;
  private trackTimes: number[] = [];
  private lastTrackAt = 0;
  private pending: object | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  status = 'PENDING';

  constructor(
    private readonly player: SimPlayer,
    readonly topic: string,
    private readonly presence: boolean,
    private readonly onBroadcast: (payload: Record<string, unknown>, at: number) => void,
  ) {}

  /** Resolves with the first decided status (SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED). */
  subscribe(timeoutMs = 15_000): Promise<string> {
    const m = this.player.metrics;
    const channel = this.player.client.channel(this.topic, {
      config: this.presence
        ? { private: true, presence: { key: this.player.id } }
        : { private: true },
    });
    this.channel = channel;
    channel.on('broadcast', { event: '*' }, (msg: { payload?: Record<string, unknown> }) => {
      if (!this.closed && msg.payload) this.onBroadcast(msg.payload, now());
    });
    if (this.presence) {
      channel.on('presence', { event: 'sync' }, () => {
        m.count('presence_sync');
      });
    }
    const t0 = now();
    return new Promise((resolve) => {
      let decided = false;
      const timer = setTimeout(() => {
        if (!decided) {
          decided = true;
          m.channelStatus('TIMED_OUT(15s)');
          resolve('TIMED_OUT');
        }
      }, timeoutMs);
      channel.subscribe((status) => {
        const st: string = status;
        m.channelStatus(st);
        this.status = st;
        if (st === 'SUBSCRIBED') {
          if (!this.subscribedOnce) {
            this.player.metrics.observe(
              `realtime:join:${this.topic.split(':')[0] ?? ''}`,
              now() - t0,
            );
          }
          this.subscribedOnce = true;
          this.resubscribeMs = 1000;
        }
        if (st === 'CLOSED' && !this.closed && this.channel === channel) {
          // Closed by the server (rate limit, expired token): supabase-js does not rejoin.
          m.count('channel_closed_by_server');
          this.channel = null;
          const wait = this.resubscribeMs;
          this.resubscribeMs = Math.min(30_000, this.resubscribeMs * 2);
          setTimeout(() => {
            if (this.closed) return;
            void this.player.client.removeChannel(channel).finally(() => {
              if (!this.closed) void this.subscribe(timeoutMs);
            });
          }, wait);
        }
        if (!decided) {
          decided = true;
          clearTimeout(timer);
          resolve(st);
        }
      });
    });
  }

  /** Presence with the client's throttle (latest payload wins, deferred when over budget). */
  track(payload: object): void {
    if (!this.presence || this.closed) return;
    this.pending = payload;
    this.flush();
  }

  private flush(): void {
    if (!this.pending || this.closed || !this.channel || this.status !== 'SUBSCRIBED') return;
    const t = now();
    this.trackTimes = this.trackTimes.filter((x) => x > t - 30_000);
    let wait = this.lastTrackAt + 2_000 - t;
    const oldest = this.trackTimes[0];
    if (this.trackTimes.length >= 4 && oldest !== undefined) {
      wait = Math.max(wait, oldest + 30_000 - t);
    }
    if (wait > 0) {
      if (!this.pendingTimer) {
        this.player.metrics.raw.presence.deferred++;
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          this.flush();
        }, wait);
      }
      return;
    }
    const payload = this.pending;
    this.pending = null;
    this.lastTrackAt = t;
    this.trackTimes.push(t);
    this.player.metrics.raw.presence.sent++;
    const channel = this.channel;
    void channel.track(payload).then(
      (r) => {
        if (r !== 'ok') this.player.metrics.raw.presence.failed++;
      },
      () => {
        this.player.metrics.raw.presence.failed++;
      },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    const ch = this.channel;
    this.channel = null;
    if (ch) await this.player.client.removeChannel(ch).catch(() => undefined);
  }
}
