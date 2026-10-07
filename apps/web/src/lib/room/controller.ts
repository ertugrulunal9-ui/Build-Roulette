/**
 * The room page on the client (`/r/[code]`): join → lobby → battle → lobby, as plain
 * TypeScript (like the SoloController) so it can be unit tested with fakes.
 *
 * - **Join:** anonymous sign-in, then `join_room` at once with the profile's name, or after a
 *   name prompt (a fun default) when the profile has none. Every `join_room` error code ends
 *   in a clear screen (`room_not_found`, `room_closed`, `kicked`, `room_full`, …).
 * - **Room:** a RoomSync (sync.ts) keeps the room and its current battle in sync; this
 *   controller sends the intents (ready, settings, kick, start, leave) and turns events into
 *   toasts (host changes, ships, joins and leaves).
 * - **Battle:** the current battle runs in a SoloController in external mode: the sync
 *   engine feeds it snapshots and the clock, and the solo stages (spin, build, ship, results,
 *   destroy) render it. REVEAL and VOTING run in a RevealVoteController fed the same
 *   snapshots. A rematch is a new battle, so new controllers.
 * - **Leave / kicked:** `leave_room` (and the battle's local workspace is deleted if a battle
 *   was running), or the kicked / closed / gone end states.
 */
import { isTerminalPhase, normalizeRoomCode } from '@br/game';
import type { SoloApi } from '../solo/api';
import {
  SoloController,
  battleWorkspaceId,
  realClock,
  type DestroyStage,
  type LocalWorkspaces,
  type SoloClock,
  type TimerHandle,
} from '../solo/controller';
import { GameError, toGameError } from '../solo/errors';
import { formatCountdown } from '../solo/format';
import { randomDisplayName } from '../solo/names';
import type { BattleSnapshot } from '../solo/types';
import type { RoomApi } from './api';
import { RevealVoteController, type ObjectUrls } from './reveal-vote';
import {
  INITIAL_SYNC_STATE,
  RoomSync,
  type EndReason,
  type RealtimePort,
  type RoomSyncState,
  type SyncEnvironment,
  type SyncNotice,
  type SyncTimings,
} from './sync';
import type { Activity, RoomSnapshot } from './types';

/** Where the display name is remembered between visits (shared with /play). */
export interface NameStore {
  get(): string | null;
  set(name: string): void;
}

export const NAME_KEY = 'br:display-name';

export const browserNameStore: NameStore = {
  get() {
    try {
      const saved = window.localStorage.getItem(NAME_KEY)?.trim();
      return saved ? saved.slice(0, 24) : null;
    } catch {
      return null;
    }
  },
  set(name) {
    try {
      window.localStorage.setItem(NAME_KEY, name);
    } catch {
      // storage blocked
    }
  },
};

export interface RoomControllerDeps {
  api: RoomApi;
  /** The battle RPCs and storage (ship, autosave, last look). */
  soloApi: SoloApi;
  realtime: RealtimePort;
  cdnBaseUrl: string;
  localWorkspaces: LocalWorkspaces;
  nameStore?: NameStore;
  clock?: SoloClock;
  env?: SyncEnvironment;
  syncTimings?: Partial<SyncTimings>;
  /** How long a toast stays (ms). */
  toastMs?: number;
  /** Object URLs for the reveal thumbnails (tests). */
  objectUrls?: ObjectUrls;
}

export type RoomStage = 'starting' | 'name' | 'joining' | 'room' | 'join_error' | 'ended';

export interface Toast {
  id: number;
  kind: 'host' | 'ship' | 'member';
  text: string;
}

export interface PendingActions {
  ready: boolean;
  start: boolean;
  settings: boolean;
  /** The user being kicked. */
  kick: string | null;
  leave: boolean;
}

export interface RoomState {
  stage: RoomStage;
  /** The room code from the URL, canonical (upper case), or null if it is not a code. */
  code: string | null;
  userId: string | null;
  /** The name to join with (the profile's, the remembered one, or a random default). */
  displayName: string;
  /** Why joining failed (stage `join_error`, or `name` for a bad name). */
  error: GameError | null;
  ended: EndReason | null;
  sync: RoomSyncState;
  /** The current battle's controller (null in the lobby before the first battle). */
  battle: SoloController | null;
  /** The current battle's REVEAL and VOTING (created with `battle`). */
  show: RevealVoteController | null;
  toasts: readonly Toast[];
  pending: PendingActions;
  /** The last failed lobby action (ready, start, kick, settings, leave). */
  actionError: GameError | null;
}

const NO_PENDING: PendingActions = {
  ready: false,
  start: false,
  settings: false,
  kick: null,
  leave: false,
};

export function initialRoomState(code: string | null): RoomState {
  return {
    stage: 'starting',
    code,
    userId: null,
    displayName: '',
    error: null,
    ended: null,
    sync: INITIAL_SYNC_STATE,
    battle: null,
    show: null,
    toasts: [],
    pending: NO_PENDING,
    actionError: null,
  };
}

export type RoomView = 'loading' | 'lobby' | 'battle';

/**
 * What the room page shows: the battle while one runs (and while its destroy moment plays
 * on screen), otherwise the lobby.
 */
export function roomView(
  room: RoomSnapshot | null,
  battle: BattleSnapshot | null,
  destroy: DestroyStage,
): RoomView {
  if (!room) return 'loading';
  const current = room.room.current_battle_id;
  const mine = battle !== null && battle.battle.id === current ? battle : null;
  if (room.room.status === 'in_battle') return mine ? 'battle' : 'loading';
  if (mine && (!isTerminalPhase(mine.battle.phase) || destroy === 'animating')) return 'battle';
  return 'lobby';
}

/** Ready players (active, role player, ready) in the room. */
export function readyCount(room: RoomSnapshot): number {
  return room.members.filter((m) => m.role === 'player' && m.state === 'active' && m.is_ready)
    .length;
}

/** Active players in the room. */
export function playerCount(room: RoomSnapshot): number {
  return room.members.filter((m) => m.role === 'player' && m.state === 'active').length;
}

export class RoomController {
  private state: RoomState;
  private readonly listeners = new Set<() => void>();
  private readonly deps: RoomControllerDeps;
  private readonly clock: SoloClock;
  private readonly nameStore: NameStore | null;
  private sync: RoomSync | null = null;
  private offSync: (() => void) | null = null;
  private offNotice: (() => void) | null = null;
  private battle: SoloController | null = null;
  private show: RevealVoteController | null = null;
  private disposed = false;
  private nextToastId = 1;
  private readonly toastTimers = new Map<number, TimerHandle>();
  /** Bumped on every join attempt; results of an older attempt are dropped. */
  private epoch = 0;

  constructor(code: string, deps: RoomControllerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.nameStore = deps.nameStore ?? null;
    this.state = initialRoomState(normalizeRoomCode(code));
  }

  // --- Store contract -----------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RoomState => this.state;

  // --- Join ---------------------------------------------------------------------------

  /** Signs in, then joins with the profile's name or asks for one. */
  async init(): Promise<void> {
    const epoch = ++this.epoch;
    if (this.state.code === null) {
      this.patch({ stage: 'join_error', error: new GameError('room_not_found') });
      return;
    }
    this.patch({ stage: 'starting', error: null });
    let userId: string;
    try {
      userId = await this.deps.api.ensureSession();
    } catch (e) {
      if (epoch === this.epoch) this.patch({ stage: 'join_error', error: toGameError(e) });
      return;
    }
    if (epoch !== this.epoch) return;
    this.patch({ userId });
    const profile = await this.deps.api.profileName(userId).catch(() => null);
    if (epoch !== this.epoch) return;
    if (profile) {
      this.patch({ displayName: profile });
      await this.join(profile);
    } else {
      this.patch({
        stage: 'name',
        displayName: this.nameStore?.get() ?? randomDisplayName(),
      });
    }
  }

  /** Joins (or rejoins) the room with `name`. */
  async join(name: string): Promise<void> {
    const code = this.state.code;
    const displayName = name.trim();
    if (code === null || displayName.length === 0 || this.disposed) return;
    const epoch = ++this.epoch;
    this.patch({ stage: 'joining', displayName, error: null, ended: null, actionError: null });
    try {
      if (this.state.userId === null) {
        const userId = await this.deps.api.ensureSession();
        if (epoch !== this.epoch) return;
        this.patch({ userId });
      }
      const joined = await this.deps.api.joinRoom(code, displayName);
      if (epoch !== this.epoch) return;
      this.nameStore?.set(displayName);
      this.connect(joined.room_id, displayName);
    } catch (e) {
      if (epoch !== this.epoch) return;
      const error = toGameError(e);
      this.patch({ stage: error.code === 'invalid_display_name' ? 'name' : 'join_error', error });
    }
  }

  /** After an error or leaving: try joining again with the same name. */
  retry(): Promise<void> {
    return this.state.displayName ? this.join(this.state.displayName) : this.init();
  }

  private connect(roomId: string, displayName: string): void {
    const userId = this.state.userId;
    if (userId === null) return;
    this.teardownSync();
    const sync = new RoomSync({
      api: this.deps.api,
      realtime: this.deps.realtime,
      userId,
      clock: this.clock,
      env: this.deps.env,
      timings: this.deps.syncTimings,
    });
    this.sync = sync;
    this.offSync = sync.subscribe(() => {
      this.onSync(sync);
    });
    this.offNotice = sync.onNotice((n) => {
      this.onNotice(n);
    });
    sync.setPresence(displayName);
    this.patch({ stage: 'room', sync: sync.getSnapshot() });
    void sync.start(roomId);
  }

  // --- Lobby intents ------------------------------------------------------------------

  setReady(ready: boolean): Promise<void> {
    return this.action('ready', (api, roomId) => api.setReady(roomId, ready));
  }

  setMaxPlayers(maxPlayers: number): Promise<void> {
    return this.action('settings', async (api, roomId) => {
      await api.updateSettings(roomId, { max_players: maxPlayers });
    });
  }

  /** Host only (the UI confirms first). */
  kick(userId: string): Promise<void> {
    return this.action('kick', (api, roomId) => api.kickMember(roomId, userId), userId);
  }

  /** Host only: starts a battle (or the rematch). */
  start(): Promise<void> {
    return this.action('start', async (api, roomId) => {
      await api.startBattle(roomId);
      // The room event switches every client; refetch so this one does not wait for it.
      void this.sync?.refetchRoom();
    });
  }

  /** `leave_room`, then the "you left" screen (rejoin possible). */
  async leave(): Promise<void> {
    const roomId = this.state.sync.roomId;
    if (!roomId || this.state.pending.leave) return;
    this.patch({ pending: { ...this.state.pending, leave: true }, actionError: null });
    try {
      await this.deps.api.leaveRoom(roomId);
    } catch (e) {
      const err = toGameError(e);
      if (err.code !== 'not_a_member' && err.code !== 'kicked') {
        this.patch({ pending: { ...this.state.pending, leave: false }, actionError: err });
        return;
      }
    }
    this.finish('left');
  }

  /** The player's BUILD activity for the others' progress sidebar (throttled by the engine). */
  setActivity(activity: Activity): void {
    this.sync?.setActivity(activity);
  }

  dismissToast(id: number): void {
    const h = this.toastTimers.get(id);
    if (h !== undefined) this.clock.clearTimeout(h);
    this.toastTimers.delete(id);
    this.patch({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  dismissActionError(): void {
    this.patch({ actionError: null });
  }

  /** The server's clock (for the spin reels and countdowns outside a battle). */
  serverNow(): number {
    return this.clock.now() + this.state.sync.clockOffsetMs;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.teardownSync();
    this.dropBattle();
    for (const h of this.toastTimers.values()) this.clock.clearTimeout(h);
    this.toastTimers.clear();
    this.listeners.clear();
  }

  // --- Internals ----------------------------------------------------------------------

  private async action(
    name: Exclude<keyof PendingActions, 'kick' | 'leave'> | 'kick',
    run: (api: RoomApi, roomId: string) => Promise<void>,
    kickUser?: string,
  ): Promise<void> {
    const roomId = this.state.sync.roomId;
    if (!roomId || this.state.stage !== 'room') return;
    const busy = name === 'kick' ? this.state.pending.kick !== null : this.state.pending[name];
    if (busy) return;
    const set = (on: boolean) =>
      name === 'kick'
        ? { ...this.state.pending, kick: on ? (kickUser ?? null) : null }
        : { ...this.state.pending, [name]: on };
    this.patch({ pending: set(true), actionError: null });
    try {
      await run(this.deps.api, roomId);
      this.patch({ pending: set(false) });
    } catch (e) {
      const err = toGameError(e);
      this.patch({ pending: set(false), actionError: err });
      // The server may know better (a host change, a battle that started): catch up.
      void this.sync?.refetchRoom();
    }
  }

  private onSync(sync: RoomSync): void {
    if (sync !== this.sync) return;
    const next = sync.getSnapshot();
    const prevRoom = this.state.sync.room;
    if (prevRoom && next.room && prevRoom.room.host_id !== next.room.room.host_id) {
      const host = next.room.members.find((m) => m.user_id === next.room?.room.host_id);
      this.toast(
        'host',
        next.room.me.is_host
          ? '👑 You are the host now.'
          : `👑 ${host?.display_name ?? 'Someone else'} is the host now.`,
      );
    }
    this.patch({ sync: next });
    this.updateBattle(next);
    if (next.ended) this.finish(next.ended);
  }

  /** Keeps the SoloController in step with the current battle snapshot. */
  private updateBattle(s: RoomSyncState): void {
    const snap = s.battle;
    const currentId = s.room?.room.current_battle_id ?? null;
    if (this.battle && this.battle.getSnapshot().battleId !== currentId) {
      this.dropBattle();
      this.patch({ battle: null, show: null });
    }
    if (snap === null) return;
    if (snap.battle.id !== currentId) return;
    if (!this.battle) {
      const refetch = () => this.sync?.refetchBattle() ?? Promise.resolve();
      const c = new SoloController({
        api: this.deps.soloApi,
        cdnBaseUrl: this.deps.cdnBaseUrl,
        localWorkspaces: this.deps.localWorkspaces,
        clock: this.clock,
        external: { refetch },
      });
      const show = new RevealVoteController(snap.battle.id, {
        api: this.deps.api,
        cdnBaseUrl: this.deps.cdnBaseUrl,
        refetch,
        clock: this.clock,
        ...(this.deps.objectUrls ? { objectUrls: this.deps.objectUrls } : {}),
      });
      this.battle = c;
      this.show = show;
      c.openExternal(snap, s.clockOffsetMs);
      show.receive(snap);
      this.patch({ battle: c, show });
    } else {
      this.battle.receive(snap);
      this.battle.setClockOffset(s.clockOffsetMs);
      this.show?.receive(snap);
    }
  }

  private dropBattle(): void {
    this.battle?.dispose();
    this.battle = null;
    this.show?.dispose();
    this.show = null;
  }

  private onNotice(n: SyncNotice): void {
    if (n.topic === 'room') {
      const ev = n.event;
      if (ev.type !== 'member' || ev.user_id === n.room.me.user_id) return;
      const name = ev.display_name ?? 'Someone';
      if (ev.change === 'member_joined') {
        this.toast('member', `${name} joined${ev.role === 'spectator' ? ' to watch' : ''}.`);
      } else if (ev.change === 'member_left') {
        this.toast('member', `${name} left.`);
      } else if (ev.change === 'member_kicked') {
        this.toast('member', `${name} was removed by the host.`);
      }
      return;
    }
    const ev = n.event;
    if (ev.type === 'build') {
      const who =
        ev.user_id === n.battle.me.user_id
          ? 'You'
          : (n.battle.players.find((p) => p.user_id === ev.user_id)?.display_name ?? 'Someone');
      this.toast('ship', `🚀 ${who} shipped “${ev.name}” at ${formatCountdown(ev.completion_ms)}`);
    }
  }

  private toast(kind: Toast['kind'], text: string): void {
    const id = this.nextToastId++;
    // At most three at a time; the oldest goes first.
    const keep = this.state.toasts.slice(-2);
    for (const t of this.state.toasts) {
      if (!keep.includes(t)) this.dismissToast(t.id);
    }
    this.patch({ toasts: [...keep, { id, kind, text }] });
    this.toastTimers.set(
      id,
      this.clock.setTimeout(() => {
        this.toastTimers.delete(id);
        this.dismissToast(id);
      }, this.deps.toastMs ?? 5_000),
    );
  }

  /** The session is over (left, kicked, closed, gone). */
  private finish(reason: EndReason): void {
    const battle = this.state.sync.battle;
    // Nothing of a running battle stays in this browser (the server keeps the autosave).
    if (battle?.me.is_player && !isTerminalPhase(battle.battle.phase)) {
      void this.deps.localWorkspaces
        .delete(battleWorkspaceId(battle.battle.id))
        .catch(() => undefined);
    }
    this.teardownSync();
    this.dropBattle();
    this.patch({
      stage: 'ended',
      ended: reason,
      battle: null,
      show: null,
      pending: NO_PENDING,
    });
  }

  private teardownSync(): void {
    this.offSync?.();
    this.offNotice?.();
    this.offSync = null;
    this.offNotice = null;
    this.sync?.stop();
    this.sync = null;
  }

  private patch(p: Partial<RoomState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}
