// @vitest-environment happy-dom
/**
 * The last-look pane (RESULTS of /play and of a room): a fresh reveal-mode preview whose
 * sandbox storage is wiped BEFORE the build loads (like the REVEAL spotlight), and again
 * when it goes; the watchdog's two crash reasons read differently.
 */
import { PreviewHandle } from '@br/runtime';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevealPane } from './RevealPane';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BUILD = { js: 'console.log(1)', css: '', importMap: { imports: {} } };

function spyPreview() {
  const order: string[] = [];
  const crashListeners: ((e: { reason: string; silentForMs: number }) => void)[] = [];
  vi.spyOn(PreviewHandle.prototype, 'resetStorage').mockImplementation(() => {
    order.push('resetStorage');
    return Promise.resolve({ type: 'storage-reset' as const, ok: true });
  });
  vi.spyOn(PreviewHandle.prototype, 'load').mockImplementation(() => {
    order.push('load');
    return 1;
  });
  vi.spyOn(PreviewHandle.prototype, 'on').mockImplementation((event, listener) => {
    if (event === 'crash') crashListeners.push(listener as (typeof crashListeners)[number]);
    return () => undefined;
  });
  return { order, crashListeners };
}

describe('RevealPane', () => {
  it('wipes the sandbox storage before the build loads, and again when it goes', () => {
    const { order } = spyPreview();
    render(
      createElement(RevealPane, {
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
    const { crashListeners } = spyPreview();
    render(
      createElement(RevealPane, {
        build: BUILD,
        status: 'ready',
        destroy: 'none',
        caption: 'Last look',
      }),
    );
    act(() => {
      for (const l of crashListeners) l({ reason: 'handshake-timeout', silentForMs: 10_000 });
    });
    const note = screen.getByTestId('reveal-crashed');
    expect(note.dataset['reason']).toBe('handshake-timeout');
    expect(note.textContent).toContain('couldn’t start');
    act(() => {
      for (const l of crashListeners) l({ reason: 'heartbeat-timeout', silentForMs: 5_000 });
    });
    expect(screen.getByTestId('reveal-crashed').textContent).toContain('froze');
  });
});
