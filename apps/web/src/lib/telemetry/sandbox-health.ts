/**
 * Sandbox health (T-031): the preview watchdog's crashes as analytics events, and per-battle
 * preview counters for the `sync_health` summary. This is how production shows whether
 * players still see false "your build stopped responding" crashes.
 *
 * - **`preview_crash`**, one per watchdog crash: reason, phase, the app-awake and wall-clock
 *   silences, the app-side stall during the silence (`stalled_ms`, `longest_stall_ms`:
 *   starvation evidence; the watchdog does not count it), the mode (`live` while building,
 *   `reveal` for a REVEAL spotlight or the last look) and whether the user restarted the
 *   preview. It is sent once that outcome is known: when the user restarts it, when the
 *   preview slot goes away without a restart, or when the page goes away.
 * - **Per battle** (`SandboxHealthTally`): crashes, restarts, the watchdog's app stalls
 *   (≥ 1 s) and their total, and the silences the pre-T-031 watchdog would have called a
 *   crash (`sparedSilences`: they ended with a pong). Summed over every preview of the battle
 *   in this tab, including those still running, and taken once by the room's `sync_health`.
 * - **`bundler_start`** (T-039), one per bundler worker start that stalled (no progress for
 *   15 s during the download, or not ready 60 s after it; T-041) or failed, and for the
 *   automatic retry after a stall whatever its outcome: how far it got (`worker`,
 *   `download`, `compile`), the attempt, the time (wall clock, and the page-awake part the
 *   limits count) and the wasm bytes received. A clean first start sends nothing.
 *
 * Privacy (T-030 rules): no build code, no console output, no names, no URLs: only the
 * battle's random UUID, enums and numbers. Every event goes through `track`, a no-op
 * without `NEXT_PUBLIC_POSTHOG_KEY` or with DNT/GPC.
 */
import type { InitAttemptReport, PreviewCrash, PreviewStats } from '@br/runtime';
import {
  flushAnalytics,
  track as defaultTrack,
  type PreviewHealthProps,
  type Track,
} from './analytics';

export type PreviewMode = 'live' | 'reveal';

/** One battle's preview counters in this tab. */
export interface PreviewHealthCounts {
  crashes: number;
  restarts: number;
  stalls: number;
  stallMs: number;
  spared: number;
}

const ZERO: PreviewHealthCounts = { crashes: 0, restarts: 0, stalls: 0, stallMs: 0, spared: 0 };

/** The watchdog counters of one PreviewHandle (read while it runs and when it goes). */
export type WatchdogStats = Pick<PreviewStats, 'stalls' | 'stallMs' | 'sparedSilences'>;

/** Battles whose counters are kept before they are taken (solo battles never are). */
const MAX_BATTLES = 20;

function fromStats(s: WatchdogStats): Partial<PreviewHealthCounts> {
  return { stalls: s.stalls, stallMs: s.stallMs, spared: s.sparedSilences };
}

function plus(a: PreviewHealthCounts, b: Partial<PreviewHealthCounts>): PreviewHealthCounts {
  return {
    crashes: a.crashes + (b.crashes ?? 0),
    restarts: a.restarts + (b.restarts ?? 0),
    stalls: a.stalls + (b.stalls ?? 0),
    stallMs: a.stallMs + (b.stallMs ?? 0),
    spared: a.spared + (b.spared ?? 0),
  };
}

export class SandboxHealthTally {
  private readonly totals = new Map<string, PreviewHealthCounts>();
  private readonly running = new Map<string, Set<() => WatchdogStats>>();
  /** Battles already taken: later counts are not kept. */
  private readonly taken = new Set<string>();

  add(battleId: string | null, counts: Partial<PreviewHealthCounts>): void {
    if (battleId === null || this.taken.has(battleId)) return;
    this.totals.set(battleId, plus(this.totals.get(battleId) ?? ZERO, counts));
    if (this.totals.size > MAX_BATTLES) {
      const oldest = this.totals.keys().next().value;
      if (oldest !== undefined) this.totals.delete(oldest);
    }
  }

  /**
   * Counts a preview's watchdog stats for `battleId`: read when the battle is taken while it
   * still runs, added once when the returned stop is called.
   */
  follow(battleId: string | null, stats: () => WatchdogStats): () => void {
    if (battleId === null) return () => undefined;
    let set = this.running.get(battleId);
    if (!set) this.running.set(battleId, (set = new Set()));
    const own = set;
    own.add(stats);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      own.delete(stats);
      if (own.size === 0 && this.running.get(battleId) === own) this.running.delete(battleId);
      this.add(battleId, fromStats(stats()));
    };
  }

  /** The battle's counters so far, including previews still running. Once per battle. */
  take(battleId: string): PreviewHealthCounts {
    let counts = this.totals.get(battleId) ?? ZERO;
    for (const stats of this.running.get(battleId) ?? []) counts = plus(counts, fromStats(stats()));
    this.totals.delete(battleId);
    this.running.delete(battleId);
    this.taken.add(battleId);
    return counts;
  }
}

/** This page's tally. */
export const sandboxHealth = new SandboxHealthTally();

/** The tally's counters as `sync_health` properties. */
export function previewHealthProps(c: PreviewHealthCounts): PreviewHealthProps {
  return {
    preview_crashes: c.crashes,
    preview_restarts: c.restarts,
    preview_stalls: c.stalls,
    preview_stall_ms: Math.round(c.stallMs),
    preview_spared: c.spared,
  };
}

export interface PreviewHealthOptions {
  mode: PreviewMode;
  /** The battle the preview belongs to (null outside a battle). */
  battleId: string | null;
  track?: Track;
  tally?: SandboxHealthTally;
  /** Sends queued events at once (default: analytics.ts with `keepalive`). */
  flush?: () => void;
  /** Where `pagehide` is heard (default: `window`, when there is one). */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * One preview slot's watchdog telemetry: follows its PreviewHandle's stats for the battle's
 * tally, and reports each crash once its outcome (restarted or not) is known.
 */
export class PreviewHealth {
  private readonly track: Track;
  private readonly tally: SandboxHealthTally;
  private readonly win: PreviewHealthOptions['win'];
  private pending: { crash: PreviewCrash; key: string | null } | null = null;
  private stopFollowing: (() => void) | null = null;
  private closed = false;

  constructor(private readonly opts: PreviewHealthOptions) {
    this.track = opts.track ?? defaultTrack;
    this.tally = opts.tally ?? sandboxHealth;
    this.win = opts.win !== undefined ? opts.win : typeof window === 'undefined' ? null : window;
  }

  /**
   * Follows `preview`'s watchdog stats (a new handle replaces the previous one). Returns a
   * stop for when this handle goes (`close()` stops it too).
   */
  follow(preview: { readonly stats: WatchdogStats }): () => void {
    this.stopFollowing?.();
    const stop = this.tally.follow(this.opts.battleId, () => preview.stats);
    this.stopFollowing = stop;
    return () => {
      stop();
      if (this.stopFollowing === stop) this.stopFollowing = null;
    };
  }

  /**
   * The watchdog stopped the preview. `key` names what crashed (a build id, when the slot runs
   * several builds), so a restart of something else does not count.
   */
  crashed(crash: PreviewCrash, key: string | null = null): void {
    if (this.closed) return;
    this.settle(false); // an earlier crash nobody restarted
    this.pending = { crash, key };
    this.tally.add(this.opts.battleId, { crashes: 1 });
    this.win?.addEventListener('pagehide', this.onPageHide);
  }

  /** The user restarted the crashed preview (of `key`, when given). */
  restarted(key: string | null = null): void {
    if (!this.pending || (key !== null && this.pending.key !== key)) return;
    this.tally.add(this.opts.battleId, { restarts: 1 });
    this.settle(true);
  }

  /**
   * A bundler worker start ended (T-039). Stalls and errors are sent, and so is the automatic
   * retry after a stall (did it help?); a clean first start is not.
   */
  bundlerStart(r: InitAttemptReport): void {
    if (this.closed || (r.outcome === 'ready' && r.attempt === 1)) return;
    this.track('bundler_start', {
      battle_id: this.opts.battleId,
      outcome: r.outcome,
      stage: r.stage,
      attempt: r.attempt,
      elapsed_ms: Math.round(r.elapsedMs),
      awake_ms: Math.round(r.awakeMs),
      loaded_bytes: r.loadedBytes,
    });
  }

  /** The slot goes away: a crash still pending was not restarted. */
  close(): void {
    this.settle(false);
    this.stopFollowing?.();
    this.stopFollowing = null;
    this.closed = true;
  }

  private readonly onPageHide = (): void => {
    if (!this.pending) return;
    this.settle(false);
    (this.opts.flush ?? flushAnalytics)();
  };

  private settle(restarted: boolean): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.win?.removeEventListener('pagehide', this.onPageHide);
    const c = p.crash;
    this.track('preview_crash', {
      battle_id: this.opts.battleId,
      mode: this.opts.mode,
      reason: c.reason === 'handshake-timeout' ? 'handshake_timeout' : 'heartbeat_timeout',
      phase: c.phase,
      silent_ms: Math.round(c.silentForMs),
      wall_silent_ms: Math.round(c.wallSilentForMs),
      stalled_ms: Math.round(c.stalledMs),
      longest_stall_ms: Math.round(c.longestStallMs),
      restarted,
    });
  }
}
