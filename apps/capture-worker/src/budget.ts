/**
 * The daily Browser Rendering budget (T-034). Workers Free includes 10 browser-minutes a
 * day; the `jobs` Edge Function stops rendering at ~9.5 min (the rest is margin for
 * captures in flight and for the gap between Cloudflare's count and ours) and captures fall
 * back to the client thumbnail until 00:00 UTC.
 *
 * The count lives in Postgres (`private.browser_budget`, one row per UTC day), so overlapping
 * function runs share it. Each render:
 *   1. `reserve()` → `browser_budget_reserve(reserve_ms, limit_ms)`: granted only while
 *      used + reserved + reserve_ms ≤ limit. A reservation older than 2 minutes counts as
 *      used (its run died between reserve and settle; we cannot know what it spent).
 *   2. render (the REST call reports the browser time it was billed, or we count wall time);
 *   3. `settle()` → `browser_budget_settle(day, reserved, used, rate_limited)`.
 *
 * The self-hosted worker (Playwright) has no budget.
 */
import { errorMessage, type Logger } from './log';

/** Browser time a day on Workers Free (Cloudflare's limit). */
export const FREE_BROWSER_MS_PER_DAY = 600_000;
/** Where the function stops: 9.5 min, leaving 30 s of margin. */
export const DEFAULT_BROWSER_BUDGET_MS = 570_000;
/** Reserved per render before it starts: a typical worst case (startup + load + 6 s cap + shot). */
export const DEFAULT_BROWSER_RESERVE_MS = 20_000;

export interface BudgetState {
  granted: boolean;
  /** The UTC day (YYYY-MM-DD) the reservation was taken on. */
  day: string;
  usedMs: number;
  reservedMs: number;
  limitMs: number;
}

/** The two RPCs (service role), implemented by `SupabaseBackend`. */
export interface BudgetBackend {
  reserveBrowserTime(reserveMs: number, limitMs: number): Promise<BudgetState>;
  settleBrowserTime(
    day: string,
    reservedMs: number,
    usedMs: number,
    rateLimited: boolean,
  ): Promise<void>;
}

export interface BudgetTicket {
  day: string;
  reservedMs: number;
}

/** What the capture job needs: may I render now, and what did it cost. */
export interface CaptureBudget {
  /** A ticket, or null when today's budget is spent. */
  reserve(): Promise<BudgetTicket | null>;
  /** Never throws (a failed settle is logged; the reservation then expires into "used"). */
  settle(ticket: BudgetTicket, usage: { browserMs: number; rateLimited: boolean }): Promise<void>;
}

export interface DailyBudgetOptions {
  limitMs: number;
  reserveMs: number;
}

export class DailyBrowserBudget implements CaptureBudget {
  constructor(
    private readonly backend: BudgetBackend,
    private readonly opts: DailyBudgetOptions,
    private readonly log: Logger,
  ) {}

  async reserve(): Promise<BudgetTicket | null> {
    const state = await this.backend.reserveBrowserTime(this.opts.reserveMs, this.opts.limitMs);
    if (!state.granted) {
      this.log.info('budget.spent', {
        day: state.day,
        usedMs: state.usedMs,
        reservedMs: state.reservedMs,
        limitMs: state.limitMs,
      });
      return null;
    }
    return { day: state.day, reservedMs: this.opts.reserveMs };
  }

  async settle(
    ticket: BudgetTicket,
    usage: { browserMs: number; rateLimited: boolean },
  ): Promise<void> {
    try {
      await this.backend.settleBrowserTime(
        ticket.day,
        ticket.reservedMs,
        Math.max(0, Math.round(usage.browserMs)),
        usage.rateLimited,
      );
    } catch (e) {
      this.log.error('budget.settle_failed', { day: ticket.day, error: errorMessage(e) });
    }
  }
}
