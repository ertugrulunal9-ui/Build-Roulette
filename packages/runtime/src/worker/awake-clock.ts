/**
 * Page-awake time for the bundler start's limits (T-041), the idea of T-031's watchdog clock
 * (preview-handle.ts) as a small class.
 *
 * The clock follows the real clock while the page's own timers run: a tick (a timer every
 * `INIT_TICK_MS`) advances it by the real time since the previous tick, but by at most
 * `maxCreditMs`. A tick that runs later than that shows that the page itself did not run (the
 * whole renderer got no CPU, as on a machine that is stopped or swapped out), and that time
 * is not counted. A page that is merely busy runs its timers a few hundred ms late at most,
 * and that still counts in full.
 *
 * Readings between ticks (`at`) are capped the same way, so the clock never goes backwards.
 */
export class AwakeClock {
  /** Awake time at the last tick. */
  private base = 0;
  /** Real time of the last tick (or of the start). */
  private lastTickAt: number;

  constructor(
    /** Real time the clock starts at (awake time 0). */
    start: number,
    /** The most one tick (or one reading) can add. */
    private readonly maxCreditMs: number,
  ) {
    this.lastTickAt = start;
  }

  /** Awake time at real time `now`. */
  at(now: number): number {
    return this.base + Math.min(Math.max(0, now - this.lastTickAt), this.maxCreditMs);
  }

  /** A tick ran at real time `now`; returns the awake time. */
  tick(now: number): number {
    this.base = this.at(now);
    this.lastTickAt = now;
    return this.base;
  }
}
