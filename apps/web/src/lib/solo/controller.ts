/**
 * The solo game loop on the client (docs/04): SPIN → BUILD → SHIP → RESULTS → DESTROY.
 *
 * Postgres decides every state; this controller only renders it and sends intents:
 * - **Sync:** it polls `get_battle_snapshot` (no Realtime in M2), faster when something is
 *   about to change, and on `visibilitychange`.
 * - **Time:** `server_now()` sampled three times (lowest RTT wins) on open and every 60 s;
 *   countdowns are `remainingMs(phase_ends_at, Date.now(), offset)` (docs/04 §4.5).
 * - **Deadlines:** when a countdown reaches 0 it calls `advance_battle(id, version)` after a
 *   random 0–500 ms jitter (compare-and-set; pg_cron is the backstop). An overdue battle
 *   that does not move (RESULTS waiting for its screenshot) is nudged again every 5 s.
 * - **Autosave:** every 30 s and when the tab is hidden, the last good build and the
 *   workspace go to `autosave/{source.json,bundle.js,bundle.css}` (upsert). A final
 *   autosave runs 3 s before the deadline and once more during the SHIPPING grace, so a
 *   player who does not ship is auto-shipped with their latest work.
 * - **Ship:** thumbnail (best effort) → production build → upload `source.json`,
 *   `bundle.js`, `bundle.css`, `thumb.webp` → `ship_build` with stats.
 * - **Results:** the shipped bundle is fetched back from storage for the "last look"
 *   preview (reveal mode) until DESTROY.
 * - **Destroy:** when the phase becomes `destroyed`, a short animation, then the battle's
 *   IndexedDB workspace is deleted and the reveal preview is dropped.
 *
 * Plain TypeScript with injected API, clock and storage, like SandboxController, so it can
 * be unit tested with fakes and fake timers. React reads it with useSyncExternalStore.
 *
 * **Multiplayer (T-017):** the same controller runs one battle of a room in *external* mode
 * (`deps.external`, `openExternal`): the room's sync engine (src/lib/room/sync.ts) owns the
 * battle snapshot (Realtime events + refetches) and the server clock, and pushes them in with
 * `receive()` and `setClockOffset()`. The controller then neither polls nor samples the
 * clock; everything else (deadline nudges, autosave, ship, last look, destroy) is shared.
 */
import { isTerminalPhase, remainingMs } from '@br/game';
import type { ImportMap } from '@br/protocol';
import { buildImportMap, type PreviewBuild } from '@br/runtime';
import type { Workspace } from '@br/workspace';
import type { BuildFile, SoloApi } from './api';
import { measureClockOffset } from './clock-sync';
import { GameError, toGameError } from './errors';
import { buildStats, parseSourceJson, sourceJson } from './stats';
import type { BattleSnapshot, BuildStats, SnapshotBuild } from './types';

// ─── Dependencies ─────────────────────────────────────────────────────────────────────

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface SoloClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  random(): number;
}

export const realClock: SoloClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h);
  },
  random: () => Math.random(),
};

/** The battle workspaces in IndexedDB (key `battle:{id}`). */
export interface LocalWorkspaces {
  delete(workspaceId: string): Promise<void>;
  /** Deletes every battle workspace except `keepId` (stale-workspace cleanup, docs/03 §3.6). */
  deleteBattleWorkspacesExcept(keepId: string | null): Promise<void>;
}

export interface BuildArtifacts {
  js: string;
  css: string;
  importMap: ImportMap;
}

/** What the BUILD screen exposes while it is mounted. */
export interface WorkspaceBridge {
  /** The workspace as edited now (files + manifest). */
  workspace(): Workspace | null;
  /** The last successful build shown in the live preview (dev mode). */
  lastGoodBuild(): BuildArtifacts | null;
  /** A production build of the current workspace. */
  productionBuild(): Promise<BuildArtifacts & { ok: boolean; errorCount: number }>;
  /** Best-effort thumbnail of the live preview (WebP), or null. */
  thumbnail(size: { width: number; height: number }): Promise<Blob | null>;
  counters(): { rebuilds: number; pastes: number };
}

export interface SoloTimings {
  autosaveIntervalMs: number;
  /** The final autosave runs this long before the build deadline. */
  finalAutosaveLeadMs: number;
  nudgeJitterMs: number;
  /** An overdue battle that did not move is nudged again after this long. */
  nudgeRetryMs: number;
  clockResyncMs: number;
  /** Length of the "destroy build" moment before the local copies are wiped. */
  destroyAnimationMs: number;
  /** Snapshot polling per phase (null: no polling). */
  pollMs: Partial<Record<string, number>>;
  /** After DESTROYED, poll for `destroyed_at` (the server-side delete) at most this long. */
  destroyedPollLimitMs: number;
  thumbnailSize: { width: number; height: number };
}

export const DEFAULT_TIMINGS: SoloTimings = {
  autosaveIntervalMs: 30_000,
  finalAutosaveLeadMs: 3_000,
  nudgeJitterMs: 500,
  nudgeRetryMs: 5_000,
  clockResyncMs: 60_000,
  destroyAnimationMs: 2_400,
  pollMs: {
    spinning: 3_000,
    building: 10_000,
    shipping: 2_000,
    results: 2_000,
    destroyed: 3_000,
  },
  destroyedPollLimitMs: 180_000,
  thumbnailSize: { width: 640, height: 400 },
};

/**
 * Multiplayer: who owns the snapshot. `refetch()` asks for a fresh battle snapshot, which
 * arrives through `SoloController.receive()`.
 */
export interface ExternalBattleSync {
  refetch(): Promise<void>;
}

export interface SoloControllerDeps {
  api: SoloApi;
  /** Multiplayer: the room sync engine drives snapshots and the clock (no polling). */
  external?: ExternalBattleSync;
  cdnBaseUrl: string;
  localWorkspaces: LocalWorkspaces;
  clock?: SoloClock;
  timings?: Partial<SoloTimings>;
  /** Called when the open battle changes (to keep `?battle=` in the URL). */
  onBattleChange?: (battleId: string | null) => void;
}

// ─── State ────────────────────────────────────────────────────────────────────────────

export type Stage = 'name' | 'starting' | 'resume' | 'loading' | 'battle';

export type ShipStatus =
  'idle' | 'thumbnail' | 'building' | 'uploading' | 'shipping' | 'done' | 'error';

export interface ShipState {
  status: ShipStatus;
  error: GameError | null;
  /** After `build_failed`: the last working preview can be shipped instead. */
  canShipLastGood: boolean;
}

export interface AutosaveState {
  status: 'idle' | 'saving' | 'saved' | 'error' | 'closed';
  lastSavedAt: number | null;
  error: GameError | null;
}

export interface RevealState {
  status: 'none' | 'loading' | 'ready' | 'unavailable' | 'destroyed';
  build: PreviewBuild | null;
}

export type DestroyStage = 'none' | 'animating' | 'done';

export interface SoloState {
  stage: Stage;
  userId: string | null;
  battleId: string | null;
  /** From `battle_in_progress`: the battle the player can resume. */
  resumeBattleId: string | null;
  snapshot: BattleSnapshot | null;
  /** serverClock − localClock, in ms. */
  clockOffsetMs: number;
  /** The latest error to show (banner or inline), until dismissed or replaced. */
  error: GameError | null;
  ship: ShipState;
  autosave: AutosaveState;
  reveal: RevealState;
  destroy: DestroyStage;
  /** The server deleted the battle's ephemeral files (`destroyed_at`). */
  sourceDestroyed: boolean;
}

export const INITIAL_SOLO_STATE: SoloState = {
  stage: 'name',
  userId: null,
  battleId: null,
  resumeBattleId: null,
  snapshot: null,
  clockOffsetMs: 0,
  error: null,
  ship: { status: 'idle', error: null, canShipLastGood: false },
  autosave: { status: 'idle', lastSavedAt: null, error: null },
  reveal: { status: 'none', build: null },
  destroy: 'none',
  sourceDestroyed: false,
};

/** IndexedDB key of a battle's workspace. */
export function battleWorkspaceId(battleId: string): string {
  return `battle:${battleId}`;
}

/** The caller's build in a snapshot. */
export function myBuild(snapshot: BattleSnapshot | null): SnapshotBuild | null {
  if (!snapshot) return null;
  return snapshot.builds.find((b) => b.builder_id === snapshot.me.user_id) ?? null;
}

// ─── Controller ───────────────────────────────────────────────────────────────────────

type TimerName = 'deadline' | 'final' | 'poll' | 'autosave' | 'clock' | 'destroy';

export class SoloController {
  private state: SoloState = INITIAL_SOLO_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly api: SoloApi;
  private readonly clock: SoloClock;
  private readonly timings: SoloTimings;
  private readonly deps: SoloControllerDeps;
  private readonly timers = new Map<TimerName, TimerHandle>();
  private bridge: WorkspaceBridge | null = null;
  private disposed = false;
  /** Bumped whenever the open battle changes; async work from an older epoch is dropped. */
  private epoch = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private lastNudge: { version: number; at: number } | null = null;
  private finalAutosaveDone = false;
  private shippingAutosaveDone = false;
  private autosaving: Promise<void> | null = null;
  private lastAutosaved: { build: BuildArtifacts; workspace: Workspace } | null = null;
  private destroyedSeenAt: number | null = null;
  /** The last-look bundle was requested (it is fetched once per battle). */
  private revealAttempted = false;

  constructor(deps: SoloControllerDeps) {
    this.deps = deps;
    this.api = deps.api;
    this.clock = deps.clock ?? realClock;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  // --- React store contract -----------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SoloState => this.state;

  // --- Time ---------------------------------------------------------------------------

  /** The server's clock, estimated. */
  serverNow(): number {
    return this.clock.now() + this.state.clockOffsetMs;
  }

  /** Time left in the current phase, or null when it has no deadline. */
  remainingMs(): number | null {
    const end = this.state.snapshot?.battle.phase_ends_at;
    if (!end) return null;
    return remainingMs(Date.parse(end), this.clock.now(), this.state.clockOffsetMs);
  }

  // --- Intents ------------------------------------------------------------------------

  /** Opens `?battle=` from the URL, or shows the name entry. */
  init(battleId: string | null): void {
    if (battleId) void this.openBattle(battleId);
  }

  /** Name entry → `start_solo_battle`. `battle_in_progress` offers to resume instead. */
  async start(displayName: string): Promise<void> {
    if (this.state.stage === 'starting') return;
    const epoch = ++this.epoch;
    this.patch({ stage: 'starting', error: null });
    try {
      const userId = await this.api.ensureSession();
      if (epoch !== this.epoch) return;
      this.patch({ userId });
      const battleId = await this.api.startSoloBattle(displayName.trim());
      if (epoch !== this.epoch) return;
      await this.openBattle(battleId);
    } catch (e) {
      if (epoch !== this.epoch) return;
      const err = toGameError(e);
      if (err.code === 'battle_in_progress' && err.details) {
        this.patch({ stage: 'resume', resumeBattleId: err.details, error: null });
      } else {
        this.patch({ stage: 'name', error: err });
      }
    }
  }

  resume(): Promise<void> {
    const id = this.state.resumeBattleId;
    return id ? this.openBattle(id) : Promise.resolve();
  }

  cancelResume(): void {
    this.patch({ stage: 'name', resumeBattleId: null });
  }

  dismissError(): void {
    this.patch({ error: null });
  }

  /** Closes a failed ship attempt (the player keeps building). */
  clearShipError(): void {
    if (this.state.ship.status === 'error') this.patch({ ship: INITIAL_SOLO_STATE.ship });
  }

  /** Back to the name entry for a new battle. */
  playAgain(): void {
    this.epoch++;
    this.clearAllTimers();
    this.resetBattleState();
    this.state = { ...INITIAL_SOLO_STATE, userId: this.state.userId };
    this.emit();
    this.deps.onBattleChange?.(null);
  }

  /** The BUILD screen attaches its workspace while mounted. */
  attachWorkspace(bridge: WorkspaceBridge): () => void {
    this.bridge = bridge;
    this.ensureAutosaveLoop();
    return () => {
      if (this.bridge === bridge) this.bridge = null;
    };
  }

  /** The tab was hidden: save now (docs/03 §3.6). */
  onHidden(): void {
    if (this.canAutosave()) void this.autosave();
  }

  /** The tab is visible again: resync (timers may have been throttled). */
  onVisible(): void {
    // In external mode the room sync engine resyncs on visibility itself.
    if (this.state.stage !== 'battle' || this.disposed || this.deps.external) return;
    void this.syncClock().then(() => this.refresh());
  }

  /** Autosaves now (the "Save" button and tests). */
  autosaveNow(): Promise<void> {
    return this.autosave({ force: true });
  }

  /**
   * Ships the build. `useLastGood` ships the last working preview instead of a fresh
   * production build (offered after `build_failed`).
   */
  async ship(name: string, opts: { useLastGood?: boolean } = {}): Promise<void> {
    const snap = this.state.snapshot;
    const bridge = this.bridge;
    const status = this.state.ship.status;
    if (!snap || !bridge || (status !== 'idle' && status !== 'error')) return;
    const battleId = snap.battle.id;
    const userId = snap.me.user_id;
    const epoch = this.epoch;
    const fail = (e: unknown, canShipLastGood = false) => {
      if (epoch !== this.epoch) return;
      this.patch({ ship: { status: 'error', error: toGameError(e), canShipLastGood } });
    };

    // 1. Thumbnail of what the live preview shows now (before a production build reloads it).
    this.patch({ ship: { status: 'thumbnail', error: null, canShipLastGood: false } });
    const thumb = await bridge.thumbnail(this.timings.thumbnailSize).catch(() => null);
    if (epoch !== this.epoch) return;

    // 2. The bundle.
    this.patch({ ship: { status: 'building', error: null, canShipLastGood: false } });
    let bundle: BuildArtifacts;
    if (opts.useLastGood) {
      const last = bridge.lastGoodBuild();
      if (!last) {
        fail(new GameError('nothing_built'));
        return;
      }
      bundle = last;
    } else {
      let built;
      try {
        built = await bridge.productionBuild();
      } catch (e) {
        fail(e);
        return;
      }
      if (epoch !== this.epoch) return;
      if (!built.ok) {
        fail(new GameError('build_failed'), bridge.lastGoodBuild() !== null);
        return;
      }
      bundle = built;
    }
    const workspace = bridge.workspace();
    if (!workspace) {
      fail(new GameError('nothing_built'));
      return;
    }

    // 3. Uploads (upsert, so a retry after a partial failure works).
    this.patch({ ship: { status: 'uploading', error: null, canShipLastGood: false } });
    try {
      const uploads: Promise<void>[] = [
        this.api.upload(battleId, userId, 'source.json', sourceJson(workspace)),
        this.api.upload(battleId, userId, 'bundle.js', bundle.js),
        this.api.upload(battleId, userId, 'bundle.css', bundle.css),
      ];
      if (thumb) uploads.push(this.api.upload(battleId, userId, 'thumb.webp', thumb));
      await Promise.all(uploads);
    } catch (e) {
      fail(e);
      return;
    }
    if (epoch !== this.epoch) return;

    // 4. ship_build.
    this.patch({ ship: { status: 'shipping', error: null, canShipLastGood: false } });
    const stats = buildStats(workspace, bundle, bridge.counters());
    try {
      await this.shipWithStats(battleId, name.trim(), stats);
    } catch (e) {
      const err = toGameError(e);
      if (err.code !== 'already_shipped') {
        fail(err);
        // The phase may have moved on (wrong_phase, deadline_passed): show the truth.
        void this.refresh();
        return;
      }
    }
    if (epoch !== this.epoch) return;
    this.patch({ ship: { status: 'done', error: null, canShipLastGood: false } });
    await this.refresh();
  }

  /**
   * The workspace from the remote autosave (`autosave/source.json`), for a player who opens
   * the battle where IndexedDB has no copy (another device, cleared storage; docs/04 §4.8).
   */
  async restoreWorkspace(): Promise<Workspace | null> {
    const snap = this.state.snapshot;
    // Nothing can have been autosaved before BUILDING (and the BUILD screen first mounts
    // during SPIN, so this skips a pointless request for every new battle).
    if (!snap || snap.battle.phase === 'spinning') return null;
    const text = await this.api
      .download(snap.battle.id, snap.me.user_id, 'autosave/source.json')
      .catch(() => null);
    return text === null ? null : parseSourceJson(text);
  }

  // --- External mode (multiplayer) ----------------------------------------------------

  /** Opens a room battle from a snapshot the room sync engine already has. */
  openExternal(snapshot: BattleSnapshot, clockOffsetMs: number): void {
    this.epoch++;
    this.clearAllTimers();
    this.resetBattleState();
    this.state = {
      ...INITIAL_SOLO_STATE,
      stage: 'battle',
      userId: snapshot.me.user_id,
      battleId: snapshot.battle.id,
      clockOffsetMs,
    };
    this.emit();
    this.apply(snapshot);
    void this.deps.localWorkspaces
      .deleteBattleWorkspacesExcept(
        isTerminalPhase(snapshot.battle.phase) ? null : battleWorkspaceId(snapshot.battle.id),
      )
      .catch(() => undefined);
  }

  /** A newer snapshot of the open battle (stale or foreign ones are ignored). */
  receive(snapshot: BattleSnapshot): void {
    if (this.disposed || snapshot.battle.id !== this.state.battleId) return;
    if (snapshot === this.state.snapshot) return;
    this.apply(snapshot);
  }

  /** The room sync engine measured the server clock again. */
  setClockOffset(ms: number): void {
    if (this.disposed || ms === this.state.clockOffsetMs) return;
    this.patch({ clockOffsetMs: ms });
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.clearAllTimers();
    this.listeners.clear();
    this.bridge = null;
  }

  // --- Battle lifecycle ---------------------------------------------------------------

  private async openBattle(battleId: string): Promise<void> {
    const epoch = ++this.epoch;
    this.clearAllTimers();
    this.resetBattleState();
    this.patch({
      stage: 'loading',
      battleId,
      resumeBattleId: null,
      snapshot: null,
      error: null,
      ship: INITIAL_SOLO_STATE.ship,
      autosave: INITIAL_SOLO_STATE.autosave,
      reveal: INITIAL_SOLO_STATE.reveal,
      destroy: 'none',
      sourceDestroyed: false,
    });
    try {
      const userId = await this.api.ensureSession();
      if (epoch !== this.epoch) return;
      this.patch({ userId });
      await this.syncClock();
      const snapshot = await this.api.getSnapshot(battleId);
      if (epoch !== this.epoch) return;
      this.patch({ stage: 'battle' });
      this.deps.onBattleChange?.(battleId);
      this.apply(snapshot);
      void this.deps.localWorkspaces
        .deleteBattleWorkspacesExcept(
          isTerminalPhase(snapshot.battle.phase) ? null : battleWorkspaceId(battleId),
        )
        .catch(() => undefined);
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.patch({ stage: 'name', battleId: null, error: toGameError(e) });
      this.deps.onBattleChange?.(null);
    }
  }

  private resetBattleState(): void {
    this.refreshAgain = false;
    this.lastNudge = null;
    this.finalAutosaveDone = false;
    this.shippingAutosaveDone = false;
    this.lastAutosaved = null;
    this.destroyedSeenAt = null;
    this.revealAttempted = false;
  }

  /** Samples `server_now()` three times and keeps the lowest-RTT estimate. */
  private async syncClock(): Promise<void> {
    const offset = await measureClockOffset(
      () => this.api.serverNow(),
      () => this.clock.now(),
    );
    // With no successful sample, the previous offset stays.
    if (offset !== null && !this.disposed) this.patch({ clockOffsetMs: offset });
  }

  /** Fetches the snapshot and reschedules. Concurrent calls coalesce into one more fetch. */
  private refresh(): Promise<void> {
    // Multiplayer: the room sync engine fetches (and coalesces), then calls receive().
    if (this.deps.external) return this.deps.external.refetch().catch(() => undefined);
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const battleId = this.state.battleId;
    if (!battleId || this.disposed) return Promise.resolve();
    const epoch = this.epoch;
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          try {
            const snap = await this.api.getSnapshot(battleId);
            if (epoch !== this.epoch) return;
            this.apply(snap);
          } catch {
            // Transient (network): keep the last snapshot and try again on the next poll.
            if (epoch !== this.epoch) return;
            this.schedule();
          }
        } while (this.wantsRefresh() && epoch === this.epoch);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** A method, so TypeScript does not narrow the flag across awaits. */
  private wantsRefresh(): boolean {
    return this.refreshAgain;
  }

  private apply(snapshot: BattleSnapshot): void {
    const prev = this.state.snapshot;
    if (prev?.battle.id === snapshot.battle.id && snapshot.battle.version < prev.battle.version) {
      this.schedule();
      return; // stale
    }
    const prevPhase = prev?.battle.id === snapshot.battle.id ? prev.battle.phase : null;
    const phase = snapshot.battle.phase;
    this.patch({
      snapshot,
      userId: snapshot.me.user_id,
      sourceDestroyed: snapshot.battle.destroyed_at !== null,
    });

    const mine = myBuild(snapshot);
    const draft = mine?.status === 'draft';
    if (!draft || phase !== 'building') this.clearTimer('autosave');
    const autosaveOpen = draft && (phase === 'building' || phase === 'shipping');
    const saveStatus = this.state.autosave.status;
    // Once the build is final, autosaves are over (an in-flight one settles on its own).
    if (!autosaveOpen && (saveStatus === 'saved' || saveStatus === 'error')) {
      this.patch({ autosave: { ...this.state.autosave, status: 'closed', error: null } });
    }

    // SHIPPING grace with an unshipped build: one last autosave (uploads are still open).
    if (phase === 'shipping' && draft && !this.shippingAutosaveDone) {
      this.shippingAutosaveDone = true;
      void this.autosave({ force: false });
    }
    if (phase === 'building') this.ensureAutosaveLoop();

    // The last look: once per battle, as soon as a snapshot shows the build shipped.
    if (phase === 'results' && !this.revealAttempted && this.state.destroy === 'none') {
      void this.loadReveal();
    }

    if (isTerminalPhase(phase) && this.state.destroy === 'none') {
      this.destroyedSeenAt = this.clock.now();
      const live = prevPhase !== null && !isTerminalPhase(prevPhase);
      this.startDestroy(live);
    }
    this.schedule();
  }

  /** Arms the deadline nudge, the final autosave, polling and clock resync. */
  private schedule(): void {
    for (const name of ['deadline', 'final', 'poll', 'clock'] as const) this.clearTimer(name);
    const snap = this.state.snapshot;
    if (!snap || this.disposed) return;
    const phase = snap.battle.phase;
    const rem = this.remainingMs();
    const now = this.clock.now();

    if (!isTerminalPhase(phase) && rem !== null) {
      const jitter = Math.floor(this.clock.random() * (this.timings.nudgeJitterMs + 1));
      let delay = rem + jitter;
      if (this.lastNudge?.version === snap.battle.version) {
        delay = Math.max(delay, this.lastNudge.at + this.timings.nudgeRetryMs - now);
      }
      this.setTimer('deadline', delay, () => void this.nudge());
    }

    const mine = myBuild(snap);
    if (
      phase === 'building' &&
      mine?.status === 'draft' &&
      rem !== null &&
      !this.finalAutosaveDone
    ) {
      const at = rem - this.timings.finalAutosaveLeadMs;
      const runFinal = () => {
        this.finalAutosaveDone = true;
        void this.autosave({ force: false });
      };
      if (at > 0) this.setTimer('final', at, runFinal);
      else if (rem > 0) runFinal();
    }

    // Multiplayer snapshots come from Realtime events (the engine refetches): no polling.
    let poll = this.deps.external ? null : (this.timings.pollMs[phase] ?? null);
    if (phase === 'destroyed' || phase === 'abandoned') {
      const seen = this.destroyedSeenAt ?? now;
      if (snap.battle.destroyed_at !== null || now - seen > this.timings.destroyedPollLimitMs) {
        poll = null;
      }
    } else if (rem !== null && poll !== null) {
      // Do not sleep through a deadline: wake up right after it, too.
      poll = Math.max(250, Math.min(poll, rem + 250));
    }
    if (poll !== null) this.setTimer('poll', poll, () => void this.refresh());

    if (!isTerminalPhase(phase) && !this.deps.external) {
      this.setTimer('clock', this.timings.clockResyncMs, () => {
        void this.syncClock().then(() => {
          this.schedule();
        });
      });
    }
  }

  private async nudge(): Promise<void> {
    const snap = this.state.snapshot;
    if (!snap || this.disposed) return;
    const epoch = this.epoch;
    this.lastNudge = { version: snap.battle.version, at: this.clock.now() };
    try {
      await this.api.advanceBattle(snap.battle.id, snap.battle.version);
    } catch {
      // A failed nudge is harmless: the next one (or pg_cron) advances the battle.
    }
    if (epoch !== this.epoch) return;
    await this.refresh();
  }

  // --- Autosave -----------------------------------------------------------------------

  private canAutosave(): boolean {
    const snap = this.state.snapshot;
    const mine = myBuild(snap);
    return (
      this.bridge !== null &&
      mine?.status === 'draft' &&
      (snap?.battle.phase === 'building' || snap?.battle.phase === 'shipping')
    );
  }

  private ensureAutosaveLoop(): void {
    if (this.timers.has('autosave') || !this.canAutosave()) return;
    if (this.state.snapshot?.battle.phase !== 'building') return;
    this.setTimer('autosave', this.timings.autosaveIntervalMs, () => {
      void this.autosave().finally(() => {
        this.ensureAutosaveLoop();
      });
    });
  }

  /**
   * Uploads `autosave/source.json`, `autosave/bundle.js` and `autosave/bundle.css` from the
   * last good build. Skipped when nothing changed since the last autosave (unless `force`).
   */
  private autosave(opts: { force?: boolean } = {}): Promise<void> {
    if (this.autosaving) {
      return this.autosaving.then(() => this.autosave(opts));
    }
    const snap = this.state.snapshot;
    const bridge = this.bridge;
    if (!snap || !bridge || !this.canAutosave()) return Promise.resolve();
    const build = bridge.lastGoodBuild();
    const workspace = bridge.workspace();
    if (!build || !workspace) return Promise.resolve();
    const last = this.lastAutosaved;
    if (!opts.force && last?.build === build && last.workspace === workspace) {
      return Promise.resolve();
    }
    const battleId = snap.battle.id;
    const userId = snap.me.user_id;
    const epoch = this.epoch;
    this.patch({ autosave: { ...this.state.autosave, status: 'saving', error: null } });
    const files: [BuildFile, string][] = [
      ['autosave/bundle.js', build.js],
      ['autosave/bundle.css', build.css],
      ['autosave/source.json', sourceJson(workspace)],
    ];
    this.autosaving = (async () => {
      try {
        await Promise.all(files.map(([f, body]) => this.api.upload(battleId, userId, f, body)));
        if (epoch !== this.epoch) return;
        this.lastAutosaved = { build, workspace };
        this.patch({
          autosave: { status: 'saved', lastSavedAt: this.clock.now(), error: null },
        });
      } catch (e) {
        if (epoch !== this.epoch) return;
        const err = toGameError(e);
        // After the deadline + grace the bucket refuses writes: expected, not an error.
        const closed =
          err.code === 'upload_refused' &&
          (this.remainingMs() === 0 || this.state.snapshot?.battle.phase !== 'building');
        this.patch({
          autosave: {
            status: closed ? 'closed' : 'error',
            lastSavedAt: this.state.autosave.lastSavedAt,
            error: closed ? null : err,
          },
        });
      } finally {
        this.autosaving = null;
      }
    })();
    return this.autosaving;
  }

  // --- Ship helpers -------------------------------------------------------------------

  private async shipWithStats(battleId: string, name: string, stats: BuildStats): Promise<void> {
    try {
      await this.api.shipBuild(battleId, name, stats);
    } catch (e) {
      const err = toGameError(e);
      // Stats are display-only: never let them block a ship.
      if (err.code === 'invalid_stats' || err.code === 'stats_too_large') {
        await this.api.shipBuild(battleId, name, {});
        return;
      }
      throw err;
    }
  }

  // --- Results and destroy ------------------------------------------------------------

  /** Fetches the shipped (or auto-shipped) bundle back for the last-look preview. */
  private async loadReveal(): Promise<void> {
    const snap = this.state.snapshot;
    const mine = myBuild(snap);
    if (!snap || !mine || (mine.status !== 'shipped' && mine.status !== 'auto_shipped')) {
      // Not final yet in this snapshot (a room's `phase` event arrives before the refetch
      // that brings auto_shipped), or a DNF: a later snapshot may still change it.
      if (this.state.reveal.status !== 'unavailable') {
        this.patch({ reveal: { status: 'unavailable', build: null } });
      }
      return;
    }
    this.revealAttempted = true;
    const epoch = this.epoch;
    this.patch({ reveal: { status: 'loading', build: null } });
    const prefix = mine.status === 'shipped' ? '' : 'autosave/';
    const file = (name: 'bundle.js' | 'bundle.css' | 'source.json') =>
      this.api.download(snap.battle.id, snap.me.user_id, `${prefix}${name}` as BuildFile);
    try {
      const [js, css, source] = await Promise.all([
        file('bundle.js'),
        file('bundle.css'),
        file('source.json'),
      ]);
      if (epoch !== this.epoch || this.state.destroy !== 'none') return;
      if (!js) {
        this.patch({ reveal: { status: 'unavailable', build: null } });
        return;
      }
      let deps: Record<string, string> = {};
      try {
        const parsed = JSON.parse(source ?? '{}') as {
          manifest?: { dependencies?: Record<string, string> };
        };
        deps = parsed.manifest?.dependencies ?? {};
      } catch {
        // An unreadable manifest: React from nowhere; the preview shows the load error.
      }
      this.patch({
        reveal: {
          status: 'ready',
          build: { js, css: css ?? '', importMap: buildImportMap(deps, this.deps.cdnBaseUrl) },
        },
      });
    } catch {
      if (epoch !== this.epoch) return;
      this.patch({ reveal: { status: 'unavailable', build: null } });
    }
  }

  /**
   * DESTROY: `live` plays the destroy moment first (the phase changed while watching);
   * otherwise (opened an already destroyed battle) the local copies go at once.
   */
  private startDestroy(live: boolean): void {
    this.clearTimer('autosave');
    this.clearTimer('final');
    const battleId = this.state.battleId;
    const wipe = () => {
      this.patch({ destroy: 'done', reveal: { status: 'destroyed', build: null } });
      if (battleId) {
        void this.deps.localWorkspaces.delete(battleWorkspaceId(battleId)).catch(() => undefined);
      }
    };
    if (!live) {
      wipe();
      return;
    }
    this.patch({ destroy: 'animating' });
    this.setTimer('destroy', this.timings.destroyAnimationMs, wipe);
  }

  // --- Plumbing -----------------------------------------------------------------------

  private setTimer(name: TimerName, ms: number, fn: () => void): void {
    this.clearTimer(name);
    if (this.disposed) return;
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

  private clearAllTimers(): void {
    for (const h of this.timers.values()) this.clock.clearTimeout(h);
    this.timers.clear();
  }

  private patch(p: Partial<SoloState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...p };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
