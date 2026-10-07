/**
 * REVEAL and VOTING of a room battle on the client (docs/04 §4.11, supabase/README.md
 * "Reveal and voting"), as plain TypeScript next to the battle's SoloController, so it can
 * be unit tested with fakes:
 *
 * - **Reveal builds:** `get_reveal_builds` once the battle is in REVEAL, VOTING or RESULTS
 *   (the object names of every final build, in reveal order). Retried while it fails.
 * - **Spotlight:** the snapshot's `reveal_index` (advanced by `phase` events) picks the
 *   build. Its `bundle.js`, `bundle.css` and `manifest.json` are downloaded from Storage and
 *   turned into a validated preview input (reveal-files.ts); the **next** build's files are
 *   prefetched during the current slot, so a switch is instant. The React side runs exactly
 *   one live preview (reveal mode, storage wiped first) for the spotlighted build.
 * - **Thumbnails:** `thumb.webp` of each build (shipped by hand only) as an object URL, for
 *   the strip and the VOTE grid. Revoked when the battle ends or the controller goes.
 * - **Skip / frozen:** a viewer can skip the spotlighted build (or the watchdog finds it
 *   frozen): only this tab stops running it and shows its thumbnail instead. The room goes
 *   on; nothing is sent to the server.
 * - **Host controls:** `reveal_next` / `skip_to_vote` with the snapshot's version as the
 *   compare-and-set. A stale call (`changed: false`) or one the server refuses because the
 *   moment passed (`not_host` after a host change, `wrong_phase`, `invalid_version`) is a
 *   quiet no-op plus a refetch: the realtime events tell everyone what really happened.
 * - **Ballot:** `get_my_votes` restores the caller's own choices (after a refresh too);
 *   `cast_vote` per category, revotes allowed, one request at a time per category (the
 *   latest click wins). Every refusal is kept per category for the UI.
 * - **Memory:** bundles are dropped once REVEAL is over; everything at DESTROY.
 *
 * The snapshot comes from the room's sync engine through `receive()`.
 */
import { isTerminalPhase } from '@br/game';
import type { PreviewBuild } from '@br/runtime';
import { realClock, type SoloClock, type TimerHandle } from '../solo/controller';
import { toGameError, type GameError } from '../solo/errors';
import type {
  BattleSnapshot,
  CastVoteResult,
  HostRevealResult,
  MyVotes,
  RevealBuild,
} from '../solo/types';
import { revealPreviewBuild } from './reveal-files';

// ─── Ports ────────────────────────────────────────────────────────────────────────────

export interface RevealVoteApi {
  getRevealBuilds(battleId: string): Promise<RevealBuild[]>;
  /** An object of `ephemeral-builds` as text, or null when it does not exist. */
  downloadText(path: string): Promise<string | null>;
  /** An object of `ephemeral-builds` as a Blob, or null when it does not exist. */
  downloadBlob(path: string): Promise<Blob | null>;
  revealNext(battleId: string, expectedVersion: number): Promise<HostRevealResult>;
  skipToVote(battleId: string, expectedVersion: number): Promise<HostRevealResult>;
  castVote(battleId: string, category: string, buildId: string): Promise<CastVoteResult>;
  getMyVotes(battleId: string): Promise<MyVotes>;
}

/** `URL.createObjectURL` / `revokeObjectURL` (injected for tests). */
export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export const browserObjectUrls: ObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => {
    URL.revokeObjectURL(url);
  },
};

export interface RevealVoteDeps {
  api: RevealVoteApi;
  cdnBaseUrl: string;
  /** Asks the room's sync engine for a fresh battle snapshot. */
  refetch(): Promise<void>;
  objectUrls?: ObjectUrls;
  clock?: SoloClock;
  /** Retry delay for `get_reveal_builds` and the ballot after a failure. */
  retryMs?: number;
}

// ─── State ────────────────────────────────────────────────────────────────────────────

export type BundleState =
  | { status: 'loading'; build: null }
  | { status: 'ready'; build: PreviewBuild }
  /** The build has no bundle in Storage (it should not happen for a final build). */
  | { status: 'missing'; build: null }
  | { status: 'error'; build: null; error: GameError };

export interface BallotState {
  /** category → build id: the caller's choices the server confirmed. */
  votes: Readonly<Record<string, string>>;
  /** Every active category has a confirmed vote. */
  complete: boolean;
  /** `get_my_votes` answered (the ballot is restored). */
  loaded: boolean;
  /** category → build id being sent. */
  pending: Readonly<Record<string, string>>;
  /** category → why the last vote in it was refused. */
  errors: Readonly<Record<string, GameError>>;
}

export interface RevealVoteState {
  battleId: string;
  /** `get_reveal_builds`, in reveal order (null until it answers). */
  builds: readonly RevealBuild[] | null;
  buildsError: GameError | null;
  /** By build id. Only the spotlighted and the next build are kept during REVEAL. */
  bundles: Readonly<Record<string, BundleState>>;
  /** By build id: an object URL of `thumb.webp`, or null when the build has none. */
  thumbs: Readonly<Record<string, string | null>>;
  /** Build ids this viewer chose not to run (local only). */
  skipped: readonly string[];
  /** Build ids whose preview froze in this tab (the watchdog fired). */
  frozen: readonly string[];
  host: { pending: 'next' | 'skip' | null; error: GameError | null };
  ballot: BallotState;
}

export function initialRevealVoteState(battleId: string): RevealVoteState {
  return {
    battleId,
    builds: null,
    buildsError: null,
    bundles: {},
    thumbs: {},
    skipped: [],
    frozen: [],
    host: { pending: null, error: null },
    ballot: { votes: {}, complete: false, loaded: false, pending: {}, errors: {} },
  };
}

/** The build at `reveal_index`, from the reveal list, or null. */
export function spotlightBuild(
  snapshot: BattleSnapshot | null,
  builds: readonly RevealBuild[] | null,
): RevealBuild | null {
  const index = snapshot?.battle.reveal_index;
  if (!builds || typeof index !== 'number') return null;
  const id = snapshot?.battle.reveal_order?.[index];
  return builds.find((b) => b.build_id === id) ?? builds.find((b) => b.position === index) ?? null;
}

/** Host errors that only mean "that moment passed": no message, just catch up. */
const QUIET_HOST_ERRORS = new Set(['not_host', 'wrong_phase', 'invalid_version']);
/** Vote errors after which the snapshot is surely stale. */
const STALE_VOTE_ERRORS = new Set(['wrong_phase', 'deadline_passed', 'not_a_member', 'kicked']);

const REVEALED_PHASES = new Set(['reveal', 'voting', 'results']);

// ─── Controller ───────────────────────────────────────────────────────────────────────

export class RevealVoteController {
  private state: RevealVoteState;
  private snapshot: BattleSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly api: RevealVoteApi;
  private readonly urls: ObjectUrls;
  private readonly clock: SoloClock;
  private readonly retryMs: number;
  private disposed = false;
  private buildsLoading = false;
  private ballotLoading = false;
  private thumbsStarted = false;
  private retryTimer: TimerHandle | null = null;
  /** Bundle downloads in flight, by build id. */
  private readonly bundleLoads = new Set<string>();
  /** category → the choice to send once the request in flight settles. */
  private readonly queued = new Map<string, string>();

  constructor(
    battleId: string,
    private readonly deps: RevealVoteDeps,
  ) {
    this.api = deps.api;
    this.urls = deps.objectUrls ?? browserObjectUrls;
    this.clock = deps.clock ?? realClock;
    this.retryMs = deps.retryMs ?? 2_000;
    this.state = initialRevealVoteState(battleId);
  }

  // --- Store contract -----------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RevealVoteState => this.state;

  // --- Input --------------------------------------------------------------------------

  /** A newer snapshot of the battle (from the room's sync engine). */
  receive(snapshot: BattleSnapshot): void {
    if (this.disposed || snapshot.battle.id !== this.state.battleId) return;
    this.snapshot = snapshot;
    const phase = snapshot.battle.phase;
    if (isTerminalPhase(phase)) {
      this.release();
      return;
    }
    if (!REVEALED_PHASES.has(phase) || !snapshot.battle.reveal_order?.length) return;

    if (this.state.builds === null) void this.loadBuilds();
    if (phase === 'reveal') {
      this.ensureBundles();
    } else if (Object.keys(this.state.bundles).length > 0) {
      // REVEAL is over: no build runs any more, the bundles go.
      this.patch({ bundles: {} });
    }
    if (phase === 'voting' && snapshot.me.is_voter && !this.state.ballot.loaded) {
      void this.loadBallot();
    }
  }

  // --- Viewer intents (local only) ----------------------------------------------------

  /** Stop running this build in this tab (its thumbnail shows instead). */
  skip(buildId: string): void {
    if (this.state.skipped.includes(buildId)) return;
    this.patch({ skipped: [...this.state.skipped, buildId] });
  }

  /** Run it again (after a skip or a freeze): a fresh preview. */
  watch(buildId: string): void {
    this.patch({
      skipped: this.state.skipped.filter((id) => id !== buildId),
      frozen: this.state.frozen.filter((id) => id !== buildId),
    });
  }

  /** The preview's watchdog gave up on this build (no pong for 5 s). */
  markFrozen(buildId: string): void {
    if (this.state.frozen.includes(buildId)) return;
    this.patch({ frozen: [...this.state.frozen, buildId] });
  }

  // --- Host intents -------------------------------------------------------------------

  /** `reveal_next` (on the last build, VOTING starts). */
  next(): Promise<void> {
    return this.hostAction('next');
  }

  /** `skip_to_vote`: the rest of the reveal is skipped for everyone. */
  skipToVote(): Promise<void> {
    return this.hostAction('skip');
  }

  dismissHostError(): void {
    this.patch({ host: { ...this.state.host, error: null } });
  }

  private async hostAction(kind: 'next' | 'skip'): Promise<void> {
    const snap = this.snapshot;
    if (!snap || this.state.host.pending !== null || snap.battle.phase !== 'reveal') return;
    if (!snap.me.is_host) return;
    this.patch({ host: { pending: kind, error: null } });
    const call = kind === 'next' ? this.api.revealNext : this.api.skipToVote;
    let result: HostRevealResult | null = null;
    let error: GameError | null = null;
    try {
      result = await call.call(this.api, snap.battle.id, snap.battle.version);
    } catch (e) {
      error = toGameError(e);
    }
    if (this.disposed) return;
    const quiet = error !== null && QUIET_HOST_ERRORS.has(error.code);
    this.patch({ host: { pending: null, error: error && !quiet ? error : null } });
    // A stale version, a host change or a phase that moved on: the snapshot is behind.
    // (A successful step arrives as a `phase` event, like for everyone else.)
    if (quiet || result?.changed === false) void this.deps.refetch().catch(() => undefined);
  }

  // --- Voting -------------------------------------------------------------------------

  /** Votes for `buildId` in `category` (a revote replaces the earlier choice). */
  vote(category: string, buildId: string): void {
    const snap = this.snapshot;
    if (!snap || snap.battle.phase !== 'voting' || !snap.me.can_vote) return;
    const own = snap.builds.find((b) => b.id === buildId)?.builder_id === snap.me.user_id;
    if (own) return; // the UI never offers it; the server refuses it anyway (self_vote)
    const ballot = this.state.ballot;
    if (ballot.pending[category] !== undefined) {
      // One request per category at a time: the latest click goes next.
      this.queued.set(category, buildId);
      this.patch({ ballot: { ...ballot, pending: { ...ballot.pending, [category]: buildId } } });
      return;
    }
    if (ballot.votes[category] === buildId) return;
    void this.send(snap.battle.id, category, buildId);
  }

  private async send(battleId: string, category: string, buildId: string): Promise<void> {
    const errors = { ...this.state.ballot.errors };
    delete errors[category];
    this.patchBallot({
      pending: { ...this.state.ballot.pending, [category]: buildId },
      errors,
    });
    let result: CastVoteResult | null = null;
    let error: GameError | null = null;
    try {
      result = await this.api.castVote(battleId, category, buildId);
    } catch (e) {
      error = toGameError(e);
    }
    if (this.disposed) return;
    const pending = { ...this.state.ballot.pending };
    delete pending[category];
    if (result) {
      this.patchBallot({
        pending,
        votes: { ...this.state.ballot.votes, [category]: result.build_id },
        complete: result.ballot_complete,
      });
    } else if (error) {
      this.patchBallot({ pending, errors: { ...this.state.ballot.errors, [category]: error } });
      if (STALE_VOTE_ERRORS.has(error.code)) void this.deps.refetch().catch(() => undefined);
    }
    const next = this.queued.get(category);
    this.queued.delete(category);
    if (next !== undefined && !error && next !== this.state.ballot.votes[category]) {
      void this.send(battleId, category, next);
    }
  }

  dismissVoteError(category: string): void {
    const errors = { ...this.state.ballot.errors };
    delete errors[category];
    this.patchBallot({ errors });
  }

  private async loadBallot(): Promise<void> {
    if (this.ballotLoading) return;
    this.ballotLoading = true;
    try {
      const mine = await this.api.getMyVotes(this.state.battleId);
      if (this.disposed) return;
      // Choices confirmed meanwhile (a click during the load) win over the older read.
      this.patchBallot({
        votes: { ...mine.votes, ...this.state.ballot.votes },
        complete: mine.complete || this.state.ballot.complete,
        loaded: true,
      });
    } catch {
      if (this.disposed) return;
      this.scheduleRetry();
    } finally {
      this.ballotLoading = false;
    }
  }

  // --- Reveal builds and files --------------------------------------------------------

  private async loadBuilds(): Promise<void> {
    if (this.buildsLoading) return;
    this.buildsLoading = true;
    try {
      const builds = await this.api.getRevealBuilds(this.state.battleId);
      if (this.disposed) return;
      const sorted = [...builds].sort((a, b) => a.position - b.position);
      this.patch({ builds: sorted, buildsError: null });
      void this.loadThumbs(sorted);
      if (this.snapshot) this.receive(this.snapshot);
    } catch (e) {
      if (this.disposed) return;
      this.patch({ buildsError: toGameError(e) });
      this.scheduleRetry();
    } finally {
      this.buildsLoading = false;
    }
  }

  /** The spotlighted build and the next one: downloaded once, older ones dropped. */
  private ensureBundles(): void {
    const snap = this.snapshot;
    const builds = this.state.builds;
    if (!snap || !builds) return;
    const index = snap.battle.reveal_index ?? 0;
    const wanted = [index, index + 1]
      .map((i) => snap.battle.reveal_order?.[i])
      .filter((id): id is string => typeof id === 'string');
    const kept: Record<string, BundleState> = {};
    for (const id of wanted) {
      const have = this.state.bundles[id];
      if (have) kept[id] = have;
    }
    if (Object.keys(kept).length !== Object.keys(this.state.bundles).length) {
      this.patch({ bundles: kept });
    }
    for (const id of wanted) {
      const build = builds.find((b) => b.build_id === id);
      if (build && !this.state.bundles[id] && !this.bundleLoads.has(id)) {
        void this.loadBundle(build);
      }
    }
  }

  private async loadBundle(build: RevealBuild): Promise<void> {
    const id = build.build_id;
    this.bundleLoads.add(id);
    this.setBundle(id, { status: 'loading', build: null });
    const read = (path: string | null) =>
      path === null ? Promise.resolve(null) : this.api.downloadText(path);
    try {
      const [js, css, manifest] = await Promise.all([
        read(build.files.js),
        read(build.files.css),
        read(build.files.manifest),
      ]);
      if (this.disposed) return;
      const preview = revealPreviewBuild({ js, css, manifest }, this.deps.cdnBaseUrl);
      this.setBundle(
        id,
        preview ? { status: 'ready', build: preview } : { status: 'missing', build: null },
      );
    } catch (e) {
      if (this.disposed) return;
      this.setBundle(id, { status: 'error', build: null, error: toGameError(e) });
    } finally {
      this.bundleLoads.delete(id);
    }
  }

  /** Keeps a download only while its build is still wanted (the spotlight may have moved). */
  private setBundle(id: string, bundle: BundleState): void {
    const snap = this.snapshot;
    const index = snap?.battle.reveal_index ?? 0;
    const order = snap?.battle.reveal_order ?? [];
    const wanted = snap?.battle.phase === 'reveal' && [order[index], order[index + 1]].includes(id);
    if (!wanted) {
      if (this.state.bundles[id]) {
        const rest = { ...this.state.bundles };
        delete rest[id];
        this.patch({ bundles: rest });
      }
      return;
    }
    this.patch({ bundles: { ...this.state.bundles, [id]: bundle } });
  }

  private async loadThumbs(builds: readonly RevealBuild[]): Promise<void> {
    if (this.thumbsStarted) return;
    this.thumbsStarted = true;
    await Promise.all(
      builds.map(async (b) => {
        let url: string | null = null;
        if (b.files.thumb !== null) {
          const blob = await this.api.downloadBlob(b.files.thumb).catch(() => null);
          if (this.disposed) return;
          if (blob && blob.size > 0) url = this.urls.create(blob);
        }
        if (this.disposed) {
          if (url) this.urls.revoke(url);
          return;
        }
        this.patch({ thumbs: { ...this.state.thumbs, [b.build_id]: url } });
      }),
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.disposed) return;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.snapshot) this.receive(this.snapshot);
    }, this.retryMs);
  }

  // --- Teardown -----------------------------------------------------------------------

  /** DESTROY (or ABANDONED): no bundle and no thumbnail stays in this tab. */
  private release(): void {
    for (const url of Object.values(this.state.thumbs)) if (url) this.urls.revoke(url);
    if (Object.keys(this.state.bundles).length > 0 || Object.keys(this.state.thumbs).length > 0) {
      this.patch({ bundles: {}, thumbs: {} });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queued.clear();
    this.listeners.clear();
  }

  // --- Plumbing -----------------------------------------------------------------------

  private patchBallot(p: Partial<BallotState>): void {
    this.patch({ ballot: { ...this.state.ballot, ...p } });
  }

  private patch(p: Partial<RevealVoteState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}
