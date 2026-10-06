/**
 * The room sync engine (docs/04 §4.5–§4.8, §4.10): keeps a room's snapshot and its current
 * battle's snapshot up to date from the private Realtime topics, with the client rules:
 *
 * - **Subscribe:** `realtime.setAuth()` first, then the private topics `room:{id}` and
 *   `battle:{current_battle_id}`.
 * - **Apply events:** an event with `version <= current` is ignored (stale or duplicate),
 *   `current + 1` is applied (reducer.ts), a gap refetches the snapshot. Events that arrive
 *   while a snapshot is being fetched are buffered and replayed on top of it. Every `phase`
 *   event, every `sync` event and every (re)subscribe refetches.
 * - **Battle switch:** when `current_battle_id` changes (a rematch), the old battle topic is
 *   closed and the new one subscribed.
 * - **Heartbeat:** `heartbeat(room_id)` every ~10 s (presence for the server and host
 *   migration). A newer `room_version` or another host in its answer refetches the room;
 *   `kicked`, `room_closed`, `not_a_member` and `room_not_found` end the session.
 * - **Recovery:** on `visibilitychange` → visible and on `online`, the clock is measured
 *   again and both snapshots are refetched. While the room topic is not subscribed
 *   (Realtime down or reconnecting), both snapshots are polled every few seconds.
 * - **Clock:** `server_now()` sampled 3× (lowest RTT) at start, every 60 s and on recovery.
 * - **Presence:** `{user_id, display_name, device, activity}` tracked on the room topic,
 *   at most once per 2 s, again after every (re)subscribe.
 * - **Teardown:** `stop()` closes both topics and every timer and listener.
 *
 * Plain TypeScript with injected API, Realtime, clock and environment, unit tested with
 * fakes (sync.test.ts). React reads it through the RoomController.
 */
import { HEARTBEAT_INTERVAL_MS, PRESENCE_THROTTLE_MS, battleTopic, roomTopic } from '@br/game';
import { measureClockOffset } from '../solo/clock-sync';
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

/** The page coming back: the tab became visible, or the network came back. */
export interface SyncEnvironment {
  onResume(cb: (reason: 'visible' | 'online') => void): () => void;
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
};

export interface SyncTimings {
  heartbeatMs: number;
  clockResyncMs: number;
  presenceThrottleMs: number;
  /** Snapshot polling while the room topic is not subscribed. */
  fallbackPollMs: number;
}

export const DEFAULT_SYNC_TIMINGS: SyncTimings = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  clockResyncMs: 60_000,
  presenceThrottleMs: PRESENCE_THROTTLE_MS,
  fallbackPollMs: 5_000,
};

export interface RoomSyncDeps {
  api: RoomSyncApi;
  realtime: RealtimePort;
  /** The signed-in user (the presence key). */
  userId: string;
  clock?: SoloClock | undefined;
  env?: SyncEnvironment | undefined;
  timings?: Partial<SyncTimings> | undefined;
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

/** Counters for tests and debugging. */
export interface SyncStats {
  applied: number;
  stale: number;
  gaps: number;
  fetches: number;
}

// ─── One versioned topic ──────────────────────────────────────────────────────────────

interface VersionedOptions<S, E extends { version: number }> {
  version(s: S): number;
  reduce(s: S, e: E): Reduced<S>;
  fetch(): Promise<S>;
  onChange(s: S): void;
  onApplied(e: E, next: S, previous: S): void;
  onFetchError(e: GameError): void;
  stats: SyncStats;
}

/**
 * A snapshot plus the version rules: stale events are dropped, the next one is applied, a
 * gap refetches. Fetches coalesce; events received during a fetch are replayed after it.
 */
export class VersionedTopic<S, E extends { version: number }> {
  snapshot: S | null = null;
  private fetching: Promise<void> | null = null;
  private again = false;
  private buffer: E[] = [];
  private gapRefetches = 0;
  private disposed = false;

  constructor(private readonly o: VersionedOptions<S, E>) {}

  receive(ev: E): void {
    if (this.disposed) return;
    if (this.fetching || this.snapshot === null) {
      this.buffer.push(ev);
      if (!this.fetching) void this.refetch();
      return;
    }
    this.handle(ev);
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
      // Refetch (at most twice in a row for the same hole), then replay this event.
      if (this.gapRefetches < 2) {
        this.gapRefetches++;
        this.buffer.push(ev);
        void this.refetch();
      }
      return;
    }
    this.gapRefetches = 0;
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
      try {
        do {
          this.again = false;
          this.o.stats.fetches++;
          let fresh: S;
          try {
            fresh = await this.o.fetch();
          } catch (e) {
            if (!this.isDisposed()) this.o.onFetchError(toGameError(e));
            return;
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
      // Only reached after a successful fetch (failures return above and keep the buffer).
      if (!this.isDisposed()) {
        const buffered = this.buffer.splice(0).sort((a, b) => a.version - b.version);
        for (const ev of buffered) this.handle(ev);
      }
    })();
    return this.fetching;
  }

  dispose(): void {
    this.disposed = true;
    this.buffer = [];
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

type TimerName = 'heartbeat' | 'clock' | 'poll' | 'presence';

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
  readonly stats: SyncStats = { applied: 0, stale: 0, gaps: 0, fetches: 0 };

  private roomTopic: VersionedTopic<RoomSnapshot, RoomEvent> | null = null;
  private roomSub: TopicSubscription | null = null;
  private roomSubscribed = false;
  private battleId: string | null = null;
  private battleTopic: VersionedTopic<BattleSnapshot, BattleEvent> | null = null;
  private battleSub: TopicSubscription | null = null;
  private offResume: (() => void) | null = null;
  private stopped = false;

  private presence: Omit<PresencePayload, 'activity'> | null = null;
  private activity: Activity = IDLE_ACTIVITY;
  private lastTrackAt = Number.NEGATIVE_INFINITY;
  private lastTracked: string | null = null;

  constructor(deps: RoomSyncDeps) {
    this.api = deps.api;
    this.realtime = deps.realtime;
    this.clock = deps.clock ?? realClock;
    this.env = deps.env ?? null;
    this.timings = { ...DEFAULT_SYNC_TIMINGS, ...deps.timings };
    this.userId = deps.userId;
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
      this.env?.onResume(() => {
        this.resync();
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
    });

    // Private channels need the session token before the first join.
    await this.realtime.setAuth().catch(() => undefined);
    if (this.isStopped()) return;
    this.roomSub = this.realtime.subscribe(
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
          this.onRoomStatus(status);
        },
      },
    );
    // Show the room at once; the SUBSCRIBED callback refetches again (nothing is missed).
    void this.roomTopic.refetch();
    void this.syncClock();
    this.scheduleHeartbeat(this.timings.heartbeatMs);
    this.scheduleClock();
    this.schedulePoll();
  }

  /** Leaves every topic and stops every timer. Idempotent. */
  stop(reason: EndReason | null = null): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.timers.values()) this.clock.clearTimeout(h);
    this.timers.clear();
    this.offResume?.();
    this.offResume = null;
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
    void this.syncClock();
    void this.refetchRoom();
    void this.refetchBattle();
    void this.beat();
  }

  /** Who this client is in the room's Presence (tracked once the topic is subscribed). */
  setPresence(displayName: string): void {
    this.presence = { user_id: this.userId, display_name: displayName, device: deviceKind() };
    this.flushPresence();
  }

  /** The player's BUILD activity (lines, last build, typing); sent at most every 2 s. */
  setActivity(activity: Activity): void {
    this.activity = activity;
    this.flushPresence();
  }

  // --- Room ---------------------------------------------------------------------------

  private onRoomStatus(status: ChannelStatus): void {
    if (this.stopped) return;
    if (status === 'SUBSCRIBED') {
      this.roomSubscribed = true;
      this.patch({ connection: 'live' });
      // (Re)subscribed: anything may have been missed. Presence must be tracked again.
      void this.roomTopic?.refetch();
      void this.refetchBattle();
      this.lastTracked = null;
      this.flushPresence();
    } else {
      this.roomSubscribed = false;
      // supabase-js rejoins on its own; poll meanwhile.
      this.patch({ connection: 'degraded' });
    }
    this.schedulePoll();
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
    this.closeBattle();
    this.battleId = battleId;
    this.patch({ battle: null });
    if (battleId === null || this.stopped) return;
    const topic = new VersionedTopic<BattleSnapshot, BattleEvent>({
      version: (s) => s.battle.version,
      reduce: applyBattleEvent,
      fetch: () => this.api.getBattleSnapshot(battleId),
      onChange: (s) => {
        if (this.battleTopic === topic) this.patch({ battle: s });
      },
      onApplied: (event, battle, previous) => {
        if (this.battleTopic === topic) this.notify({ topic: 'battle', event, battle, previous });
      },
      onFetchError: () => {
        // Retried by the next event, the fallback poll or a resync.
      },
      stats: this.stats,
    });
    this.battleTopic = topic;
    // Presence lives on the room topic (lobby and BUILD sidebar alike): none here.
    this.battleSub = this.realtime.subscribe(
      battleTopic(battleId),
      { presenceKey: null },
      {
        broadcast: (_event, payload) => {
          const ev = parseBattleEvent(payload);
          if (ev) topic.receive(ev);
        },
        presence: () => undefined,
        status: (status) => {
          if (status === 'SUBSCRIBED') void topic.refetch();
        },
      },
    );
    void topic.refetch();
  }

  private closeBattle(): void {
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
  }

  private scheduleClock(): void {
    this.setTimer('clock', this.timings.clockResyncMs, () => {
      void this.syncClock().finally(() => {
        this.scheduleClock();
      });
    });
  }

  private async syncClock(): Promise<void> {
    const offset = await measureClockOffset(
      () => this.api.serverNow(),
      () => this.clock.now(),
    );
    if (offset !== null && !this.stopped) this.patch({ clockOffsetMs: offset });
  }

  /** While the room topic is down, poll both snapshots. */
  private schedulePoll(): void {
    this.clearTimer('poll');
    if (this.stopped || this.roomSubscribed) return;
    this.setTimer('poll', this.timings.fallbackPollMs, () => {
      void this.refetchRoom();
      void this.refetchBattle();
      this.schedulePoll();
    });
  }

  // --- Presence -----------------------------------------------------------------------

  private flushPresence(): void {
    if (this.stopped || !this.presence || !this.roomSub || !this.roomSubscribed) return;
    const payload: PresencePayload = { ...this.presence, activity: this.activity };
    const json = JSON.stringify(payload);
    if (json === this.lastTracked) return;
    const wait = this.lastTrackAt + this.timings.presenceThrottleMs - this.clock.now();
    if (wait > 0) {
      if (!this.timers.has('presence')) {
        this.setTimer('presence', wait, () => {
          this.flushPresence();
        });
      }
      return;
    }
    this.lastTrackAt = this.clock.now();
    this.lastTracked = json;
    void this.roomSub.track(payload).then((ok) => {
      if (!ok && this.lastTracked === json) this.lastTracked = null;
    });
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
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}
