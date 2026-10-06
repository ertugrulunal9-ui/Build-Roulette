/**
 * When to take the screenshot (docs/03 §3.7, §3.9 "capture readiness is decided by the
 * capture worker"). Pure and clock-driven, so it is unit tested with fake times.
 *
 * Ready at the FIRST of:
 * - `signal`: the build called `window.buildRoulette.ready()` (a hint the page forwards; a
 *   build can send it early, late or never, so it can only make a capture sooner, never
 *   later than the cap);
 * - `idle`: no request in flight for `idleQuietMs` (network idle) and then `idleExtraMs`
 *   more (2 s), i.e. a quiet network for 2.5 s; a request in between restarts the wait;
 * - `cap`: `capMs` (6 s) after the capture page loaded, whatever the build does.
 *
 * The network events come from the browser (Playwright `request`/`requestfinished`/
 * `requestfailed`), not from the page, so a build cannot fake idleness. It can delay it with
 * a request that never ends, which is what the cap is for.
 */

export interface ReadinessOptions {
  capMs: number;
  idleQuietMs: number;
  idleExtraMs: number;
}

export const DEFAULT_READINESS: ReadinessOptions = {
  capMs: 6000,
  idleQuietMs: 500,
  idleExtraMs: 2000,
};

export type ReadyReason = 'signal' | 'idle' | 'cap';

export interface ReadyDecision {
  reason: ReadyReason;
  /** Ms after `start()`. */
  afterMs: number;
}

export class ReadinessTracker {
  private readonly inflight = new Set<unknown>();
  private lastActivity = Number.NEGATIVE_INFINITY;
  private startedAt: number | null = null;
  private signalled = false;

  constructor(private readonly opts: ReadinessOptions = DEFAULT_READINESS) {}

  /** The capture page has loaded; the cap counts from here. */
  start(now: number): void {
    this.startedAt ??= now;
    this.lastActivity = Math.max(this.lastActivity, now);
  }

  requestStarted(key: unknown, now: number): void {
    this.inflight.add(key);
    this.lastActivity = Math.max(this.lastActivity, now);
  }

  /** `requestfinished` or `requestfailed`. Unknown or repeated keys are ignored. */
  requestEnded(key: unknown, now: number): void {
    if (this.inflight.delete(key)) this.lastActivity = Math.max(this.lastActivity, now);
  }

  readySignal(): void {
    this.signalled = true;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /** The decision at `now`, or null to keep waiting. */
  decide(now: number): ReadyDecision | null {
    if (this.startedAt === null) return null;
    const afterMs = now - this.startedAt;
    if (this.signalled) return { reason: 'signal', afterMs };
    if (afterMs >= this.opts.capMs) return { reason: 'cap', afterMs };
    if (
      this.inflight.size === 0 &&
      now - this.lastActivity >= this.opts.idleQuietMs + this.opts.idleExtraMs
    ) {
      return { reason: 'idle', afterMs };
    }
    return null;
  }
}
