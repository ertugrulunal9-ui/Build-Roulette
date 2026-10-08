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
      // A retry after a lost response finds the user already there: sign in anyway.
      if (created.error && !/already been registered/i.test(created.error.message)) {
        throw new Error(`admin createUser: ${created.error.message}`);
      }
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
    opts: { presence: boolean; onSubscribed?: () => void },
    onBroadcast: (payload: Record<string, unknown>, at: number) => void,
  ): Topic {
    return new Topic(this, topic, opts.presence, onBroadcast, opts.onSubscribed);
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

/** BUILD activity as the web client tracks it (`typing` = edited in the last 15 s). */
export interface Activity {
  lines: number;
  last_build: 'ok' | 'error';
  typing: boolean;
}

/**
 * The web client's presence and rejoin rules (apps/web/src/lib/room/sync.ts, T-029). The
 * numbers mirror `@br/game` (PRESENCE_*) and the sync engine's DEFAULT_SYNC_TIMINGS.
 */
export const CLIENT_RULES = {
  /** Any two tracks at least this far apart. */
  presenceThrottleMs: 2_000,
  /** Activity updates at most this often, only during BUILDING, only when they matter. */
  presenceActivityMs: 15_000,
  presenceLinesStep: 20,
  /** A failing build is reported once it has failed this long (or was already reported). */
  buildErrorMs: 10_000,
  /** Realtime closes a channel above 5 presence messages per 30 s; clients stay at 4. */
  presenceMaxPerWindow: 4,
  presenceWindowMs: 30_000,
  /** Re-subscribe after a server close: 5, 10, 20, 30 s, plus up to half again at random. */
  rejoinBaseMs: 5_000,
  rejoinMaxMs: 30_000,
  rejoinJitter: 0.5,
  /** One backoff level down per this long subscribed (a SUBSCRIBED alone resets nothing). */
  rejoinDecayMs: 60_000,
} as const;

/** `activityMatters` of @br/game: active on/off, the build failing or fixed, ±20 lines. */
export function activityMatters(sent: Activity | null, next: Activity): boolean {
  if (sent === null) return true;
  return (
    sent.typing !== next.typing ||
    sent.last_build !== next.last_build ||
    Math.abs(next.lines - sent.lines) >= CLIENT_RULES.presenceLinesStep
  );
}

/** The rejoin delay for backoff level `n` and a random number in [0, 1). */
export function rejoinDelayMs(n: number, random: number): number {
  const { rejoinBaseMs, rejoinMaxMs, rejoinJitter } = CLIENT_RULES;
  const base = Math.min(rejoinBaseMs * 2 ** n, rejoinMaxMs);
  return Math.round(base * (1 + rejoinJitter * random));
}

/**
 * A private topic with the web client's rules (T-029): `config.private`, a presence key on
 * the room topic only; presence claimed after every SUBSCRIBED, BUILD activity sent only
 * during BUILDING, only when it matters, at most once per 15 s (the latest wins), any two
 * tracks 2 s apart and at most 4 per 30 s; a re-subscribe with backoff (5 s, 10 s, 20 s,
 * 30 s + jitter, decaying one level per 60 s subscribed) when the server closes it.
 */
export class Topic {
  private channel: RealtimeChannel | null = null;
  private closed = false;
  private subscribedOnce = false;
  /** Rejoin backoff level (server closes in a row, minus the decay). */
  private rejoinLevel = 0;
  private decayTimer: NodeJS.Timeout | null = null;
  private trackTimes: number[] = [];
  private lastTrackAt = Number.NEGATIVE_INFINITY;
  private identity: object | null = null;
  private activity: Activity = { lines: 0, last_build: 'ok', typing: false };
  private sentActivity: Activity | null = null;
  private buildErrorSince: number | null = null;
  private lastTracked: string | null = null;
  private claimOwed = true;
  private pendingTimer: NodeJS.Timeout | null = null;
  status = 'PENDING';
  /** Labels presence sends (the player's phase) for the per-phase presence rate. */
  phaseOf: () => string = () => 'lobby';

  constructor(
    private readonly player: SimPlayer,
    readonly topic: string,
    private readonly presence: boolean,
    private readonly onBroadcast: (payload: Record<string, unknown>, at: number) => void,
    /** Called on every SUBSCRIBED (the web client refetches its snapshot then). */
    private readonly onSubscribed: () => void = () => undefined,
  ) {}

  private get kind(): string {
    return this.topic.split(':')[0] ?? '';
  }

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
      channel.subscribe((status, err) => {
        const st: string = status;
        m.channelStatus(st);
        if (err) m.count(`channel_error:${this.kind}:${err.message.slice(0, 80)}`);
        if (this.channel === channel) this.status = st;
        if (st === 'SUBSCRIBED' && this.channel === channel && !this.closed) {
          if (!this.subscribedOnce) {
            this.player.metrics.observe(`realtime:join:${this.kind}`, now() - t0);
          } else {
            m.count(`rejoined:${this.kind}`);
          }
          this.subscribedOnce = true;
          this.scheduleDecay();
          // (Re)subscribed: claim presence again, catch up on what may have been missed.
          this.claimOwed = true;
          this.flush();
          this.onSubscribed();
        } else if (this.channel === channel && this.decayTimer) {
          clearTimeout(this.decayTimer);
          this.decayTimer = null;
        }
        if (st === 'CLOSED' && !this.closed && this.channel === channel) {
          // Closed by the server (rate limit, expired token): supabase-js does not rejoin.
          m.count(`channel_closed_by_server:${this.kind}`);
          this.channel = null;
          const wait = rejoinDelayMs(this.rejoinLevel, this.player.rng.next());
          this.rejoinLevel++;
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

  /** One backoff level down per `rejoinDecayMs` the topic stays subscribed. */
  private scheduleDecay(): void {
    if (this.decayTimer) clearTimeout(this.decayTimer);
    this.decayTimer = null;
    if (this.rejoinLevel === 0 || this.closed) return;
    this.decayTimer = setTimeout(() => {
      this.decayTimer = null;
      this.rejoinLevel = Math.max(0, this.rejoinLevel - 1);
      this.scheduleDecay();
    }, CLIENT_RULES.rejoinDecayMs);
  }

  /** Who this client is (`{user_id, display_name, device}`); claimed once subscribed. */
  setIdentity(identity: object): void {
    if (!this.presence || this.closed) return;
    this.identity = identity;
    this.claimOwed = true;
    this.flush();
  }

  /** The BUILD activity (the web client's setActivity). */
  setActivity(activity: Activity): void {
    if (!this.presence || this.closed) return;
    if (activity.last_build !== 'error') this.buildErrorSince = null;
    else this.buildErrorSince ??= now();
    this.activity = activity;
    this.flush();
  }

  /** The web client's reportedActivity: a failing build only once it failed for 10 s. */
  private reported(t: number): Activity {
    const a = this.activity;
    if (a.last_build !== 'error' || this.sentActivity?.last_build === 'error') return a;
    const since = this.buildErrorSince ?? t;
    return t - since >= CLIENT_RULES.buildErrorMs ? a : { ...a, last_build: 'ok' };
  }

  /** The battle's phase changed: activity held back outside BUILDING may go out now. */
  phaseChanged(): void {
    this.flush();
  }

  /** The web client's flushPresence. */
  private flush(): void {
    if (!this.identity || this.closed || !this.channel || this.status !== 'SUBSCRIBED') return;
    const t = now();
    const activity = this.reported(t);
    const payload = { ...this.identity, activity };
    const json = JSON.stringify(payload);
    const claim = this.claimOwed;
    const building = this.phaseOf() === 'building';
    const wanted =
      claim ||
      (json !== this.lastTracked && building && activityMatters(this.sentActivity, activity));
    const wasPending = this.pendingTimer !== null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (!wanted) {
      const since = this.buildErrorSince;
      if (building && since !== null && activity.last_build === 'ok') {
        this.pendingTimer = setTimeout(
          () => {
            this.pendingTimer = null;
            this.flush();
          },
          since + CLIENT_RULES.buildErrorMs - t,
        );
      }
      return;
    }
    const r = CLIENT_RULES;
    this.trackTimes = this.trackTimes.filter((x) => x > t - r.presenceWindowMs);
    let wait = this.lastTrackAt + (claim ? r.presenceThrottleMs : r.presenceActivityMs) - t;
    const oldest = this.trackTimes[0];
    if (this.trackTimes.length >= r.presenceMaxPerWindow && oldest !== undefined) {
      wait = Math.max(wait, oldest + r.presenceWindowMs - t);
    }
    if (wait > 0) {
      if (!wasPending) this.player.metrics.raw.presence.deferred++;
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.flush();
      }, wait);
      return;
    }
    this.claimOwed = false;
    this.lastTrackAt = t;
    this.trackTimes.push(t);
    this.lastTracked = json;
    this.sentActivity = activity;
    this.player.metrics.raw.presence.sent++;
    this.player.metrics.count(`presence_sent:${this.phaseOf()}`);
    this.player.metrics.count(claim ? 'presence_sent_claim' : 'presence_sent_activity');
    const channel = this.channel;
    void channel.track(payload).then(
      (res) => {
        if (res === 'ok') return;
        this.player.metrics.raw.presence.failed++;
        if (this.lastTracked === json) {
          this.lastTracked = null;
          this.claimOwed = true;
        }
      },
      () => {
        this.player.metrics.raw.presence.failed++;
      },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.decayTimer) clearTimeout(this.decayTimer);
    const ch = this.channel;
    this.channel = null;
    if (ch) await this.player.client.removeChannel(ch).catch(() => undefined);
  }
}
