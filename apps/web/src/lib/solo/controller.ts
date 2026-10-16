/**
 * The solo game loop on the client (docs/04): SPIN → BUILD → SHIP → RESULTS → DESTROY.
 *
 * Postgres decides every state; this controller only renders it and sends intents:
 * - **Sync:** it polls `get_battle_snapshot` (no Realtime in M2), faster when something is
 *   about to change, and on `visibilitychange`.
 * - **Time:** `server_now()` sampled three times (lowest RTT wins) on open and on
 *   `visibilitychange`, then one sample every 60 s, ignored when its round trip is much
 *   slower (clock-sync.ts); countdowns are `remainingMs(phase_ends_at, Date.now(), offset)`
 *   (docs/04 §4.5).
 * - **Deadlines:** when a countdown reaches 0 it calls `advance_battle(id, version)` after a
 *   random 0–500 ms jitter (compare-and-set; pg_cron is the backstop). A battle that does
 *   not move is nudged again after 5, 10, 20, then every 30 s (T-029), starting over when
 *   its version moves. RESULTS is only nudged once no final build waits for its screenshot:
 *   nothing a client does makes a screenshot faster, and the 5 s sweep ends RESULTS as soon
 *   as the last one lands or the capture deadline passes (docs/07 §7.5.7: every client
 *   nudging every 5 s was 41 % of all requests under a capture backlog).
 * - **Import (docs/09):** the player builds locally and imports the built site; the BUILD
 *   screen hands every good import to `importSite()`. The latest import is the build: it is
 *   kept in IndexedDB on the app origin (`battle:{id}`, local-sites.ts) and uploaded as
 *   `autosave/site.bin` (upsert) at once, so the deadline auto-ships it. A failed upload is
 *   retried after 5, 10, 20, then every 30 s; it is tried again 3 s before the deadline,
 *   during the SHIPPING grace and when the tab is hidden.
 * - **Restore:** a battle opened during BUILD (a reload, another device) gets its last import
 *   back: from IndexedDB, else from the remote `autosave/site.bin`.
 * - **Ship:** thumbnail of the live preview (best effort) → upload `site.bin` (the imported
 *   pack) and `thumb.webp` → `ship_build` with stats `{files, bundle_bytes, imports}`.
 * - **Results:** the shipped site pack is fetched back from storage for the "last look"
 *   preview (reveal mode) until DESTROY.
 * - **Destroy:** when the phase becomes `destroyed`, a short animation, then the battle's
 *   IndexedDB site is deleted and the reveal preview is dropped.
 *
 * Plain TypeScript with injected API, clock and storage, like PreviewController, so it can
 * be unit tested with fakes and fake timers. React reads it with useSyncExternalStore.
 *
 * **Multiplayer (T-017):** the same controller runs one battle of a room in *external* mode
 * (`deps.external`, `openExternal`): the room's sync engine (src/lib/room/sync.ts) owns the
 * battle snapshot (Realtime events + refetches) and the server clock, and pushes them in with
 * `receive()` and `setClockOffset()`. The controller then neither polls nor samples the
 * clock; everything else (deadline nudges, autosave, ship, last look, destroy) is shared.
 *
 * **Telemetry (T-030):** `battle_started` (solo), `build_shipped` (manual on a successful
 * ship; auto when a snapshot shows this player's draft turned auto-shipped), and
 * `battle_completed` when the battle reaches RESULTS (or is abandoned) while this client
 * watches; the battle and its phase tag error reports (context.ts). No-ops while telemetry
 * is off.
 */
import { isTerminalPhase, remainingMs } from '@br/game';
import type { PreviewBuild } from '@br/runtime';
import { battleSiteKey, type LocalSites } from '../site/local-sites';
import { siteFromPack, type ImportedSite } from '../site/site';
import { pruneBattleSites } from '../site/site-cleanup';
import { track as defaultTrack, type BattleMode, type Track } from '../telemetry/analytics';
import { setTelemetryContext } from '../telemetry/context';
import type { SoloApi } from './api';
import { ServerClock } from './clock-sync';
import { GameError, toGameError } from './errors';
import { siteStats } from './stats';
import type { BattleSnapshot, BuildStats, ShipResult, SnapshotBuild } from './types';

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

export type { LocalSites } from '../site/local-sites';

/** What the BUILD screen's live preview offers while it is mounted. */
export interface PreviewBridge {
  /** Best-effort thumbnail of the live preview (WebP), or null. */
  thumbnail(size: { width: number; height: number }): Promise<Blob | null>;
}

export interface SoloTimings {
  /**
   * A failed autosave upload is tried again after these delays (the last one repeats), until
   * it lands or the build is final.
   */
  autosaveRetryMs: readonly number[];
  /** The final autosave runs this long before the build deadline. */
  finalAutosaveLeadMs: number;
  nudgeJitterMs: number;
  /**
   * A battle that did not move after a nudge is nudged again after these delays (the last
   * one repeats), counted from the previous nudge; a new version starts over.
   */
  nudgeBackoffMs: readonly number[];
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
  autosaveRetryMs: [5_000, 10_000, 20_000, 30_000],
  finalAutosaveLeadMs: 3_000,
  nudgeJitterMs: 500,
  nudgeBackoffMs: [5_000, 10_000, 20_000, 30_000],
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
  /** The latest import of each battle on this device (IndexedDB). */
  localSites: LocalSites;
  clock?: SoloClock;
  timings?: Partial<SoloTimings>;
  /** Called when the open battle changes (to keep `?battle=` in the URL). */
  onBattleChange?: (battleId: string | null) => void;
  /** Product analytics (default: analytics.ts; tests pass a spy). */
  track?: Track;
}

// ─── State ────────────────────────────────────────────────────────────────────────────

export type Stage = 'name' | 'starting' | 'resume' | 'loading' | 'battle';

export type ShipStatus = 'idle' | 'thumbnail' | 'uploading' | 'shipping' | 'done' | 'error';

export interface ShipState {
  status: ShipStatus;
  error: GameError | null;
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
  /** The site the player imported last in this battle (what ships), or null. */
  site: ImportedSite | null;
  /** Successful imports in this battle (the `imports` stat). */
  imports: number;
  /** Looking for an earlier import to bring back (IndexedDB, then the remote autosave). */
  restoring: boolean;
}

export const INITIAL_SOLO_STATE: SoloState = {
  stage: 'name',
  userId: null,
  battleId: null,
  resumeBattleId: null,
  snapshot: null,
  clockOffsetMs: 0,
  error: null,
  ship: { status: 'idle', error: null },
  autosave: { status: 'idle', lastSavedAt: null, error: null },
  reveal: { status: 'none', build: null },
  destroy: 'none',
  sourceDestroyed: false,
  site: null,
  imports: 0,
  restoring: false,
};

/** The caller's build in a snapshot. */
export function myBuild(snapshot: BattleSnapshot | null): SnapshotBuild | null {
  if (!snapshot) return null;
  return snapshot.builds.find((b) => b.builder_id === snapshot.me.user_id) ?? null;
}

function battleMode(snapshot: BattleSnapshot): BattleMode {
  return snapshot.battle.mode === 'solo' ? 'solo' : 'multiplayer';
}

/** Phases after which a battle counts as completed for `battle_completed`. */
const COMPLETED_PHASES = new Set(['results', 'destroyed', 'abandoned']);

// ─── Controller ───────────────────────────────────────────────────────────────────────

type TimerName = 'deadline' | 'final' | 'poll' | 'autosave' | 'clock' | 'destroy';

/** The battle phases in which a player's build can still change or be saved. */
const OPEN_PHASES = new Set(['building', 'shipping']);

export class SoloController {
  private state: SoloState = INITIAL_SOLO_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly api: SoloApi;
  private readonly clock: SoloClock;
  private readonly timings: SoloTimings;
  private readonly deps: SoloControllerDeps;
  private readonly track: Track;
  private readonly timers = new Map<TimerName, TimerHandle>();
  private bridge: PreviewBridge | null = null;
  private disposed = false;
  /** Bumped whenever the open battle changes; async work from an older epoch is dropped. */
  private epoch = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** The last nudge: at which version, when, and how many in a row at that version. */
  private lastNudge: { version: number; at: number; count: number } | null = null;
  private readonly serverClock: ServerClock;
  private finalAutosaveDone = false;
  private shippingAutosaveDone = false;
  private autosaving: Promise<void> | null = null;
  /** The import that is in `autosave/site.bin` on the server (by identity). */
  private lastAutosaved: ImportedSite | null = null;
  /** Failed autosave uploads in a row (the retry backoff). */
  private autosaveFailures = 0;
  /** The battle's earlier import was looked for (once per battle). */
  private restoreAttempted = false;
  private destroyedSeenAt: number | null = null;
  /** The last-look site was requested (it is fetched once per battle). */
  private revealAttempted = false;

  constructor(deps: SoloControllerDeps) {
    this.deps = deps;
    this.api = deps.api;
    this.clock = deps.clock ?? realClock;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.track = deps.track ?? defaultTrack;
    this.serverClock = new ServerClock(
      () => this.api.serverNow(),
      () => this.clock.now(),
    );
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
      this.track('battle_started', {
        battle_id: battleId,
        mode: 'solo',
        room_id: null,
        rematch: false,
      });
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
    setTelemetryContext({ battleId: null, phase: null, mode: null });
  }

  /** The BUILD screen attaches its live preview while mounted (the ship thumbnail). */
  attachPreview(bridge: PreviewBridge): () => void {
    this.bridge = bridge;
    return () => {
      if (this.bridge === bridge) this.bridge = null;
    };
  }

  /** The tab was hidden: make sure the latest import is saved (docs/03 §3.6). */
  onHidden(): void {
    if (this.canAutosave()) void this.autosave();
  }

  /** The tab is visible again: resync (timers may have been throttled). */
  onVisible(): void {
    // In external mode the room sync engine resyncs on visibility itself.
    if (this.state.stage !== 'battle' || this.disposed || this.deps.external) return;
    void this.syncClock('measure').then(() => this.refresh());
  }

  /** Uploads the latest import now, even if it was saved already (tests). */
  autosaveNow(): Promise<void> {
    return this.autosave({ force: true });
  }

  /**
   * Whether an import is taken now: BUILDING before the deadline, a draft, and no ship in
   * flight. (The BUILD screen locks its drop zone on the same rule.)
   */
  canImport(): boolean {
    const snap = this.state.snapshot;
    const ship = this.state.ship.status;
    const rem = this.remainingMs();
    return (
      snap?.battle.phase === 'building' &&
      myBuild(snap)?.status === 'draft' &&
      (rem === null || rem > 0) &&
      (ship === 'idle' || ship === 'error')
    );
  }

  /**
   * A good import (docs/09 §9.5): it becomes the build. It is kept on this device and
   * uploaded as `autosave/site.bin` at once (retried until it lands). Returns false when
   * imports are closed (see `canImport`).
   */
  importSite(site: ImportedSite): boolean {
    const snap = this.state.snapshot;
    if (!snap || this.disposed || !this.canImport()) return false;
    const imports = this.state.imports + 1;
    this.patch({ site, imports, restoring: false });
    void this.deps.localSites
      .put(battleSiteKey(snap.battle.id), { site, imports })
      .catch(() => undefined); // blocked storage: the remote autosave still has it
    this.autosaveFailures = 0;
    this.clearTimer('autosave');
    void this.autosave();
    return true;
  }

  /**
   * Ships the latest import: a thumbnail of the live preview (best effort), then `site.bin`
   * and `thumb.webp` are uploaded and `ship_build` is called with the stats.
   */
  async ship(name: string): Promise<void> {
    const snap = this.state.snapshot;
    const status = this.state.ship.status;
    if (!snap || (status !== 'idle' && status !== 'error')) return;
    const battleId = snap.battle.id;
    const userId = snap.me.user_id;
    const epoch = this.epoch;
    const fail = (e: unknown) => {
      if (epoch !== this.epoch) return;
      this.patch({ ship: { status: 'error', error: toGameError(e) } });
    };
    const site = this.state.site;
    if (!site) {
      fail(new GameError('nothing_built'));
      return;
    }
    const imports = this.state.imports;

    // 1. Thumbnail of what the live preview shows now.
    this.patch({ ship: { status: 'thumbnail', error: null } });
    const thumb = this.bridge
      ? await this.bridge.thumbnail(this.timings.thumbnailSize).catch(() => null)
      : null;
    if (epoch !== this.epoch) return;

    // 2. Uploads (upsert, so a retry after a partial failure works).
    this.patch({ ship: { status: 'uploading', error: null } });
    try {
      const uploads: Promise<void>[] = [this.api.upload(battleId, userId, 'site.bin', site.pack)];
      if (thumb) uploads.push(this.api.upload(battleId, userId, 'thumb.webp', thumb));
      await Promise.all(uploads);
    } catch (e) {
      fail(e);
      return;
    }
    if (epoch !== this.epoch) return;

    // 3. ship_build.
    this.patch({ ship: { status: 'shipping', error: null } });
    try {
      const shipped = await this.shipWithStats(battleId, name.trim(), siteStats(site, imports));
      this.track('build_shipped', {
        battle_id: battleId,
        mode: battleMode(snap),
        how: 'manual',
        completion_ms: shipped.build.completion_ms,
      });
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
    this.patch({ ship: { status: 'done', error: null } });
    await this.refresh();
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
    void this.pruneLocalSites(snapshot);
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
      site: null,
      imports: 0,
      restoring: false,
    });
    try {
      const userId = await this.api.ensureSession();
      if (epoch !== this.epoch) return;
      this.patch({ userId });
      await this.syncClock('measure');
      const snapshot = await this.api.getSnapshot(battleId);
      if (epoch !== this.epoch) return;
      this.patch({ stage: 'battle' });
      this.deps.onBattleChange?.(battleId);
      this.apply(snapshot);
      void this.pruneLocalSites(snapshot);
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.patch({ stage: 'name', battleId: null, error: toGameError(e) });
      this.deps.onBattleChange?.(null);
    }
  }

  /**
   * Deletes the stale copies of other battles (site-cleanup.ts): only battles that are over
   * or untouched for 24 h, never one that another tab is still playing.
   */
  private pruneLocalSites(snapshot: BattleSnapshot): Promise<string[]> {
    const local = this.deps.localSites;
    return pruneBattleSites(
      {
        list: () => local.listBattleSites(),
        delete: (id) => local.delete(id),
        battlePhases: (ids) => this.api.battlePhases(ids),
        now: () => this.clock.now(),
      },
      isTerminalPhase(snapshot.battle.phase) ? null : battleSiteKey(snapshot.battle.id),
    );
  }

  private resetBattleState(): void {
    this.refreshAgain = false;
    this.lastNudge = null;
    this.finalAutosaveDone = false;
    this.shippingAutosaveDone = false;
    this.lastAutosaved = null;
    this.autosaveFailures = 0;
    this.restoreAttempted = false;
    this.destroyedSeenAt = null;
    this.revealAttempted = false;
  }

  /**
   * `measure`: three `server_now()` samples, the lowest RTT wins; `resync`: one sample, used
   * only when its RTT is about as good as the current estimate's (clock-sync.ts).
   */
  private async syncClock(kind: 'measure' | 'resync'): Promise<void> {
    const offset =
      kind === 'measure' ? await this.serverClock.measure() : await this.serverClock.resync();
    // With no (usable) sample, the previous offset stays.
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
    this.trackTransitions(prev, snapshot);
    setTelemetryContext({
      battleId: snapshot.battle.id,
      phase,
      mode: battleMode(snapshot),
    });
    this.patch({
      snapshot,
      userId: snapshot.me.user_id,
      sourceDestroyed: snapshot.battle.destroyed_at !== null,
    });

    const mine = myBuild(snapshot);
    const draft = mine?.status === 'draft';
    const autosaveOpen = draft && OPEN_PHASES.has(phase);
    if (!autosaveOpen) this.clearTimer('autosave');
    const saveStatus = this.state.autosave.status;
    // Once the build is final, autosaves are over (an in-flight one settles on its own).
    if (!autosaveOpen && (saveStatus === 'saved' || saveStatus === 'error')) {
      this.patch({ autosave: { ...this.state.autosave, status: 'closed', error: null } });
    }

    // A battle opened during BUILD (a reload, another device): bring the last import back.
    if (
      !this.restoreAttempted &&
      OPEN_PHASES.has(phase) &&
      (mine?.status === 'draft' || mine?.status === 'shipped')
    ) {
      this.restoreAttempted = true;
      void this.restoreSite(snapshot);
    }

    // SHIPPING grace with an unshipped build: one last try if the import is not saved yet
    // (uploads are still open).
    if (phase === 'shipping' && draft && !this.shippingAutosaveDone) {
      this.shippingAutosaveDone = true;
      void this.autosave({ force: false });
    }

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
    for (const name of ['deadline', 'final', 'poll'] as const) this.clearTimer(name);
    const snap = this.state.snapshot;
    if (!snap || this.disposed) {
      this.clearTimer('clock');
      return;
    }
    const phase = snap.battle.phase;
    const rem = this.remainingMs();
    const now = this.clock.now();

    if (!isTerminalPhase(phase) && rem !== null && this.mayNudge(snap)) {
      const jitter = Math.floor(this.clock.random() * (this.timings.nudgeJitterMs + 1));
      let delay = rem + jitter;
      const last = this.lastNudge?.version === snap.battle.version ? this.lastNudge : null;
      if (last) {
        // Did not move since the last nudge: back off (5, 10, 20, 30 s…).
        const steps = this.timings.nudgeBackoffMs;
        const wait = steps[Math.min(last.count, steps.length) - 1] ?? 0;
        delay = Math.max(delay, last.at + wait - now);
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
    } else if (rem !== null && rem > 0 && poll !== null) {
      // Do not sleep through a deadline: wake up right after it, too. (Once it has passed,
      // the phase's own interval: RESULTS waiting for its screenshot polled every 250 ms.)
      poll = Math.max(250, Math.min(poll, rem + 250));
    }
    if (poll !== null) this.setTimer('poll', poll, () => void this.refresh());

    // The clock resync keeps its own 60 s rhythm: re-arming it on every snapshot (each poll)
    // meant it never fired while the battle was polled more often than once a minute.
    if (isTerminalPhase(phase) || this.deps.external) {
      this.clearTimer('clock');
    } else if (!this.timers.has('clock')) {
      this.setTimer('clock', this.timings.clockResyncMs, () => {
        void this.syncClock('resync').then(() => {
          this.schedule();
        });
      });
    }
  }

  /**
   * RESULTS waits for the screenshots after its deadline (docs/04): while a final build's
   * capture is pending, a nudge cannot move it, so none is sent; the sweep ends RESULTS, and
   * a `capture` event (or the next snapshot) re-arms the nudge once the last one is in.
   */
  private mayNudge(snap: BattleSnapshot): boolean {
    if (snap.battle.phase !== 'results') return true;
    return !snap.builds.some(
      (b) =>
        (b.status === 'shipped' || b.status === 'auto_shipped') && b.capture_status === 'pending',
    );
  }

  private async nudge(): Promise<void> {
    const snap = this.state.snapshot;
    if (!snap || this.disposed) return;
    const epoch = this.epoch;
    const version = snap.battle.version;
    const count = this.lastNudge?.version === version ? this.lastNudge.count + 1 : 1;
    this.lastNudge = { version, at: this.clock.now(), count };
    try {
      await this.api.advanceBattle(snap.battle.id, snap.battle.version);
    } catch {
      // A failed nudge is harmless: the next one (or pg_cron) advances the battle.
    }
    if (epoch !== this.epoch) return;
    await this.refresh();
  }

  // --- Autosave and restore -----------------------------------------------------------

  private canAutosave(): boolean {
    const snap = this.state.snapshot;
    const mine = myBuild(snap);
    return (
      mine?.status === 'draft' &&
      (snap?.battle.phase === 'building' || snap?.battle.phase === 'shipping')
    );
  }

  /**
   * Uploads the latest import as `autosave/site.bin` (upsert), unless it is there already
   * (`force` uploads anyway). A failure is retried after `autosaveRetryMs` (5, 10, 20, then
   * every 30 s) while the build is open; one refused after the deadline closes autosave.
   */
  private autosave(opts: { force?: boolean } = {}): Promise<void> {
    if (this.autosaving) {
      return this.autosaving.then(() => this.autosave(opts));
    }
    const snap = this.state.snapshot;
    const site = this.state.site;
    if (!snap || !site || !this.canAutosave()) return Promise.resolve();
    if (!opts.force && this.lastAutosaved === site) return Promise.resolve();
    const battleId = snap.battle.id;
    const userId = snap.me.user_id;
    const epoch = this.epoch;
    this.clearTimer('autosave');
    this.patch({ autosave: { ...this.state.autosave, status: 'saving', error: null } });
    this.autosaving = (async () => {
      try {
        await this.api.upload(battleId, userId, 'autosave/site.bin', site.pack);
        if (epoch !== this.epoch) return;
        this.lastAutosaved = site;
        this.autosaveFailures = 0;
        // A newer import that arrived meanwhile is uploaded by the chained call.
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
        if (!closed) this.scheduleAutosaveRetry();
      } finally {
        this.autosaving = null;
      }
    })();
    return this.autosaving;
  }

  private scheduleAutosaveRetry(): void {
    if (!this.canAutosave()) return;
    const steps = this.timings.autosaveRetryMs;
    const wait = steps[Math.min(this.autosaveFailures, steps.length - 1)] ?? 30_000;
    this.autosaveFailures++;
    this.setTimer('autosave', wait, () => {
      void this.autosave();
    });
  }

  /**
   * The battle's last import on this device (IndexedDB), else the remote autosave
   * (`autosave/site.bin`, or the shipped `site.bin`). One from this device is uploaded again,
   * as nothing says it reached the server. An import made meanwhile wins.
   */
  private async restoreSite(snapshot: BattleSnapshot): Promise<void> {
    const battleId = snapshot.battle.id;
    const userId = snapshot.me.user_id;
    const shipped = myBuild(snapshot)?.status === 'shipped';
    const epoch = this.epoch;
    const stillWanted = () => epoch === this.epoch && !this.disposed && this.state.site === null;
    this.patch({ restoring: true });
    try {
      const local = await this.deps.localSites.get(battleSiteKey(battleId)).catch(() => null);
      if (!stillWanted()) return;
      if (local) {
        this.patch({ site: local.site, imports: Math.max(this.state.imports, local.imports) });
        if (!shipped) void this.autosave();
        return;
      }
      const file = shipped ? 'site.bin' : 'autosave/site.bin';
      const pack = await this.api.download(battleId, userId, file).catch(() => null);
      if (!stillWanted() || !pack) return;
      const site = siteFromPack(pack);
      if (!site) return;
      // It is on the server already. How many imports made it is not known: at least one.
      if (!shipped) this.lastAutosaved = site;
      const imports = Math.max(this.state.imports, 1);
      this.patch({ site, imports });
      if (!shipped) {
        this.patch({
          autosave: { status: 'saved', lastSavedAt: this.state.autosave.lastSavedAt, error: null },
        });
      }
      void this.deps.localSites
        .put(battleSiteKey(battleId), { site, imports })
        .catch(() => undefined);
    } finally {
      if (epoch === this.epoch) this.patch({ restoring: false });
    }
  }

  // --- Ship helpers -------------------------------------------------------------------

  private async shipWithStats(
    battleId: string,
    name: string,
    stats: BuildStats,
  ): Promise<ShipResult> {
    try {
      return await this.api.shipBuild(battleId, name, stats);
    } catch (e) {
      const err = toGameError(e);
      // Stats are display-only: never let them block a ship.
      if (err.code === 'invalid_stats' || err.code === 'stats_too_large') {
        return this.api.shipBuild(battleId, name, {});
      }
      throw err;
    }
  }

  /**
   * Analytics from a new snapshot of the same battle (T-030): an auto-ship of this player's
   * draft, and the battle completing while this client watched it. Only for changes seen
   * live, so a reload or a late open does not count them again.
   */
  private trackTransitions(prev: BattleSnapshot | null, next: BattleSnapshot): void {
    if (prev?.battle.id !== next.battle.id) return;
    const mode = battleMode(next);
    const was = myBuild(prev);
    const mine = myBuild(next);
    if (was?.status === 'draft' && mine?.status === 'auto_shipped') {
      this.track('build_shipped', {
        battle_id: next.battle.id,
        mode,
        how: 'auto',
        completion_ms: mine.completion_ms,
      });
    }
    if (!COMPLETED_PHASES.has(prev.battle.phase) && COMPLETED_PHASES.has(next.battle.phase)) {
      const status = mine?.status;
      this.track('battle_completed', {
        battle_id: next.battle.id,
        mode,
        role: next.me.role ?? (next.me.is_player ? 'player' : 'viewer'),
        outcome: next.battle.phase === 'abandoned' ? 'abandoned' : 'results',
        build:
          status === 'shipped'
            ? 'manual'
            : status === 'auto_shipped'
              ? 'auto'
              : status === 'dnf' || status === 'disqualified'
                ? status
                : 'none',
        rank: mine?.final_rank ?? null,
        builds: next.builds.filter((b) => b.status === 'shipped' || b.status === 'auto_shipped')
          .length,
      });
    }
  }

  // --- Results and destroy ------------------------------------------------------------

  /** Fetches the shipped (or auto-shipped) site pack back for the last-look preview. */
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
    const file = mine.status === 'shipped' ? 'site.bin' : 'autosave/site.bin';
    try {
      const pack = await this.api.download(snap.battle.id, snap.me.user_id, file);
      if (epoch !== this.epoch || this.state.destroy !== 'none') return;
      this.patch({
        reveal: pack
          ? { status: 'ready', build: { site: pack } }
          : { status: 'unavailable', build: null },
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
      this.patch({ destroy: 'done', reveal: { status: 'destroyed', build: null }, site: null });
      if (battleId) {
        void this.deps.localSites.delete(battleSiteKey(battleId)).catch(() => undefined);
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
