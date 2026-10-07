/**
 * Fakes for the room tests: snapshots, an in-memory room API, a fake Realtime (topics the
 * test drives by hand) and a fake environment (visibility / online). Times use Date.now(),
 * which vitest's fake timers control.
 */
import type { BattlePhase } from '@br/game';
import type {
  BattleSnapshot,
  CastVoteResult,
  HostRevealResult,
  MyVotes,
  RevealBuild,
  SnapshotBuild,
} from '../solo/types';
import { GameError } from '../solo/errors';
import type { RoomApi } from './api';
import type {
  ChannelStatus,
  RealtimePort,
  SyncEnvironment,
  TopicHandlers,
  TopicSubscription,
} from './sync';
import type {
  HeartbeatResult,
  JoinResult,
  RoomMember,
  RoomSettings,
  RoomSettingsPatch,
  RoomSnapshot,
} from './types';

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

export function build(
  id: string,
  builderId: string,
  extra: Partial<SnapshotBuild> = {},
): SnapshotBuild {
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
    /**
     * REVEAL / VOTING / RESULTS of an M4 battle: every build is final (shipped) and revealed
     * in this order (build ids; default me, bob, cleo).
     */
    revealOrder?: string[];
    revealIndex?: number;
    voteProgress?: { voted_count: number; eligible_count: number } | null;
  } = {},
): BattleSnapshot {
  const now = Date.now();
  const phase = opts.phase ?? 'building';
  const m4 = phase === 'reveal' || phase === 'voting' || opts.revealOrder !== undefined;
  const order = m4 ? (opts.revealOrder ?? ['build-me', 'build-bob', 'build-cleo']) : null;
  const final = (id: string, extra: Partial<SnapshotBuild> = {}): Partial<SnapshotBuild> =>
    order?.includes(id)
      ? { status: 'shipped', name: `${id} app`, shipped_at: iso(now - 60_000), ...extra }
      : extra;
  const isPlayer = (opts.role ?? 'player') === 'player';
  const endsIn = opts.endsInMs === undefined ? 300_000 : opts.endsInMs;
  const id = opts.id ?? BATTLE_1;
  const hostId = opts.hostId ?? ME;
  return {
    server_now: iso(now),
    me: {
      user_id: ME,
      is_player: isPlayer,
      role: opts.role ?? 'player',
      is_host: hostId === ME,
      is_voter: isPlayer,
      can_vote: isPlayer && phase === 'voting',
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
      reveal_vote: true,
      reveal_order: order,
      reveal_index: order ? (opts.revealIndex ?? 0) : null,
      reveal_slot_s: order ? 60 : null,
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
    builds: [
      build('build-me', ME, final('build-me')),
      build('build-bob', BOB, final('build-bob')),
      build('build-cleo', CLEO, final('build-cleo')),
    ],
    awards: [],
    vote_categories: [
      { slug: 'overall', label: 'Best Build', description: 'The build you would actually use.' },
      {
        slug: 'rule',
        label: 'Best Use of the Rule',
        description: 'Who turned the RULE card into a feature.',
      },
      { slug: 'style', label: 'Best Style', description: 'Who nailed the STYLE card.' },
      { slug: 'chaos', label: 'Most Chaotic', description: 'Delightfully unhinged.' },
    ],
    vote_progress:
      opts.voteProgress !== undefined
        ? opts.voteProgress
        : phase === 'voting'
          ? { voted_count: 0, eligible_count: 3 }
          : null,
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
  async updateSettings(roomId: string, settings: RoomSettingsPatch): Promise<RoomSettings> {
    await this.intent('updateSettings', roomId, settings);
    return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null));
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
  /** The server's battle version; by default the battle snapshot's own. */
  onBattleVersion: Handler<[string], number | null> = (id) =>
    this.battles.get(id)?.battle.version ?? null;
  async battleVersion(battleId: string): Promise<number | null> {
    this.calls.push(['battleVersion', battleId]);
    return this.onBattleVersion(battleId);
  }
  serverNow(): Promise<number> {
    this.calls.push(['serverNow']);
    return Promise.resolve(Date.now() + this.serverOffsetMs);
  }

  // --- REVEAL and VOTING ---
  /** Objects of `ephemeral-builds` by path. */
  readonly objects = new Map<string, string | Blob>();
  revealBuilds: RevealBuild[] = revealBuilds();
  onRevealBuilds: Handler<[], RevealBuild[]> = () => structuredClone(this.revealBuilds);
  onHost: Handler<['next' | 'skip', number], HostRevealResult> = (_kind, v) => ({
    changed: true,
    version: v + 1,
    phase: 'reveal',
    phase_ends_at: null,
    reveal_index: 1,
  });
  /** The caller's ballot on the server. */
  ballot: Record<string, string> = {};
  categories = 4;
  onVote: Handler<[string, string], CastVoteResult> = (category, buildId) => {
    this.ballot[category] = buildId;
    return {
      category,
      build_id: buildId,
      ballot_complete: Object.keys(this.ballot).length >= this.categories,
      battle: { version: 30, phase: 'voting', phase_ends_at: null },
    };
  };
  onMyVotes: Handler<[], MyVotes> = () => ({
    votes: { ...this.ballot },
    complete: Object.keys(this.ballot).length >= this.categories,
  });

  async getRevealBuilds(battleId: string): Promise<RevealBuild[]> {
    this.calls.push(['getRevealBuilds', battleId]);
    return this.onRevealBuilds();
  }
  async revealNext(battleId: string, version: number): Promise<HostRevealResult> {
    this.calls.push(['revealNext', battleId, version]);
    return this.onHost('next', version);
  }
  async skipToVote(battleId: string, version: number): Promise<HostRevealResult> {
    this.calls.push(['skipToVote', battleId, version]);
    return this.onHost('skip', version);
  }
  async castVote(battleId: string, category: string, buildId: string): Promise<CastVoteResult> {
    this.calls.push(['castVote', category, buildId]);
    return this.onVote(category, buildId);
  }
  async getMyVotes(battleId: string): Promise<MyVotes> {
    this.calls.push(['getMyVotes', battleId]);
    return this.onMyVotes();
  }
  downloadText(path: string): Promise<string | null> {
    this.calls.push(['downloadText', path]);
    const body = this.objects.get(path);
    if (body === undefined) return Promise.resolve(null);
    return typeof body === 'string' ? Promise.resolve(body) : body.text();
  }
  downloadBlob(path: string): Promise<Blob | null> {
    this.calls.push(['downloadBlob', path]);
    const body = this.objects.get(path);
    if (body === undefined) return Promise.resolve(null);
    return Promise.resolve(typeof body === 'string' ? new Blob([body]) : body);
  }

  count(method: string, arg?: unknown): number {
    return this.calls.filter((c) => c[0] === method && (arg === undefined || c[1] === arg)).length;
  }
  clearCalls(): void {
    this.calls.length = 0;
  }
}

/**
 * `get_reveal_builds` for {@link battleSnapshot}'s M4 battle (me, bob, cleo in that order),
 * and the matching objects (bundle, css, manifest; a thumbnail for the first two).
 */
export function revealBuilds(
  order: string[] = ['build-me', 'build-bob', 'build-cleo'],
): RevealBuild[] {
  const builders: Record<string, [string, string]> = {
    'build-me': [ME, 'Ada'],
    'build-bob': [BOB, 'Bob'],
    'build-cleo': [CLEO, 'Cleo'],
  };
  return order.map((id, position) => {
    const [builderId, name] = builders[id] ?? [ME, 'Ada'];
    const dir = `${BATTLE_1}/${builderId}`;
    return {
      build_id: id,
      position,
      name: `${id} app`,
      builder_id: builderId,
      builder_name: name,
      status: 'shipped',
      files: {
        js: `${dir}/bundle.js`,
        css: `${dir}/bundle.css`,
        manifest: `${dir}/manifest.json`,
        thumb: id === 'build-cleo' ? null : `${dir}/thumb.webp`,
      },
    };
  });
}

/** Puts the objects of {@link revealBuilds} into the fake storage. */
export function storeRevealObjects(api: FakeRoomApi): void {
  for (const b of api.revealBuilds) {
    if (b.files.js) api.objects.set(b.files.js, `console.log(${JSON.stringify(b.build_id)})`);
    if (b.files.css) api.objects.set(b.files.css, `.${b.build_id}{}`);
    if (b.files.manifest) {
      api.objects.set(
        b.files.manifest,
        JSON.stringify({ dependencies: { react: '19.2.0', 'react-dom': '19.2.0' } }),
      );
    }
    if (b.files.thumb) api.objects.set(b.files.thumb, new Blob(['webp'], { type: 'image/webp' }));
  }
}

// ─── Fake Realtime ────────────────────────────────────────────────────────────────────

export class FakeTopic implements TopicSubscription {
  closed = false;
  readonly tracked: object[] = [];
  trackResult = true;
  constructor(
    readonly topic: string,
    readonly presenceKey: string | null,
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
  subscribe(
    topic: string,
    opts: { presenceKey: string | null },
    handlers: TopicHandlers,
  ): FakeTopic {
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
  private readonly offlineListeners = new Set<() => void>();
  onResume(cb: (reason: 'visible' | 'online') => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onOffline(cb: () => void): () => void {
    this.offlineListeners.add(cb);
    return () => this.offlineListeners.delete(cb);
  }
  fire(reason: 'visible' | 'online' | 'offline'): void {
    if (reason === 'offline') {
      for (const l of this.offlineListeners) l();
      return;
    }
    for (const l of this.listeners) l(reason);
  }
  get size(): number {
    return this.listeners.size + this.offlineListeners.size;
  }
}
