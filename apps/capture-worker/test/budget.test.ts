/**
 * The daily Browser Rendering budget (T-034): the client side of browser_budget_reserve /
 * browser_budget_settle. The SQL side (UTC day, limit, stale reservations) is
 * supabase/tests/26_jobs_function.test.sql.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_BUDGET_MS,
  DEFAULT_BROWSER_RESERVE_MS,
  DailyBrowserBudget,
  FREE_BROWSER_MS_PER_DAY,
  type BudgetBackend,
  type BudgetState,
} from '../src/budget';
import { createLogger } from '../src/log';
import { SupabaseBackend } from '../src/supabase';
import { bodyText, urlOf } from './fakes';

class FakeBudgetBackend implements BudgetBackend {
  used = 0;
  reserved = 0;
  calls: unknown[][] = [];
  settleFails = false;
  reserveBrowserTime(reserveMs: number, limitMs: number): Promise<BudgetState> {
    this.calls.push(['reserve', reserveMs, limitMs]);
    const granted = this.used + this.reserved + reserveMs <= limitMs;
    if (granted) this.reserved += reserveMs;
    return Promise.resolve({
      granted,
      day: '2026-10-09',
      usedMs: this.used,
      reservedMs: this.reserved,
      limitMs,
    });
  }
  settleBrowserTime(day: string, reservedMs: number, usedMs: number, rateLimited: boolean) {
    this.calls.push(['settle', day, reservedMs, usedMs, rateLimited]);
    if (this.settleFails) return Promise.reject(new Error('PostgREST down'));
    this.reserved -= reservedMs;
    this.used += usedMs;
    return Promise.resolve();
  }
}

describe('budget constants', () => {
  it('stops at 9.5 of the free plan’s 10 browser-minutes a day, reserving 20 s per render', () => {
    expect(FREE_BROWSER_MS_PER_DAY).toBe(600_000);
    expect(DEFAULT_BROWSER_BUDGET_MS).toBe(570_000);
    expect(DEFAULT_BROWSER_RESERVE_MS).toBe(20_000);
  });
});

describe('DailyBrowserBudget', () => {
  it('grants while the day has room, then refuses (and logs) until the day is over', async () => {
    const backend = new FakeBudgetBackend();
    const lines: string[] = [];
    const budget = new DailyBrowserBudget(
      backend,
      { limitMs: 50_000, reserveMs: 20_000 },
      createLogger({ write: (l) => lines.push(l) }),
    );
    const a = await budget.reserve();
    const b = await budget.reserve();
    expect(a).toEqual({ day: '2026-10-09', reservedMs: 20_000 });
    expect(b).not.toBeNull();
    expect(await budget.reserve()).toBeNull(); // 40 s reserved + 20 s > 50 s
    expect(lines.some((l) => l.includes('budget.spent'))).toBe(true);
    if (!a || !b) return;
    await budget.settle(a, { browserMs: 3999.6, rateLimited: false });
    await budget.settle(b, { browserMs: 0, rateLimited: true });
    expect(backend.calls.slice(-2)).toEqual([
      ['settle', '2026-10-09', 20_000, 4000, false],
      ['settle', '2026-10-09', 20_000, 0, true],
    ]);
    // 4 s used: room for two more reservations of 20 s.
    expect(await budget.reserve()).not.toBeNull();
    expect(await budget.reserve()).not.toBeNull();
    expect(await budget.reserve()).toBeNull();
  });

  it('a settle that fails is logged as an error and does not fail the capture', async () => {
    const backend = new FakeBudgetBackend();
    backend.settleFails = true;
    const lines: string[] = [];
    const budget = new DailyBrowserBudget(
      backend,
      { limitMs: 570_000, reserveMs: 20_000 },
      createLogger({ write: (l) => lines.push(l) }),
    );
    const t = await budget.reserve();
    if (!t) throw new Error('expected a ticket');
    await expect(budget.settle(t, { browserMs: 100, rateLimited: false })).resolves.toBeUndefined();
    expect(
      lines.some((l) => l.includes('"level":"error"') && l.includes('budget.settle_failed')),
    ).toBe(true);
  });
});

describe('SupabaseBackend budget RPCs', () => {
  it('calls browser_budget_reserve / browser_budget_settle with the service key', async () => {
    const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const backend = new SupabaseBackend({
      url: 'http://kong:8000',
      serviceKey: 'eyJ.service',
      fetch: (input, init) => {
        seen.push({
          url: urlOf(input),
          body: JSON.parse(bodyText(init)),
          headers: init?.headers as Record<string, string>,
        });
        const answer = urlOf(input).endsWith('browser_budget_reserve')
          ? {
              granted: true,
              day: '2026-10-09',
              used_ms: 1000,
              reserved_ms: 20000,
              limit_ms: 570000,
            }
          : null;
        return Promise.resolve(new Response(answer === null ? '' : JSON.stringify(answer)));
      },
    });
    expect(await backend.reserveBrowserTime(20_000, 570_000)).toEqual({
      granted: true,
      day: '2026-10-09',
      usedMs: 1000,
      reservedMs: 20_000,
      limitMs: 570_000,
    });
    await backend.settleBrowserTime('2026-10-09', 20_000, 1234, true);
    expect(seen.map((s) => [s.url, s.body])).toEqual([
      [
        'http://kong:8000/rest/v1/rpc/browser_budget_reserve',
        { p_reserve_ms: 20_000, p_limit_ms: 570_000 },
      ],
      [
        'http://kong:8000/rest/v1/rpc/browser_budget_settle',
        { p_day: '2026-10-09', p_reserved_ms: 20_000, p_used_ms: 1234, p_rate_limited: true },
      ],
    ]);
    expect(seen[0]?.headers['authorization']).toBe('Bearer eyJ.service');
  });

  it('hands out signed Storage URLs on the public URL when one is set (the browser is elsewhere)', async () => {
    const backend = new SupabaseBackend({
      url: 'http://kong:8000',
      publicUrl: 'http://127.0.0.1:54321/',
      serviceKey: 'k',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ signedURL: '/object/sign/ephemeral-builds/a/b.js?token=t' }),
          ),
        ),
    });
    expect(await backend.createSignedUrl('ephemeral-builds', 'a/b.js', 120)).toBe(
      'http://127.0.0.1:54321/storage/v1/object/sign/ephemeral-builds/a/b.js?token=t',
    );
  });
});
