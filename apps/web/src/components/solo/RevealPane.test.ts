// @vitest-environment happy-dom
/**
 * The last-look pane (RESULTS of /play and of a room): a fresh reveal-mode preview whose
 * sandbox storage is wiped BEFORE the build loads (like the REVEAL spotlight), and again
 * when it goes; the watchdog's two crash reasons read differently, and a crash is reported
 * (T-031).
 */
import type { RuntimeErrorMessage } from '@br/protocol';
import { PreviewHandle, type PreviewCrash } from '@br/runtime';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Analytics from '../../lib/telemetry/analytics';
import { RevealPane } from './RevealPane';

const tracked = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
vi.mock('../../lib/telemetry/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof Analytics>()),
  track: (name: string, props: Record<string, unknown>) => {
    tracked.push([name, props]);
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BUILD = { js: 'console.log(1)', css: '', importMap: { imports: {} } };
const BATTLE = '00000000-0000-4000-8000-0000000000b1';

function spyPreview() {
  const order: string[] = [];
  const crashListeners: ((e: PreviewCrash) => void)[] = [];
  const errorListeners: ((e: RuntimeErrorMessage) => void)[] = [];
  vi.spyOn(PreviewHandle.prototype, 'resetStorage').mockImplementation(() => {
    order.push('resetStorage');
    return Promise.resolve({ type: 'storage-reset' as const, ok: true });
  });
  vi.spyOn(PreviewHandle.prototype, 'load').mockImplementation(() => {
    order.push('load');
    return 1;
  });
  vi.spyOn(PreviewHandle.prototype, 'on').mockImplementation((event, listener) => {
    if (event === 'crash') crashListeners.push(listener);
    if (event === 'error') errorListeners.push(listener);
    return () => undefined;
  });
  return { order, crashListeners, errorListeners };
}

describe('RevealPane', () => {
  it('wipes the sandbox storage before the build loads, and again when it goes', () => {
    const { order } = spyPreview();
    render(
      createElement(RevealPane, {
        battleId: BATTLE,
        build: BUILD,
        status: 'ready',
        destroy: 'none',
        caption: 'Last look',
      }),
    );
    expect(order).toEqual(['resetStorage', 'load']);
    expect(document.querySelectorAll('iframe[data-testid=reveal-frame]')).toHaveLength(1);
    cleanup();
    expect(order).toEqual(['resetStorage', 'load', 'resetStorage']);
  });

  it('a build that froze and one that never started read differently', () => {
    tracked.length = 0;
    const { crashListeners } = spyPreview();
    render(
      createElement(RevealPane, {
        battleId: BATTLE,
        build: BUILD,
        status: 'ready',
        destroy: 'none',
        caption: 'Last look',
      }),
    );
    const crash = (reason: PreviewCrash['reason'], silentForMs: number): PreviewCrash => ({
      reason,
      silentForMs,
      phase: reason === 'handshake-timeout' ? 'connecting' : 'running',
      wallSilentForMs: silentForMs,
      stalledMs: 0,
      longestStallMs: 0,
    });
    act(() => {
      for (const l of crashListeners) l(crash('handshake-timeout', 10_000));
    });
    const note = screen.getByTestId('reveal-crashed');
    expect(note.dataset['reason']).toBe('handshake-timeout');
    expect(note.textContent).toContain('couldn’t start');
    act(() => {
      for (const l of crashListeners) l(crash('heartbeat-timeout', 5_000));
    });
    expect(screen.getByTestId('reveal-crashed').textContent).toContain('froze');
    // Reported as reveal-mode crashes of this battle; the last look has no restart.
    cleanup();
    expect(tracked).toEqual([
      ['preview_crash', expect.objectContaining({ reason: 'handshake_timeout', restarted: false })],
      [
        'preview_crash',
        expect.objectContaining({
          battle_id: BATTLE,
          mode: 'reveal',
          reason: 'heartbeat_timeout',
          restarted: false,
        }),
      ],
    ]);
  });
});

describe('RevealPane package errors (T-032)', () => {
  it('says so when the build packages cannot load; other errors and stall notes do not', () => {
    const { errorListeners } = spyPreview();
    render(
      createElement(RevealPane, {
        battleId: BATTLE,
        build: BUILD,
        status: 'ready',
        destroy: 'none',
        caption: 'Last look',
      }),
    );
    const emit = (e: RuntimeErrorMessage) => {
      act(() => {
        for (const l of errorListeners) l(e);
      });
    };
    emit({ type: 'runtime-error', kind: 'error', message: 'TypeError: x is undefined' });
    // Not yet a failure: the build may still start.
    emit({
      type: 'runtime-error',
      kind: 'module-load',
      message: 'Still waiting for the package server after 8 s: zustand@5.0.15',
    });
    expect(screen.queryByTestId('reveal-no-packages')).toBeNull();
    emit({
      type: 'runtime-error',
      kind: 'module-load',
      message: 'Package server unreachable: zustand@5.0.15',
    });
    expect(screen.getByTestId('reveal-no-packages').textContent).toContain('package server');
    cleanup();
  });
});
