/**
 * REVEAL and VOTING of a room battle on the client (docs/04 §4.11, supabase/README.md
 * "Reveal and voting"), as plain TypeScript next to the battle's SoloController, so it can
 * be unit tested with fakes:
 *
 * - **Reveal builds:** `get_reveal_builds` once the battle is in REVEAL or VOTING (the
 *   object names of every final build, in reveal order). Retried while it fails.
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
 *   compare-and-set. The battle's version also moves for things that do not change what
 *   the click means (a screenshot landing: the capture worker finishes the builds' captures
 *   one after another right at the start of REVEAL), so a stale answer whose phase is still
 *   REVEAL on the same spotlight (any spotlight, for a skip) is sent again with the version
 *   it returned, up to `HOST_RETRIES` times. A stale call that really is stale (the
 *   spotlight moved: the timer or another click) or one the server refuses because the
 *   moment passed (`not_host` after a host change, `wrong_phase`, `invalid_version`) is a
 *   quiet no-op plus a refetch: the realtime events tell everyone what really happened.
 * - **Ballot:** `get_my_votes` restores the caller's own choices (after a refresh too);
 *   `cast_vote` per category, revotes allowed, one request at a time per category (the
 *   latest click wins). Every refusal is kept per category for the UI. **No silent loss:**
 *   a pick that cannot reach the server (offline) stays `unsent` and is sent again every
 *   `retryMs` and with every fresh snapshot until it lands; one that never landed before
 *   VOTING ended (or arrived just after) becomes `lost`, which RESULTS shows the player.
 * - **Memory:** bundles are dropped once REVEAL is over; everything at DESTROY.
 *
 * The snapshot comes from the room's sync engine through `receive()`.
 */
import { isTerminalPhase } from '@br/game';
import type { CrashReason, PreviewBuild } from '@br/runtime';
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
  /**
   * category → build id the server could not be reached for (offline): sent again every
   * `retryMs` and with every fresh snapshot, until it lands or VOTING ends.
   */
  unsent: Readonly<Record<string, string>>;
  /**
   * category → build id picked but never counted: still unsent when VOTING ended, or
   * refused because the vote had just closed. RESULTS tells the player.
   */
  lost: Readonly<Record<string, string>>;
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
  /** Build ids whose preview froze in this tab (the watchdog fired: no pong for 5 s). */
  frozen: readonly string[];
  /**
   * Build ids whose preview never started in this tab (the shell did not complete its
   * handshake within 10 s: blocked, offline, or a device that could not load it). Shown
   * differently from a freeze: the build did nothing wrong.
   */
  failedToStart: readonly string[];
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
    failedToStart: [],
    host: { pending: null, error: null },
    ballot: {
      votes: {},
      complete: false,
      loaded: false,
      pending: {},
      unsent: {},
      lost: {},
      errors: {},
    },
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
/** Resends of a host click whose version went stale for an unrelated reason. */
export const HOST_RETRIES = 3;
/** Vote errors after which the snapshot is surely stale. */
const STALE_VOTE_ERRORS = new Set(['wrong_phase', 'deadline_passed', 'not_a_member', 'kicked']);
/**
 * Vote failures that say nothing about the vote itself (the request did not get an answer):
 * the pick is kept and sent again. `cast_vote` is an upsert, so a repeat is harmless even
 * when the first request did land.
 */
const TRANSIENT_VOTE_ERRORS = new Set(['network', 'unknown', 'rate_limited']);

/** The phases that use the reveal list (RESULTS shows the screenshots instead). */
const SHOW_PHASES = new Set(['reveal', 'voting']);

/** A copy of `record` without `key`. */
function without<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

// ─── Controller ───────────────────────────────────────────────────────────────────────

/**
 * The bundles REVEAL keeps: the spotlight and the next build that a moderator did not take
 * down (the server skips the slots of taken-down builds; T-024).
 */
function wantedBundles(snap: BattleSnapshot): string[] {
  const index = snap.battle.reveal_index ?? 0;
  const order = snap.battle.reveal_order ?? [];
  const removed = (id: string) => snap.builds.some((b) => b.id === id && b.taken_down === true);
  const next = order.slice(index + 1).find((id) => !removed(id));
  return [order[index], next].filter((id): id is string => typeof id === 'string' && !removed(id));
}

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
  /** Sends the picks that are waiting for the connection again. */
  private voteRetryTimer: TimerHandle | null = null;
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
    if (phase !== 'voting') this.closeBallot();
    if (isTerminalPhase(phase)) {
      this.release();
      return;
    }
    if (!SHOW_PHASES.has(phase) || !snapshot.battle.reveal_order?.length) {
      // RESULTS (or a battle without a reveal): no build runs any more.
      if (Object.keys(this.state.bundles).length > 0) this.patch({ bundles: {} });
      return;
    }

    if (this.state.builds === null) void this.loadBuilds();
    this.dropRemoved(snapshot);
    if (phase === 'reveal') {
      this.ensureBundles();
    } else if (Object.keys(this.state.bundles).length > 0) {
      // REVEAL is over: no build runs any more, the bundles go.
      this.patch({ bundles: {} });
    }
    if (phase === 'voting' && snapshot.me.is_voter && !this.state.ballot.loaded) {
      void this.loadBallot();
    }
    // A fresh snapshot means the server answers again: send what is waiting at once.
    if (phase === 'voting') this.flushUnsent();
  }

  /**
   * A moderator took builds down (T-024, `taken_down` in the snapshot): their bundles go,
   * and the votes for them are gone on the server (deleted with the takedown), so they
   * leave the ballot too and the voter picks again in those categories.
   */
  private dropRemoved(snapshot: BattleSnapshot): void {
    const removed = new Set(snapshot.builds.filter((b) => b.taken_down === true).map((b) => b.id));
    if (removed.size === 0) return;
    const bundles = Object.fromEntries(
      Object.entries(this.state.bundles).filter(([id]) => !removed.has(id)),
    );
    if (Object.keys(bundles).length !== Object.keys(this.state.bundles).length) {
      this.patch({ bundles });
    }
    const keep = (r: Readonly<Record<string, string>>) =>
      Object.fromEntries(Object.entries(r).filter(([, id]) => !removed.has(id)));
    const { ballot } = this.state;
    const votes = keep(ballot.votes);
    const pending = keep(ballot.pending);
    const unsent = keep(ballot.unsent);
    const changed =
      Object.keys(votes).length !== Object.keys(ballot.votes).length ||
      Object.keys(pending).length !== Object.keys(ballot.pending).length ||
      Object.keys(unsent).length !== Object.keys(ballot.unsent).length;
    if (changed) {
      this.patchBallot({
        votes,
        pending,
        unsent,
        complete: ballot.complete && Object.keys(votes).length === Object.keys(ballot.votes).length,
      });
    }
  }

  // --- Viewer intents (local only) ----------------------------------------------------

  /** Stop running this build in this tab (its thumbnail shows instead). */
  skip(buildId: string): void {
    if (this.state.skipped.includes(buildId)) return;
    this.patch({ skipped: [...this.state.skipped, buildId] });
  }

  /** Run it again (after a skip, a freeze or a failed start): a fresh preview. */
  watch(buildId: string): void {
    this.patch({
      skipped: this.state.skipped.filter((id) => id !== buildId),
      frozen: this.state.frozen.filter((id) => id !== buildId),
      failedToStart: this.state.failedToStart.filter((id) => id !== buildId),
    });
  }

  /**
   * The preview's watchdog gave up on this build: `heartbeat-timeout` (no pong for 5 s: it
   * froze) or `handshake-timeout` (the shell never answered: it could not start).
   */
  markFrozen(buildId: string, reason: CrashReason = 'heartbeat-timeout'): void {
    const key = reason === 'handshake-timeout' ? 'failedToStart' : 'frozen';
    if (this.state[key].includes(buildId)) return;
    this.patch({ [key]: [...this.state[key], buildId] });
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
    const { id, reveal_index: spotlight } = snap.battle;
    let { version } = snap.battle;
    let result: HostRevealResult | null = null;
    let error: GameError | null = null;
    for (let attempt = 0; ; attempt++) {
      result = null;
      error = null;
      try {
        result = await (kind === 'next'
          ? this.api.revealNext(id, version)
          : this.api.skipToVote(id, version));
      } catch (e) {
        error = toGameError(e);
      }
      if (this.disposed) return;
      // Stale only because something unrelated moved the version (a capture): the click
      // still means the same thing, so it goes again with the server's version.
      const sameMoment =
        result?.changed === false &&
        result.phase === 'reveal' &&
        (kind === 'skip' || result.reveal_index === spotlight);
      if (!sameMoment || attempt >= HOST_RETRIES) break;
      version = result?.version ?? version;
    }
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
    if (snap?.battle.phase !== 'voting' || snap.me.can_vote !== true) return;
    const own = snap.builds.find((b) => b.id === buildId)?.builder_id === snap.me.user_id;
    if (own) return; // the UI never offers it; the server refuses it anyway (self_vote)
    const ballot = this.state.ballot;
    if (ballot.pending[category] !== undefined) {
      // One request per category at a time: the latest click goes next.
      this.queued.set(category, buildId);
      this.patch({ ballot: { ...ballot, pending: { ...ballot.pending, [category]: buildId } } });
      return;
    }
    if (ballot.votes[category] === buildId) {
      // Back to the confirmed choice: a pick still waiting for the connection is dropped.
      if (ballot.unsent[category] !== undefined) {
        this.patchBallot({
          unsent: without(ballot.unsent, category),
          errors: without(ballot.errors, category),
        });
      }
      return;
    }
    void this.send(snap.battle.id, category, buildId);
  }

  private async send(battleId: string, category: string, buildId: string): Promise<void> {
    this.patchBallot({
      pending: { ...this.state.ballot.pending, [category]: buildId },
      unsent: without(this.state.ballot.unsent, category),
      errors: without(this.state.ballot.errors, category),
    });
    let result: CastVoteResult | null = null;
    let error: GameError | null = null;
    try {
      result = await this.api.castVote(battleId, category, buildId);
    } catch (e) {
      error = toGameError(e);
    }
    if (this.disposed) return;
    const pending = without(this.state.ballot.pending, category);
    // The latest click while this request was in flight.
    const next = this.queued.get(category);
    this.queued.delete(category);
    const latest = next ?? buildId;

    if (result) {
      this.patchBallot({
        pending,
        votes: { ...this.state.ballot.votes, [category]: result.build_id },
        complete: result.ballot_complete,
      });
      if (latest !== result.build_id) void this.send(battleId, category, latest);
      return;
    }
    if (!error) return;
    const ballot = this.state.ballot;

    if (TRANSIENT_VOTE_ERRORS.has(error.code) && this.snapshot?.battle.phase === 'voting') {
      if (latest === ballot.votes[category]) {
        // The latest click went back to the confirmed choice: nothing left to send.
        this.patchBallot({ pending });
        return;
      }
      // The server could not be reached (offline, a dropped connection): the pick is kept
      // and sent again until it lands or VOTING ends; the UI says it is not saved yet.
      this.patchBallot({
        pending,
        unsent: { ...ballot.unsent, [category]: latest },
        errors: { ...ballot.errors, [category]: error },
      });
      this.scheduleVoteRetry();
      return;
    }

    const errors = { ...ballot.errors, [category]: error };
    if (STALE_VOTE_ERRORS.has(error.code)) {
      // VOTING is over (or this player is out): the pick did not count. Say so in RESULTS
      // when it was the voting deadline.
      const closed = error.code === 'wrong_phase' || error.code === 'deadline_passed';
      this.patchBallot({
        pending,
        errors,
        lost: closed ? { ...ballot.lost, [category]: latest } : ballot.lost,
      });
      void this.deps.refetch().catch(() => undefined);
      return;
    }
    // Refused for this build only (e.g. not_votable): a different later click still goes.
    this.patchBallot({ pending, errors });
    if (next !== undefined && next !== buildId && next !== this.state.ballot.votes[category]) {
      void this.send(battleId, category, next);
    }
  }

  /** Sends again every pick that is waiting for the connection (one request per category). */
  private flushUnsent(): void {
    const snap = this.snapshot;
    if (snap?.battle.phase !== 'voting') return;
    for (const [category, buildId] of Object.entries(this.state.ballot.unsent)) {
      if (this.state.ballot.pending[category] === undefined) {
        void this.send(snap.battle.id, category, buildId);
      }
    }
  }

  private scheduleVoteRetry(): void {
    if (this.voteRetryTimer !== null || this.disposed) return;
    this.voteRetryTimer = this.clock.setTimeout(() => {
      this.voteRetryTimer = null;
      this.flushUnsent();
    }, this.retryMs);
  }

  /**
   * VOTING is over: picks that never reached the server (offline until the end) did not
   * count. They are kept as `lost`, so RESULTS can say so; nothing is retried any more.
   */
  private closeBallot(): void {
    if (this.voteRetryTimer !== null) this.clock.clearTimeout(this.voteRetryTimer);
    this.voteRetryTimer = null;
    const ballot = this.state.ballot;
    if (Object.keys(ballot.unsent).length === 0) return;
    this.patchBallot({ unsent: {}, lost: { ...ballot.lost, ...ballot.unsent } });
  }

  dismissVoteError(category: string): void {
    this.patchBallot({ errors: without(this.state.ballot.errors, category) });
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
    const wanted = wantedBundles(snap);
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
    const wanted = snap?.battle.phase === 'reveal' && wantedBundles(snap).includes(id);
    if (!wanted) {
      if (this.state.bundles[id]) this.patch({ bundles: without(this.state.bundles, id) });
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
    if (this.voteRetryTimer !== null) this.clock.clearTimeout(this.voteRetryTimer);
    this.voteRetryTimer = null;
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
