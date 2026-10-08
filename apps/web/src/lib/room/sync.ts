/**
 * The room sync engine (docs/04 §4.5–§4.8, §4.10): keeps a room's snapshot and its current
 * battle's snapshot up to date from the private Realtime topics, with the client rules:
 *
 * - **Subscribe:** `realtime.setAuth()` first, then the private topics `room:{id}` and
 *   `battle:{current_battle_id}`.
 * - **Apply events:** an event with `version <= current` is ignored (stale or duplicate),
 *   `current + 1` is applied (reducer.ts), a gap refetches the snapshot. Events that arrive
 *   while a snapshot is being fetched are buffered and replayed on top of it. Every `phase`
 *   event (except a REVEAL slot step, which only moves the spotlight), every `sync` event
 *   and every (re)subscribe refetches; `vote_progress` never does.
 * - **Never stuck:** a gap refetches at once; while the same hole stays open (the fresh
 *   snapshot is still behind the buffered events) or a wanted snapshot cannot be fetched
 *   (offline), the topic asks again with backoff (1 s, 2 s, 4 s… at most 30 s). Events are
 *   never dropped while waiting: the newest are buffered.
 * - **Battle switch:** when `current_battle_id` changes (a rematch), the old battle topic is
 *   closed and the new one subscribed.
 * - **Battle topic join:** a random 0–500 ms after the battle is known (T-029), so a room's
 *   players do not all hit Realtime's authorization pool in the same instant at the start
 *   of a battle. The snapshot is fetched at once and again on SUBSCRIBED, so events
 *   published before the join are not missed.
 * - **Heartbeat:** `heartbeat(room_id)` every ~10 s (presence for the server and host
 *   migration). A newer `room_version` or another host in its answer refetches the room;
 *   `kicked`, `room_closed`, `not_a_member` and `room_not_found` end the session.
 * - **Lost broadcasts:** Realtime delivers at most once, and can stop delivering the
 *   database's broadcasts for a while with every channel still SUBSCRIBED (the local stack
 *   does it every 10 minutes: Realtime drops the tenant's database connection to
 *   "rebalance" and only reconnects on the next channel join; whatever was sent meanwhile
 *   is gone). A gap is only noticed when a later event arrives, so the LAST event before
 *   such a silence (a phase change, the next REVEAL slot) would never be noticed. So the
 *   heartbeat's answer also carries the room's current battle and its version (T-029;
 *   before, a separate `battles.version` read per beat), and while the battle is not over
 *   a server ahead of the snapshot refetches it: nothing stays stale for more than one
 *   beat.
 * - **Recovery:** on `visibilitychange` → visible and on `online`, the clock is measured
 *   again and both snapshots are refetched. While the room topic is not subscribed
 *   (Realtime down or reconnecting) or the browser is offline, the connection reads
 *   `degraded` ("Reconnecting…") and both snapshots are polled every few seconds. (An
 *   offline browser can keep its WebSocket "open" without traffic until the Realtime
 *   heartbeat times out, so the `offline` event is the first sign, not the channel status.)
 * - **Clock:** `server_now()` sampled 3× (lowest RTT) at start and on recovery; every 60 s
 *   one sample, ignored when its round trip is much slower (T-029, clock-sync.ts).
 * - **Presence:** `{user_id, display_name, device, activity}` tracked on the room topic.
 *   It is claimed after every (re)subscribe (the lobby's online dots and the sidebar need
 *   it). Activity updates (T-029) go out only during BUILDING, only for a change that
 *   matters (`activityMatters`: active on/off, the build failing for 10 s or fixed, ±20
 *   lines), at most once per 15 s, the latest activity winning. Any two tracks are 2 s apart and at
 *   most 4 fall in 30 s (Realtime closes the channel of a client that sends more than 5
 *   presence messages in 30 s); none while offline (they would arrive as one burst).
 * - **Closed channels:** a topic the server closes (CLOSED, e.g. a rate limit or an
 *   expired token; supabase-js does not rejoin those) is subscribed again after 5 s, 10 s,
 *   20 s, then 30 s, each plus up to half again as random jitter (T-029). A successful
 *   subscribe does not reset that: the backoff steps down one level per 60 s the topic
 *   stays subscribed, so a Realtime rate limit cannot turn into a rejoin storm. Errors and
 *   timeouts are left to supabase-js, which rejoins.
 * - **Teardown:** `stop()` closes both topics and every timer and listener.
 * - **Health (T-030):** `stats` counts what the engine had to do to stay in sync: missed
 *   events (heartbeats ahead of the snapshot), refetches, gaps, time spent degraded,
 *   rejoins, server-closed channels and channel errors. Per battle, `onBattleHealth` gets
 *   those counters over the battle once: when it ends (DESTROYED, ABANDONED), or when this
 *   client stops following it (a rematch, leaving, the page going away). Only for a battle
 *   the client saw running; it becomes the `sync_health` analytics event (RoomController).
 *
 * Plain TypeScript with injected API, Realtime, clock and environment, unit tested with
 * fakes (sync.test.ts). React reads it through the RoomController.
 */
import {
  ACTIVITY_BUILD_ERROR_MS,
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_ACTIVITY_INTERVAL_MS,
  PRESENCE_MAX_PER_WINDOW,
  PRESENCE_THROTTLE_MS,
  PRESENCE_WINDOW_MS,
  activityMatters,
  battleTopic,
  isTerminalPhase,
  roomTopic,
} from '@br/game';
import { ServerClock } from '../solo/clock-sync';
import { realClock, type SoloClock, type TimerHandle } from '../solo/controller';
import { toGameError, type GameError } from '../solo/errors';
import type { BattleSnapshot } from '../solo/types';
import {
  applyBattleEvent,
  applyRoomEvent,
  checkVersion,
  parseBattleEvent,
  parseRoomEvent,
  type Reduced,
} from './reducer';
import type {
  Activity,
  BattleEvent,
  HeartbeatResult,
  PresenceMap,
  PresencePayload,
  RoomEvent,
  RoomSnapshot,
} from './types';

// ─── Ports ────────────────────────────────────────────────────────────────────────────

export interface RoomSyncApi {
  getRoomSnapshot(roomId: string): Promise<RoomSnapshot>;
  getBattleSnapshot(battleId: string): Promise<BattleSnapshot>;
  /** Also answers the room's current battle and its version (the lost-broadcast check). */
  heartbeat(roomId: string): Promise<HeartbeatResult>;
  /** `server_now()` as epoch ms. */
  serverNow(): Promise<number>;
}

export type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface TopicHandlers {
  broadcast(event: string, payload: unknown): void;
  /** The whole presence state (key → metas) after each presence sync. */
  presence(state: Record<string, unknown[]>): void;
  status(status: ChannelStatus, error?: string): void;
}

export interface TopicSubscription {
  /** Presence track; false when refused (e.g. a member who left). */
  track(payload: object): Promise<boolean>;
  close(): void;
}

/** The part of Supabase Realtime the engine uses (api.ts adapts supabase-js). */
export interface RealtimePort {
  /** Hands the session's access token to Realtime (private channels need it). */
  setAuth(): Promise<void>;
  /** `presenceKey` null: no Presence on this topic. */
  subscribe(
    topic: string,
    opts: { presenceKey: string | null },
    handlers: TopicHandlers,
  ): TopicSubscription;
}

/** The page coming back (the tab became visible, the network came back) or going offline. */
export interface SyncEnvironment {
  onResume(cb: (reason: 'visible' | 'online') => void): () => void;
  /** The browser lost the network (`offline`). */
  onOffline?(cb: () => void): () => void;
  /** The page is being unloaded (`pagehide`). */
  onPageHide?(cb: () => void): () => void;
}

export const browserEnvironment: SyncEnvironment = {
  onResume(cb) {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') cb('visible');
    };
    const onOnline = () => {
      cb('online');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  },
  onOffline(cb) {
    window.addEventListener('offline', cb);
    return () => {
      window.removeEventListener('offline', cb);
    };
  },
  onPageHide(cb) {
    window.addEventListener('pagehide', cb);
    return () => {
      window.removeEventListener('pagehide', cb);
    };
  },
};

export interface SyncTimings {
  heartbeatMs: number;
  clockResyncMs: number;
  /** The minimum gap between any two presence tracks. */
  presenceThrottleMs: number;
  /** BUILD activity updates at most this often (and only during BUILDING). */
  presenceActivityMs: number;
  /** A failing build is reported once it has failed this long (or was already reported). */
  buildErrorMs: number;
  /** At most `presenceMaxPerWindow` tracks per `presenceWindowMs` (Realtime's limit is 5/30 s). */
  presenceMaxPerWindow: number;
  presenceWindowMs: number;
  /** Snapshot polling while the room topic is not subscribed. */
  fallbackPollMs: number;
  /** First retry of a snapshot that is still behind (or failed); doubles each time. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** First re-subscribe after the server closed a topic; doubles up to `rejoinMaxMs`. */
  rejoinBaseMs: number;
  rejoinMaxMs: number;
  /** Each rejoin delay plus up to this share of it at random. */
  rejoinJitter: number;
  /** The rejoin backoff steps down one level per this long the topic stays subscribed. */
  rejoinDecayMs: number;
  /** The battle topic is joined this long at most (at random) after the battle is known. */
  battleJoinStaggerMs: number;
}

export const DEFAULT_SYNC_TIMINGS: SyncTimings = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  clockResyncMs: 60_000,
  presenceThrottleMs: PRESENCE_THROTTLE_MS,
  presenceActivityMs: PRESENCE_ACTIVITY_INTERVAL_MS,
  buildErrorMs: ACTIVITY_BUILD_ERROR_MS,
  presenceMaxPerWindow: PRESENCE_MAX_PER_WINDOW,
  presenceWindowMs: PRESENCE_WINDOW_MS,
  fallbackPollMs: 5_000,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  rejoinBaseMs: 5_000,
  rejoinMaxMs: 30_000,
  rejoinJitter: 0.5,
  rejoinDecayMs: 60_000,
  battleJoinStaggerMs: 500,
};

export interface RoomSyncDeps {
  api: RoomSyncApi;
  realtime: RealtimePort;
  /** The signed-in user (the presence key). */
  userId: string;
  clock?: SoloClock | undefined;
  env?: SyncEnvironment | undefined;
  timings?: Partial<SyncTimings> | undefined;
  /** Once per battle this client saw running (see "Health" above). */
  onBattleHealth?: ((report: BattleSyncHealth) => void) | undefined;
}

// ─── State ────────────────────────────────────────────────────────────────────────────

/** Why the session ended: the room page shows a message instead of the room. */
export type EndReason = 'kicked' | 'left' | 'closed' | 'gone';

export type Connection = 'idle' | 'connecting' | 'live' | 'degraded' | 'stopped';

export interface RoomSyncState {
  roomId: string | null;
  room: RoomSnapshot | null;
  /** The snapshot of `room.current_battle_id` (the running or the last battle). */
  battle: BattleSnapshot | null;
  presence: PresenceMap;
  clockOffsetMs: number;
  connection: Connection;
  ended: EndReason | null;
}

export const INITIAL_SYNC_STATE: RoomSyncState = {
  roomId: null,
  room: null,
  battle: null,
  presence: {},
  clockOffsetMs: 0,
  connection: 'idle',
  ended: null,
};

/** An event that was applied, for toasts and feeds (host changes, ships, kicks). */
export type SyncNotice =
  | { topic: 'room'; event: RoomEvent; room: RoomSnapshot; previous: RoomSnapshot }
  | { topic: 'battle'; event: BattleEvent; battle: BattleSnapshot; previous: BattleSnapshot };

/** Counters for tests, debugging and the per-battle health report. */
export interface SyncStats {
  applied: number;
  stale: number;
  gaps: number;
  fetches: number;
  /** Heartbeats that found the battle ahead of the snapshot (broadcasts never arrived). */
  missed: number;
  /** Time the connection read `degraded`, for periods that ended (see `currentStats()`). */
  degradedMs: number;
  /** Re-subscribes after the server closed a topic. */
  rejoins: number;
  /** Topics the server closed (CLOSED). */
  serverClosed: number;
  /** CHANNEL_ERROR and TIMED_OUT statuses (supabase-js rejoins those itself). */
  channelErrors: number;
}

/** Why a battle's health report was made. */
export type BattleHealthEnd = 'destroyed' | 'abandoned' | 'left' | 'switched' | 'closed';

/** The engine's counters over one battle (`onBattleHealth`). */
export interface BattleSyncHealth {
  battleId: string;
  roomId: string;
  ended: BattleHealthEnd;
  durationMs: number;
  /** The counters' increase while this client followed the battle. */
  stats: SyncStats;
}

const NO_STATS: SyncStats = {
  applied: 0,
  stale: 0,
  gaps: 0,
  fetches: 0,
  missed: 0,
  degradedMs: 0,
  rejoins: 0,
  serverClosed: 0,
  channelErrors: 0,
};

// ─── One versioned topic ──────────────────────────────────────────────────────────────

interface VersionedOptions<S, E extends { version: number }> {
  version(s: S): number;
  reduce(s: S, e: E): Reduced<S>;
  fetch(): Promise<S>;
  onChange(s: S): void;
  onApplied(e: E, next: S, previous: S): void;
  onFetchError(e: GameError): void;
  stats: SyncStats;
  /** Timers for the retries (the engine's clock). */
  clock: Pick<SoloClock, 'setTimeout' | 'clearTimeout'>;
  retryBaseMs: number;
  retryMaxMs: number;
}

/** Events kept while a hole is open; older ones are covered by the next snapshot. */
export const MAX_BUFFERED_EVENTS = 200;

/**
 * A snapshot plus the version rules: stale events are dropped, the next one is applied, a
 * gap refetches. Fetches coalesce; events received during a fetch are replayed after it.
 * A hole that a fetch did not close, or a fetch that failed, is retried with backoff until
 * a snapshot catches up: the topic never drops events or gives up.
 */
export class VersionedTopic<S, E extends { version: number }> {
  snapshot: S | null = null;
  private fetching: Promise<void> | null = null;
  private again = false;
  private buffer: E[] = [];
  /** Retries in a row for the current problem (an open hole or failing fetches). */
  private retries = 0;
  private retryTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(private readonly o: VersionedOptions<S, E>) {}

  receive(ev: E): void {
    if (this.disposed) return;
    if (this.fetching || this.snapshot === null) {
      this.keep(ev);
      if (!this.fetching) void this.refetch();
      return;
    }
    this.handle(ev);
  }

  private keep(ev: E): void {
    this.buffer.push(ev);
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.sort((a, b) => a.version - b.version).shift();
    }
  }

  /**
   * Fetches again: at once for a new problem, then after 1 s, 2 s, 4 s… (at most
   * `retryMaxMs`) while it persists. A fetch already running replays the buffer when done.
   */
  private retry(): void {
    if (this.disposed || this.retryTimer !== null || this.fetching) return;
    const delay =
      this.retries === 0
        ? 0
        : Math.min(this.o.retryBaseMs * 2 ** (this.retries - 1), this.o.retryMaxMs);
    this.retries++;
    if (delay === 0) {
      void this.refetch();
      return;
    }
    this.retryTimer = this.o.clock.setTimeout(() => {
      this.retryTimer = null;
      void this.refetch();
    }, delay);
  }

  /** The snapshot caught up: the next problem starts with an immediate fetch again. */
  private settled(): void {
    this.retries = 0;
    if (this.retryTimer !== null) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private handle(ev: E): void {
    const snap = this.snapshot;
    if (snap === null) return;
    const check = checkVersion(this.o.version(snap), ev.version);
    if (check === 'stale') {
      this.o.stats.stale++;
      return;
    }
    if (check === 'gap') {
      this.o.stats.gaps++;
      // Keep it, fetch the missing versions, then replay it on top of the fresh snapshot.
      this.keep(ev);
      this.retry();
      return;
    }
    const { next, refetch } = this.o.reduce(snap, ev);
    this.snapshot = next;
    this.o.stats.applied++;
    this.o.onChange(next);
    this.o.onApplied(ev, next, snap);
    if (refetch) void this.refetch();
  }

  refetch(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.fetching) {
      this.again = true;
      return this.fetching;
    }
    this.fetching = (async () => {
      let failed = false;
      try {
        do {
          this.again = false;
          this.o.stats.fetches++;
          let fresh: S;
          try {
            fresh = await this.o.fetch();
          } catch (e) {
            if (!this.isDisposed()) this.o.onFetchError(toGameError(e));
            failed = true;
            break;
          }
          if (this.isDisposed()) return;
          // Events applied meanwhile may already be ahead of this snapshot.
          if (this.snapshot === null || this.o.version(fresh) >= this.o.version(this.snapshot)) {
            this.snapshot = fresh;
            this.o.onChange(fresh);
          }
        } while (this.wantsAgain());
      } finally {
        this.fetching = null;
      }
      if (this.isDisposed()) return;
      if (failed) {
        // The buffer is kept; ask again later (never at once after a failure).
        this.retries = Math.max(this.retries, 1);
        this.retry();
        return;
      }
      const buffered = this.buffer.splice(0).sort((a, b) => a.version - b.version);
      for (const ev of buffered) this.handle(ev);
      // Every buffered event was applied or stale: the hole is closed. Otherwise handle()
      // kept the rest and scheduled the next try.
      if (this.buffer.length === 0) this.settled();
    })();
    return this.fetching;
  }

  dispose(): void {
    this.disposed = true;
    this.buffer = [];
    if (this.retryTimer !== null) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // Methods, so TypeScript does not narrow the flags across awaits.
  private isDisposed(): boolean {
    return this.disposed;
  }
  private wantsAgain(): boolean {
    return this.again;
  }
}

// ─── The engine ───────────────────────────────────────────────────────────────────────

type TopicKind = 'room' | 'battle';

type TimerName =
  | 'heartbeat'
  | 'clock'
  | 'poll'
  | 'presence'
  | 'joinBattle'
  | 'rejoinRoom'
  | 'rejoinBattle'
  | 'decayRoom'
  | 'decayBattle';

function deviceKind(): 'desktop' | 'mobile' {
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

export const IDLE_ACTIVITY: Activity = { lines: 0, last_build: 'ok', typing: false };

/** The presence state from Realtime (key → metas) as one payload per user. */
export function normalizePresence(state: Record<string, unknown[]>): PresenceMap {
  // Client-claimed data: every field is checked.
  interface RawMeta {
    user_id?: unknown;
    display_name?: unknown;
    device?: unknown;
    activity?: { lines?: unknown; last_build?: unknown; typing?: unknown } | null;
  }
  const out: PresenceMap = {};
  for (const metas of Object.values(state)) {
    const valid = metas.filter(
      (m): m is RawMeta & { user_id: string; display_name: string } =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as RawMeta).user_id === 'string' &&
        typeof (m as RawMeta).display_name === 'string',
    );
    const first = valid[0];
    if (!first) continue;
    // Several tabs of one user: typing if any tab types, the largest line count.
    const activity = valid.reduce<Activity>(
      (acc, m) => {
        const a = m.activity;
        if (typeof a !== 'object' || a === null) return acc;
        const lines = typeof a.lines === 'number' && Number.isFinite(a.lines) ? a.lines : 0;
        return {
          lines: Math.max(acc.lines, lines),
          last_build: a.last_build === 'error' ? 'error' : acc.last_build,
          typing: acc.typing || a.typing === true,
        };
      },
      { ...IDLE_ACTIVITY },
    );
    const userId = first.user_id;
    out[userId] = {
      user_id: userId,
      display_name: first.display_name,
      device: first.device === 'mobile' ? 'mobile' : 'desktop',
      activity,
    };
  }
  return out;
}

export class RoomSync {
  private state: RoomSyncState = INITIAL_SYNC_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(n: SyncNotice) => void>();
  private readonly api: RoomSyncApi;
  private readonly realtime: RealtimePort;
  private readonly clock: SoloClock;
  private readonly env: SyncEnvironment | null;
  private readonly timings: SyncTimings;
  private readonly userId: string;
  private readonly timers = new Map<TimerName, TimerHandle>();
  readonly stats: SyncStats = { ...NO_STATS };
  /** Since when the connection reads `degraded` (null while it does not). */
  private degradedSince: number | null = null;
  /** The battle being followed for its health report. */
  private watch: {
    battleId: string;
    roomId: string;
    startedAt: number;
    base: SyncStats;
    sawLive: boolean;
    reported: boolean;
  } | null = null;
  private offPageHide: (() => void) | null = null;
  private readonly onBattleHealth: ((report: BattleSyncHealth) => void) | null;

  private roomTopic: VersionedTopic<RoomSnapshot, RoomEvent> | null = null;
  private roomSub: TopicSubscription | null = null;
  private roomSubscribed = false;
  private battleId: string | null = null;
  private battleTopic: VersionedTopic<BattleSnapshot, BattleEvent> | null = null;
  private battleSub: TopicSubscription | null = null;
  private offResume: (() => void) | null = null;
  private offOffline: (() => void) | null = null;
  /** The browser said `offline` and has not said `online` since. */
  private offline = false;
  private stopped = false;

  private presence: Omit<PresencePayload, 'activity'> | null = null;
  private activity: Activity = IDLE_ACTIVITY;
  /** The activity in the last track (what the others see), or null before the first. */
  private sentActivity: Activity | null = null;
  /** Since when the build has been failing (the activity's own `last_build`), or null. */
  private buildErrorSince: number | null = null;
  /** A track is owed regardless of the activity: a (re)subscribe, a new name, a refusal. */
  private claimOwed = true;
  private lastTrackAt = Number.NEGATIVE_INFINITY;
  private lastTracked: string | null = null;
  /** When the recent tracks were sent (the 30 s budget). */
  private trackTimes: number[] = [];
  /**
   * The rejoin backoff level per topic: raised by every server close, lowered by one per
   * `rejoinDecayMs` the topic stays subscribed (never reset by a mere SUBSCRIBED).
   */
  private rejoins: Record<TopicKind, number> = { room: 0, battle: 0 };
  private readonly serverClock: ServerClock;

  constructor(deps: RoomSyncDeps) {
    this.api = deps.api;
    this.realtime = deps.realtime;
    this.clock = deps.clock ?? realClock;
    this.env = deps.env ?? null;
    this.timings = { ...DEFAULT_SYNC_TIMINGS, ...deps.timings };
    this.userId = deps.userId;
    this.onBattleHealth = deps.onBattleHealth ?? null;
    this.serverClock = new ServerClock(
      () => this.api.serverNow(),
      () => this.clock.now(),
    );
  }

  // --- Store contract -----------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RoomSyncState => this.state;

  /** Called for every applied event (not for refetched snapshots). */
  onNotice(listener: (n: SyncNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  // --- Lifecycle ----------------------------------------------------------------------

  /** Connects to a room the user has joined. */
  async start(roomId: string): Promise<void> {
    if (this.state.roomId !== null || this.stopped) return;
    this.patch({ roomId, connection: 'connecting' });
    this.offResume =
      this.env?.onResume((reason) => {
        if (reason === 'online') this.setOffline(false);
        this.resync();
      }) ?? null;
    this.offOffline =
      this.env?.onOffline?.(() => {
        this.setOffline(true);
      }) ?? null;
    this.offPageHide =
      this.env?.onPageHide?.(() => {
        this.reportBattleHealth('closed');
      }) ?? null;

    this.roomTopic = new VersionedTopic<RoomSnapshot, RoomEvent>({
      version: (s) => s.room.version,
      reduce: applyRoomEvent,
      fetch: () => this.api.getRoomSnapshot(roomId),
      onChange: (s) => {
        this.onRoomChange(s);
      },
      onApplied: (event, room, previous) => {
        this.notify({ topic: 'room', event, room, previous });
      },
      onFetchError: (e) => {
        // Kicked members and purged rooms both read as room_not_found: ask the heartbeat.
        if (e.code === 'room_not_found') void this.beat();
      },
      stats: this.stats,
      clock: this.clock,
      retryBaseMs: this.timings.retryBaseMs,
      retryMaxMs: this.timings.retryMaxMs,
    });

    // Private channels need the session token before the first join.
    await this.realtime.setAuth().catch(() => undefined);
    if (this.isStopped()) return;
    this.subscribeRoom(roomId);
    // Show the room at once; the SUBSCRIBED callback refetches again (nothing is missed).
    void this.roomTopic.refetch();
    void this.syncClock('measure');
    this.scheduleHeartbeat(this.timings.heartbeatMs);
    this.scheduleClock();
    this.schedulePoll();
  }

  /** Leaves every topic and stops every timer. Idempotent. */
  stop(reason: EndReason | null = null): void {
    if (this.stopped) return;
    this.reportBattleHealth(reason === null ? 'closed' : 'left');
    this.stopped = true;
    for (const h of this.timers.values()) this.clock.clearTimeout(h);
    this.timers.clear();
    this.offResume?.();
    this.offResume = null;
    this.offOffline?.();
    this.offOffline = null;
    this.offPageHide?.();
    this.offPageHide = null;
    this.roomSub?.close();
    this.roomSub = null;
    this.closeBattle();
    this.roomTopic?.dispose();
    this.roomTopic = null;
    this.patch({ connection: 'stopped', ended: reason ?? this.state.ended });
    this.listeners.clear();
    this.noticeListeners.clear();
  }

  // --- Intents ------------------------------------------------------------------------

  refetchRoom(): Promise<void> {
    return this.roomTopic?.refetch() ?? Promise.resolve();
  }

  refetchBattle(): Promise<void> {
    return this.battleTopic?.refetch() ?? Promise.resolve();
  }

  /** The tab is visible again or the network came back: catch up on everything. */
  resync(): void {
    if (this.stopped) return;
    void this.syncClock('measure');
    void this.refetchRoom();
    void this.refetchBattle();
    void this.beat();
  }

  /** Who this client is in the room's Presence (tracked once the topic is subscribed). */
  setPresence(displayName: string): void {
    this.presence = { user_id: this.userId, display_name: displayName, device: deviceKind() };
    this.claimOwed = true;
    this.flushPresence();
  }

  /**
   * The player's BUILD activity (lines, last build, active); sent only during BUILDING, when
   * it matters, at most every 15 s (see flushPresence).
   */
  setActivity(activity: Activity): void {
    if (activity.last_build !== 'error') this.buildErrorSince = null;
    else this.buildErrorSince ??= this.clock.now();
    this.activity = activity;
    this.flushPresence();
  }

  // --- Room ---------------------------------------------------------------------------

  private subscribeRoom(roomId: string): void {
    this.roomSub?.close();
    const sub: TopicSubscription = this.realtime.subscribe(
      roomTopic(roomId),
      { presenceKey: this.userId },
      {
        broadcast: (_event, payload) => {
          const ev = parseRoomEvent(payload);
          if (ev) this.roomTopic?.receive(ev);
        },
        presence: (state) => {
          this.patch({ presence: normalizePresence(state) });
        },
        status: (status) => {
          if (this.roomSub === sub) this.onRoomStatus(status, roomId);
        },
      },
    );
    this.roomSub = sub;
  }

  /**
   * Subscribes again after the server closed a topic: 5 s, 10 s, 20 s, then 30 s, each plus
   * up to `rejoinJitter` of it at random (a room's clients closed by the same rate limit do
   * not come back in step).
   */
  private scheduleRejoin(topic: TopicKind, rejoin: () => void): void {
    const name = topic === 'room' ? 'rejoinRoom' : 'rejoinBattle';
    this.clearTimer(topic === 'room' ? 'decayRoom' : 'decayBattle');
    if (this.stopped || this.timers.has(name)) return;
    const n = this.rejoins[topic]++;
    const { rejoinBaseMs, rejoinMaxMs, rejoinJitter } = this.timings;
    const base = Math.min(rejoinBaseMs * 2 ** n, rejoinMaxMs);
    this.setTimer(name, Math.round(base * (1 + rejoinJitter * this.clock.random())), () => {
      this.stats.rejoins++;
      rejoin();
    });
  }

  /**
   * The topic is subscribed: the rejoin backoff steps down one level per `rejoinDecayMs` it
   * stays up (a close in between stops the countdown). A SUBSCRIBED alone does not reset it:
   * a rate limit that closes the channel again a few seconds later must not bring the
   * clients back at the first step.
   */
  private scheduleDecay(topic: TopicKind): void {
    const name = topic === 'room' ? 'decayRoom' : 'decayBattle';
    this.clearTimer(name);
    if (this.rejoins[topic] === 0) return;
    this.setTimer(name, this.timings.rejoinDecayMs, () => {
      this.rejoins[topic] = Math.max(0, this.rejoins[topic] - 1);
      this.scheduleDecay(topic);
    });
  }

  private onRoomStatus(status: ChannelStatus, roomId: string): void {
    if (this.stopped) return;
    if (status === 'SUBSCRIBED') {
      this.scheduleDecay('room');
      this.roomSubscribed = true;
      this.patch({ connection: this.offline ? 'degraded' : 'live' });
      // (Re)subscribed: anything may have been missed. Presence must be tracked again.
      void this.roomTopic?.refetch();
      void this.refetchBattle();
      this.claimOwed = true;
      this.flushPresence();
    } else {
      this.countStatus(status);
      this.clearTimer('decayRoom');
      this.roomSubscribed = false;
      // supabase-js rejoins after an error or a timeout, not after the server closed the
      // channel: then this engine subscribes again. Poll meanwhile.
      this.patch({ connection: 'degraded' });
      if (status === 'CLOSED') {
        this.scheduleRejoin('room', () => {
          this.subscribeRoom(roomId);
        });
      }
    }
    this.schedulePoll();
  }

  /** `offline`: say so at once and poll; `online`: back to the channel's own status. */
  private setOffline(offline: boolean): void {
    if (this.stopped || offline === this.offline) return;
    this.offline = offline;
    this.patch({ connection: !offline && this.roomSubscribed ? 'live' : 'degraded' });
    this.schedulePoll();
    // Presence held back while offline goes out now (one message, not a burst).
    if (!offline) this.flushPresence();
  }

  private onRoomChange(room: RoomSnapshot): void {
    this.patch({ room });
    if (room.me.state === 'kicked') {
      this.end('kicked');
      return;
    }
    if (room.room.status === 'closed') {
      this.end('closed');
      return;
    }
    if (room.me.state === 'left') {
      // Left from another tab (or the server says so): this page is no longer in the room.
      this.end('left');
      return;
    }
    const current = room.room.current_battle_id;
    if (current !== this.battleId) this.openBattle(current);
  }

  // --- Battle -------------------------------------------------------------------------

  private openBattle(battleId: string | null): void {
    this.reportBattleHealth('switched');
    this.closeBattle();
    this.battleId = battleId;
    this.patch({ battle: null });
    if (battleId === null || this.stopped) return;
    this.watch = {
      battleId,
      roomId: this.state.roomId ?? '',
      startedAt: this.clock.now(),
      base: this.currentStats(),
      sawLive: false,
      reported: false,
    };
    const topic = new VersionedTopic<BattleSnapshot, BattleEvent>({
      version: (s) => s.battle.version,
      reduce: applyBattleEvent,
      fetch: () => this.api.getBattleSnapshot(battleId),
      onChange: (s) => {
        if (this.battleTopic !== topic) return;
        this.watchBattle(s);
        this.patch({ battle: s });
        // Activity held back outside BUILDING may go out now that it started.
        this.flushPresence();
      },
      onApplied: (event, battle, previous) => {
        if (this.battleTopic === topic) this.notify({ topic: 'battle', event, battle, previous });
      },
      onFetchError: () => {
        // Retried with backoff (and by the next event, the fallback poll or a resync).
      },
      stats: this.stats,
      clock: this.clock,
      retryBaseMs: this.timings.retryBaseMs,
      retryMaxMs: this.timings.retryMaxMs,
    });
    this.battleTopic = topic;
    // Joined a random 0–500 ms later: at the start of a battle every player of the room learns
    // of it within a few ms, and the joins would hit Realtime's authorization pool at once
    // (docs/07 §7.5.4). The snapshot is fetched now and again on SUBSCRIBED, so events sent
    // before the join are not missed. (The rejoin backoff level carries over: a rate limit
    // does not end with the battle.)
    const stagger = Math.floor(this.clock.random() * (this.timings.battleJoinStaggerMs + 1));
    const join = () => {
      if (this.battleTopic === topic) this.subscribeBattle(battleId, topic);
    };
    if (stagger > 0) this.setTimer('joinBattle', stagger, join);
    else join();
    void topic.refetch();
  }

  private subscribeBattle(
    battleId: string,
    topic: VersionedTopic<BattleSnapshot, BattleEvent>,
  ): void {
    this.battleSub?.close();
    // Presence lives on the room topic (lobby and BUILD sidebar alike): none here.
    const sub: TopicSubscription = this.realtime.subscribe(
      battleTopic(battleId),
      { presenceKey: null },
      {
        broadcast: (_event, payload) => {
          const ev = parseBattleEvent(payload);
          if (ev) topic.receive(ev);
        },
        presence: () => undefined,
        status: (status) => {
          if (this.battleSub !== sub || this.stopped) return;
          this.countStatus(status);
          if (status === 'SUBSCRIBED') {
            this.scheduleDecay('battle');
            void topic.refetch();
          } else if (status === 'CLOSED') {
            this.scheduleRejoin('battle', () => {
              if (this.battleTopic === topic) this.subscribeBattle(battleId, topic);
            });
          } else {
            this.clearTimer('decayBattle');
          }
        },
      },
    );
    this.battleSub = sub;
  }

  private closeBattle(): void {
    this.clearTimer('joinBattle');
    this.clearTimer('rejoinBattle');
    this.clearTimer('decayBattle');
    this.battleSub?.close();
    this.battleSub = null;
    this.battleTopic?.dispose();
    this.battleTopic = null;
    this.battleId = null;
  }

  // --- Heartbeat, clock, fallback polling ---------------------------------------------

  private scheduleHeartbeat(ms: number): void {
    this.setTimer('heartbeat', ms, () => {
      void this.beat().finally(() => {
        this.scheduleHeartbeat(this.timings.heartbeatMs);
      });
    });
  }

  private async beat(): Promise<void> {
    const roomId = this.state.roomId;
    if (!roomId || this.stopped) return;
    let res: HeartbeatResult;
    try {
      res = await this.api.heartbeat(roomId);
    } catch (e) {
      if (this.isStopped()) return;
      const err = toGameError(e);
      if (err.code === 'kicked') this.end('kicked');
      else if (err.code === 'room_closed') this.end('closed');
      else if (err.code === 'not_a_member') this.end('left');
      else if (err.code === 'room_not_found') this.end('gone');
      // Anything else (network) is retried by the next beat.
      return;
    }
    if (this.isStopped()) return;
    const room = this.state.room;
    if (room && (res.room_version > room.room.version || res.host_id !== room.room.host_id)) {
      void this.refetchRoom();
    }
    this.checkBattleVersion(res);
  }

  /**
   * The battle moved on but no event said so (see "Lost broadcasts" above): refetch. The
   * heartbeat's answer carries the room's current battle and its version; an answer without
   * them (a server older than T-029) checks nothing.
   */
  private checkBattleVersion(res: HeartbeatResult): void {
    const topic = this.battleTopic;
    const snap = topic?.snapshot;
    if (!topic || !snap || isTerminalPhase(snap.battle.phase)) return;
    const version = res.battle_version;
    if (typeof version !== 'number' || res.battle_id !== this.battleId) return;
    // Events applied while the beat was in flight count: only a server still ahead is a miss.
    if (version > snap.battle.version) {
      this.stats.missed++;
      void topic.refetch();
    }
  }

  private scheduleClock(): void {
    this.setTimer('clock', this.timings.clockResyncMs, () => {
      void this.syncClock('resync').finally(() => {
        this.scheduleClock();
      });
    });
  }

  /**
   * `measure`: 3 samples, the lowest RTT wins (start, recovery); `resync`: 1 sample, used
   * only when its RTT is about as good as the current estimate's (clock-sync.ts).
   */
  private async syncClock(kind: 'measure' | 'resync'): Promise<void> {
    const offset =
      kind === 'measure' ? await this.serverClock.measure() : await this.serverClock.resync();
    if (offset !== null && !this.stopped) this.patch({ clockOffsetMs: offset });
  }

  /** While the room topic is down (or the browser offline), poll both snapshots. */
  private schedulePoll(): void {
    this.clearTimer('poll');
    if (this.stopped || (this.roomSubscribed && !this.offline)) return;
    this.setTimer('poll', this.timings.fallbackPollMs, () => {
      void this.refetchRoom();
      void this.refetchBattle();
      this.schedulePoll();
    });
  }

  // --- Presence -----------------------------------------------------------------------

  /** The current battle is in BUILDING: the only phase whose activity others watch. */
  private isBuilding(): boolean {
    const battle = this.state.battle;
    return (
      battle !== null &&
      battle.battle.phase === 'building' &&
      battle.battle.id === this.state.room?.room.current_battle_id
    );
  }

  /**
   * The activity as the others should see it: a failing build only once it has failed for
   * `buildErrorMs` (a half-typed line breaks the 150 ms rebuild for a moment; that is not
   * news), or when they were already told it fails.
   */
  private reportedActivity(now: number): Activity {
    const a = this.activity;
    if (a.last_build !== 'error' || this.sentActivity?.last_build === 'error') return a;
    const since = this.buildErrorSince ?? now;
    return now - since >= this.timings.buildErrorMs ? a : { ...a, last_build: 'ok' };
  }

  /**
   * Tracks this client's presence when something is owed (T-029):
   * - a **claim** (after a (re)subscribe or a new name) always goes out, as soon as the 2 s
   *   gap and the 4-per-30-s budget allow;
   * - an **activity** change goes out only during BUILDING, only when it matters
   *   (`activityMatters` against what the others last received), and at most once per
   *   `presenceActivityMs` (15 s) after the previous track. A held-back change is sent when
   *   the gap is over, as the latest activity; one that stops mattering meanwhile is not.
   *   A failing build counts once it has failed for 10 s (`reportedActivity`).
   * Nothing is sent while offline (it would arrive as a burst).
   */
  private flushPresence(): void {
    if (this.stopped || !this.presence || !this.roomSub || !this.roomSubscribed) return;
    if (this.offline) return; // sent when the network is back
    const now = this.clock.now();
    const activity = this.reportedActivity(now);
    const payload: PresencePayload = { ...this.presence, activity };
    const json = JSON.stringify(payload);
    const claim = this.claimOwed;
    const building = this.isBuilding();
    const wanted =
      claim ||
      (json !== this.lastTracked && building && activityMatters(this.sentActivity, activity));
    if (!wanted) {
      const since = this.buildErrorSince;
      if (building && since !== null && activity.last_build === 'ok') {
        // Failing, not long enough to tell: look again when it is.
        this.setTimer('presence', since + this.timings.buildErrorMs - now, () => {
          this.flushPresence();
        });
      } else {
        this.clearTimer('presence');
      }
      return;
    }
    const { presenceThrottleMs, presenceActivityMs, presenceMaxPerWindow, presenceWindowMs } =
      this.timings;
    this.trackTimes = this.trackTimes.filter((t) => t > now - presenceWindowMs);
    let wait = this.lastTrackAt + (claim ? presenceThrottleMs : presenceActivityMs) - now;
    const oldest = this.trackTimes[0];
    if (this.trackTimes.length >= presenceMaxPerWindow && oldest !== undefined) {
      wait = Math.max(wait, oldest + presenceWindowMs - now);
    }
    if (wait > 0) {
      // (Re)armed for the earliest moment it may go: the latest activity is read then.
      this.setTimer('presence', wait, () => {
        this.flushPresence();
      });
      return;
    }
    this.clearTimer('presence');
    this.claimOwed = false;
    this.lastTrackAt = now;
    this.trackTimes.push(now);
    this.lastTracked = json;
    this.sentActivity = activity;
    void this.roomSub.track(payload).then((ok) => {
      if (ok || this.lastTracked !== json || this.isStopped()) return;
      // Refused (e.g. not joined yet): claim it again with the next chance.
      this.lastTracked = null;
      this.claimOwed = true;
    });
  }

  // --- Health (T-030) -----------------------------------------------------------------

  private countStatus(status: ChannelStatus): void {
    if (status === 'CLOSED') this.stats.serverClosed++;
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.stats.channelErrors++;
  }

  /** The counters now, with the degraded period still running included. */
  private currentStats(): SyncStats {
    const open = this.degradedSince === null ? 0 : this.clock.now() - this.degradedSince;
    return { ...this.stats, degradedMs: this.stats.degradedMs + open };
  }

  /** A battle snapshot came in: note that it ran, report when it ended. */
  private watchBattle(snap: BattleSnapshot): void {
    const w = this.watch;
    if (w?.battleId !== snap.battle.id) return;
    if (!isTerminalPhase(snap.battle.phase)) w.sawLive = true;
    else this.reportBattleHealth(snap.battle.phase === 'abandoned' ? 'abandoned' : 'destroyed');
  }

  /** Reports the followed battle's health once, if this client saw it running. */
  private reportBattleHealth(ended: BattleHealthEnd): void {
    const w = this.watch;
    if (!w || w.reported || !w.sawLive || this.stopped) return;
    w.reported = true;
    const now = this.currentStats();
    const stats = { ...NO_STATS };
    for (const k of Object.keys(stats) as (keyof SyncStats)[]) stats[k] = now[k] - w.base[k];
    try {
      this.onBattleHealth?.({
        battleId: w.battleId,
        roomId: w.roomId,
        ended,
        durationMs: this.clock.now() - w.startedAt,
        stats,
      });
    } catch {
      // A reporting problem never breaks the sync.
    }
  }

  // --- Plumbing -----------------------------------------------------------------------

  /** A method, so TypeScript does not narrow the flag across awaits. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private end(reason: EndReason): void {
    this.patch({ ended: reason });
    this.stop(reason);
  }

  private notify(n: SyncNotice): void {
    for (const l of this.noticeListeners) l(n);
  }

  private setTimer(name: TimerName, ms: number, fn: () => void): void {
    this.clearTimer(name);
    if (this.stopped) return;
    const handle = this.clock.setTimeout(
      () => {
        this.timers.delete(name);
        fn();
      },
      Math.max(0, ms),
    );
    this.timers.set(name, handle);
  }

  private clearTimer(name: TimerName): void {
    const h = this.timers.get(name);
    if (h !== undefined) this.clock.clearTimeout(h);
    this.timers.delete(name);
  }

  private patch(p: Partial<RoomSyncState>): void {
    if (p.connection !== undefined && p.connection !== this.state.connection) {
      const now = this.clock.now();
      if (this.degradedSince !== null) this.stats.degradedMs += now - this.degradedSince;
      this.degradedSince = p.connection === 'degraded' ? now : null;
    }
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}
