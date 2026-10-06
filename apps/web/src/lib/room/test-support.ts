/**
 * Fakes for the room tests: snapshots, an in-memory room API, a fake Realtime (topics the
 * test drives by hand) and a fake environment (visibility / online). Times use Date.now(),
 * which vitest's fake timers control.
 */
import type { BattlePhase } from '@br/game';
import type { BattleSnapshot, SnapshotBuild } from '../solo/types';
import { GameError } from '../solo/errors';
import type { RoomApi } from './api';
import type {
  ChannelStatus,
  RealtimePort,
  SyncEnvironment,
  TopicHandlers,
  TopicSubscription,
} from './sync';
import type { HeartbeatResult, JoinResult, RoomMember, RoomSettings, RoomSnapshot } from './types';

export const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BATTLE_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
export const BATTLE_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
export const ME = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const CLEO = '33333333-3333-4333-8333-333333333333';

const iso = (t: number) => new Date(t).toISOString();

export function member(userId: string, name: string, extra: Partial<RoomMember> = {}): RoomMember {
  return {
    user_id: userId,
    display_name: name,
    avatar_seed: null,
    role: 'player',
    state: 'active',
    is_ready: false,
    is_host: false,
    joined_at: iso(Date.now() - 60_000),
    last_seen_at: iso(Date.now()),
    left_at: null,
    ...extra,
  };
}

export function roomSnapshot(
  opts: {
    version?: number;
    status?: RoomSnapshot['room']['status'];
    hostId?: string;
    battleId?: string | null;
    battlePhase?: BattlePhase;
    members?: RoomMember[];
  } = {},
): RoomSnapshot {
  const hostId = opts.hostId ?? ME;
  const members = (
    opts.members ?? [member(ME, 'Ada'), member(BOB, 'Bob'), member(CLEO, 'Cleo')]
  ).map((m) => ({ ...m, is_host: m.user_id === hostId }));
  const mine = members.find((m) => m.user_id === ME);
  const battleId = opts.battleId ?? null;
  return {
    server_now: iso(Date.now()),
    me: {
      user_id: ME,
      role: mine?.role ?? 'player',
      state: mine?.state ?? 'active',
      is_ready: mine?.is_ready ?? false,
      is_host: hostId === ME,
    },
    room: {
      id: ROOM,
      code: 'K7QXM',
      host_id: hostId,
      status: opts.status ?? (battleId ? 'in_battle' : 'open'),
      version: opts.version ?? 1,
      settings: { max_players: 8 },
      max_players: 8,
      max_spectators: 20,
      current_battle_id: battleId,
      created_at: iso(Date.now() - 120_000),
      last_activity_at: iso(Date.now()),
      closed_at: null,
    },
    members,
    battle: battleId
      ? {
          id: battleId,
          phase: opts.battlePhase ?? 'spinning',
          version: 1,
          host_id: hostId,
          phase_started_at: iso(Date.now()),
          phase_ends_at: iso(Date.now() + 6_000),
          building_started_at: null,
          building_ends_at: null,
          finished_at: null,
          is_complete: false,
          created_at: iso(Date.now()),
          roster: members.map((m) => ({ user_id: m.user_id, display_name: m.display_name })),
        }
      : null,
  };
}

function build(id: string, builderId: string, extra: Partial<SnapshotBuild> = {}): SnapshotBuild {
  return {
    id,
    builder_id: builderId,
    name: null,
    status: 'draft',
    shipped_at: null,
    completion_ms: null,
    stats: {},
    capture_status: 'pending',
    screenshot_path: null,
    captured_at: null,
    source_destroyed_at: null,
    final_rank: null,
    total_votes: 0,
    ...extra,
  };
}

/** A 3-player multiplayer battle snapshot. */
export function battleSnapshot(
  opts: {
    id?: string;
    version?: number;
    phase?: BattlePhase;
    endsInMs?: number | null;
    role?: 'player' | 'spectator';
    hostId?: string;
  } = {},
): BattleSnapshot {
  const now = Date.now();
  const phase = opts.phase ?? 'building';
  const endsIn = opts.endsInMs === undefined ? 300_000 : opts.endsInMs;
  const id = opts.id ?? BATTLE_1;
  const hostId = opts.hostId ?? ME;
  return {
    server_now: iso(now),
    me: {
      user_id: ME,
      is_player: (opts.role ?? 'player') === 'player',
      role: opts.role ?? 'player',
      is_host: hostId === ME,
    },
    battle: {
      id,
      room_id: ROOM,
      host_id: hostId,
      mode: 'multiplayer',
      phase,
      version: opts.version ?? 2,
      phase_started_at: iso(now),
      phase_ends_at: endsIn === null ? null : iso(now + endsIn),
      building_started_at: phase === 'spinning' ? null : iso(now - 10_000),
      building_ends_at: phase === 'spinning' ? null : iso(now + 290_000),
      shipping_ended_at: null,
      finished_at: null,
      destroyed_at: null,
      is_complete: false,
      created_at: iso(now - 20_000),
    },
    challenge: {
      id: 'c',
      build: { text: 'A snack tracker', hint: null },
      rule: { text: 'Only one button', hint: null },
      style: { text: 'Brutalist', hint: null },
      time_limit_seconds: 300,
    },
    players: [
      { user_id: ME, display_name: 'Ada', state: 'active' },
      { user_id: BOB, display_name: 'Bob', state: 'active' },
      { user_id: CLEO, display_name: 'Cleo', state: 'active' },
    ],
    builds: [build('build-me', ME), build('build-bob', BOB), build('build-cleo', CLEO)],
    awards: [],
  };
}

// ─── Fake API ─────────────────────────────────────────────────────────────────────────

type Handler<A extends unknown[], R> = (...args: A) => R | Promise<R>;

export class FakeRoomApi implements RoomApi {
  readonly calls: [string, ...unknown[]][] = [];
  serverOffsetMs = 0;
  profile: string | null = 'Ada';
  onJoin: Handler<[string, string], JoinResult> = (code) => ({
    room_id: ROOM,
    code,
    role: 'player',
  });
  /** Lobby intents fail with this when set. */
  failWith: GameError | null = null;

  async ensureSession(): Promise<string> {
    this.calls.push(['ensureSession']);
    return Promise.resolve(ME);
  }
  async profileName(userId: string): Promise<string | null> {
    this.calls.push(['profileName', userId]);
    return Promise.resolve(this.profile);
  }
  async createRoom(name: string): Promise<JoinResult> {
    this.calls.push(['createRoom', name]);
    return Promise.resolve({ room_id: ROOM, code: 'K7QXM' });
  }
  async joinRoom(code: string, name: string): Promise<JoinResult> {
    this.calls.push(['joinRoom', code, name]);
    return this.onJoin(code, name);
  }
  private async intent(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push([name, ...args]);
    if (this.failWith) throw this.failWith;
    return Promise.resolve();
  }
  leaveRoom(roomId: string): Promise<void> {
    return this.intent('leaveRoom', roomId);
  }
  setReady(roomId: string, ready: boolean): Promise<void> {
    return this.intent('setReady', roomId, ready);
  }
  async updateSettings(roomId: string, settings: RoomSettings): Promise<RoomSettings> {
    await this.intent('updateSettings', roomId, settings);
    return settings;
  }
  kickMember(roomId: string, userId: string): Promise<void> {
    return this.intent('kickMember', roomId, userId);
  }
  async startBattle(roomId: string): Promise<string> {
    await this.intent('startBattle', roomId);
    return BATTLE_1;
  }
  room: RoomSnapshot = roomSnapshot();
  battles = new Map<string, BattleSnapshot>();
  onRoom: Handler<[], RoomSnapshot> = () => structuredClone(this.room);
  onBattle: Handler<[string], BattleSnapshot> = (id) => {
    const b = this.battles.get(id);
    if (!b) throw new GameError('battle_not_found');
    return structuredClone(b);
  };
  onHeartbeat: Handler<[], HeartbeatResult> = () => ({
    server_now: new Date(Date.now() + this.serverOffsetMs).toISOString(),
    room_version: this.room.room.version,
    host_id: this.room.room.host_id,
    status: this.room.room.status,
  });

  async getRoomSnapshot(roomId: string): Promise<RoomSnapshot> {
    this.calls.push(['getRoomSnapshot', roomId]);
    return this.onRoom();
  }
  async getBattleSnapshot(battleId: string): Promise<BattleSnapshot> {
    this.calls.push(['getBattleSnapshot', battleId]);
    return this.onBattle(battleId);
  }
  async heartbeat(roomId: string): Promise<HeartbeatResult> {
    this.calls.push(['heartbeat', roomId]);
    return this.onHeartbeat();
  }
  serverNow(): Promise<number> {
    this.calls.push(['serverNow']);
    return Promise.resolve(Date.now() + this.serverOffsetMs);
  }

  count(method: string, arg?: unknown): number {
    return this.calls.filter((c) => c[0] === method && (arg === undefined || c[1] === arg)).length;
  }
  clearCalls(): void {
    this.calls.length = 0;
  }
}

// ─── Fake Realtime ────────────────────────────────────────────────────────────────────

export class FakeTopic implements TopicSubscription {
  closed = false;
  readonly tracked: object[] = [];
  trackResult = true;
  constructor(
    readonly topic: string,
    readonly presenceKey: string,
    readonly handlers: TopicHandlers,
  ) {}
  track(payload: object): Promise<boolean> {
    this.tracked.push(payload);
    return Promise.resolve(this.trackResult);
  }
  close(): void {
    this.closed = true;
  }
  // Test drivers:
  status(s: ChannelStatus, error?: string): void {
    this.handlers.status(s, error);
  }
  send(payload: Record<string, unknown>): void {
    this.handlers.broadcast(String(payload['type']), payload);
  }
  presence(state: Record<string, unknown[]>): void {
    this.handlers.presence(state);
  }
}

export class FakeRealtime implements RealtimePort {
  readonly topics: FakeTopic[] = [];
  authCalls = 0;
  setAuth(): Promise<void> {
    this.authCalls++;
    return Promise.resolve();
  }
  subscribe(topic: string, opts: { presenceKey: string }, handlers: TopicHandlers): FakeTopic {
    const t = new FakeTopic(topic, opts.presenceKey, handlers);
    this.topics.push(t);
    return t;
  }
  /** The latest open subscription to `topic`. */
  open(topic: string): FakeTopic {
    const t = [...this.topics].reverse().find((x) => x.topic === topic && !x.closed);
    if (!t) throw new Error(`no open subscription to ${topic}`);
    return t;
  }
  isOpen(topic: string): boolean {
    return this.topics.some((x) => x.topic === topic && !x.closed);
  }
}

export class FakeEnvironment implements SyncEnvironment {
  private readonly listeners = new Set<(reason: 'visible' | 'online') => void>();
  onResume(cb: (reason: 'visible' | 'online') => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  fire(reason: 'visible' | 'online'): void {
    for (const l of this.listeners) l(reason);
  }
  get size(): number {
    return this.listeners.size;
  }
}
