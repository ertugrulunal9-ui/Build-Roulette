// @vitest-environment happy-dom
/**
 * The live preview of an imported site: the crashed notice (the watchdog's reason and phase
 * read differently, carried as data attributes for the e2e failure diagnostics), the overlay
 * for a site the sandbox could not serve, and the collapsible Problems / Console panel.
 */
import type { RuntimeErrorMessage } from '@br/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSnapshot } from '../../lib/preview/preview-controller';
import { PreviewPane } from './PreviewPane';

afterEach(() => {
  cleanup();
});

const noop = () => undefined;

const RUNNING: PreviewSnapshot = {
  preview: 'running',
  crash: null,
  runtimeErrors: [],
  console: [],
  readyCount: 1,
};

function renderPane(snapshot: Partial<PreviewSnapshot>, handlers: Record<string, () => void> = {}) {
  render(
    createElement(PreviewPane, {
      hostRef: createRef<HTMLDivElement>(),
      snapshot: { ...RUNNING, ...snapshot },
      shellUrl: 'http://127.0.0.1:4311/v2/',
      onRestart: noop,
      onDismissErrors: noop,
      onClearConsole: noop,
      ...handlers,
    }),
  );
}

function renderCrashed(crash: NonNullable<PreviewSnapshot['crash']>) {
  renderPane({ preview: 'crashed', crash });
  return screen.getByTestId('preview-crashed');
}

describe('PreviewPane crashed notice', () => {
  it('a freeze while running: stopped responding, probably an infinite loop', () => {
    const note = renderCrashed({
      reason: 'heartbeat-timeout',
      silentForMs: 5120,
      phase: 'running',
      wallSilentForMs: 5120,
      stalledMs: 0,
      longestStallMs: 0,
    });
    expect(note.textContent).toContain('The preview crashed');
    expect(note.textContent).toContain('stopped responding for 5 s, probably an infinite loop');
    expect(note.dataset).toMatchObject({
      reason: 'heartbeat-timeout',
      silentMs: '5120',
      phase: 'running',
    });
  });

  it('a freeze during the load: the site did not finish starting (after the 15 s grace)', () => {
    const note = renderCrashed({
      reason: 'heartbeat-timeout',
      silentForMs: 15_140,
      phase: 'loading',
      wallSilentForMs: 15_140,
      stalledMs: 0,
      longestStallMs: 0,
    });
    expect(note.textContent).toContain('The preview crashed');
    expect(note.textContent).toContain('didn’t finish starting');
    expect(note.textContent).toContain('15 s while it loaded');
    expect(note.dataset['phase']).toBe('loading');
  });

  it('a handshake timeout: the preview could not start; Restart restarts it', () => {
    const onRestart = vi.fn();
    renderPane(
      {
        preview: 'crashed',
        crash: {
          reason: 'handshake-timeout',
          silentForMs: 10_100,
          phase: 'connecting',
          wallSilentForMs: 10_100,
          stalledMs: 0,
          longestStallMs: 0,
        },
      },
      { onRestart },
    );
    const note = screen.getByTestId('preview-crashed');
    expect(note.textContent).toContain('The preview could not start');
    expect(note.textContent).toContain('did not answer');
    fireEvent.click(screen.getByRole('button', { name: 'Restart preview' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe('PreviewPane errors of the site', () => {
  const err = (message: string, kind: RuntimeErrorMessage['kind'] = 'error') =>
    ({ type: 'runtime-error', kind, message }) as RuntimeErrorMessage;

  it('a site the sandbox could not serve: an overlay with the reason', () => {
    const onDismissErrors = vi.fn();
    renderPane(
      {
        runtimeErrors: [
          err(
            'The imported site could not be read: bad header length. Import it again.',
            'module-load',
          ),
        ],
      },
      { onDismissErrors },
    );
    expect(screen.getByTestId('error-overlay').textContent).toContain(
      'Your site could not be loaded',
    );
    expect(screen.getByTestId('error-message').textContent).toContain('could not be read');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissErrors).toHaveBeenCalledTimes(1);
  });

  it('a file that failed to load or a runtime error only counts under Problems', () => {
    renderPane({
      runtimeErrors: [
        err('Failed to load /assets/missing.js', 'module-load'),
        err('TypeError: x is undefined'),
      ],
      console: [{ id: 1, level: 'log', text: 'hello from the site', source: 'sandbox' }],
    });
    expect(screen.queryByTestId('error-overlay')).toBeNull();
    const panel = screen.getByTestId('problems-panel');
    expect(panel.dataset['open']).toBe('false');
    expect(screen.getByTestId('problem-count').textContent).toBe('(2)');
    expect(screen.queryByTestId('problems')).toBeNull();
    // Opens on a click (a keyboard button), Problems first.
    fireEvent.click(screen.getByTestId('problems-toggle'));
    expect(panel.dataset['open']).toBe('true');
    const problems = screen.getByTestId('problems');
    expect(problems.textContent).toContain('Failed to load /assets/missing.js');
    expect(problems.textContent).toContain('TypeError: x is undefined');
    fireEvent.click(screen.getByRole('tab', { name: /Console/ }));
    expect(screen.getByTestId('console').textContent).toContain('hello from the site');
  });

  it('before anything is imported there is no panel', () => {
    render(
      createElement(PreviewPane, {
        hostRef: createRef<HTMLDivElement>(),
        snapshot: { ...RUNNING, preview: 'idle', readyCount: 0 },
        shellUrl: 'http://127.0.0.1:4311/v2/',
        onRestart: noop,
        onDismissErrors: noop,
        onClearConsole: noop,
        hidePanel: true,
      }),
    );
    expect(screen.queryByTestId('problems-panel')).toBeNull();
  });
});
