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
import { fakeSite } from '../../lib/solo/test-support';
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

const BUILD = { site: fakeSite('Last look').pack };
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

describe('RevealPane load errors', () => {
  it('says so when the sandbox cannot serve the site here; a missing file or a runtime error does not', () => {
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
    // One file of the site that did not load: the site itself still runs.
    emit({ type: 'runtime-error', kind: 'module-load', message: 'Failed to load /assets/x.js' });
    expect(screen.queryByTestId('reveal-no-load')).toBeNull();
    emit({
      type: 'runtime-error',
      kind: 'module-load',
      message: 'This browser cannot run imported sites here: service workers are not available.',
    });
    expect(screen.getByTestId('reveal-no-load').textContent).toContain('couldn’t load');
    cleanup();
  });
});
