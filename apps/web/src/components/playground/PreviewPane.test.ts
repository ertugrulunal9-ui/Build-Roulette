// @vitest-environment happy-dom
/**
 * The crashed notice of the playground preview: the watchdog's reason and phase read
 * differently (could not start / froze while loading / froze while running), and the
 * notice carries them as data attributes for the e2e failure diagnostics.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSnapshot } from '../../lib/playground/sandbox';
import { PreviewPane } from './PreviewPane';

afterEach(() => {
  cleanup();
});

const noop = () => undefined;

function renderCrashed(crash: NonNullable<SandboxSnapshot['crash']>) {
  const snapshot: SandboxSnapshot = {
    bundler: 'ready',
    bundlerError: null,
    building: false,
    lastBuild: null,
    preview: 'crashed',
    crash,
    runtimeErrors: [],
    console: [],
    readyCount: 1,
  };
  render(
    createElement(PreviewPane, {
      hostRef: createRef<HTMLDivElement>(),
      snapshot,
      shellUrl: 'http://127.0.0.1:4311/v1/',
      onRestart: noop,
      onDismissErrors: noop,
      onClearConsole: noop,
      onOpenDiagnostic: noop,
    }),
  );
  return screen.getByTestId('preview-crashed');
}

describe('PreviewPane crashed notice', () => {
  it('a freeze while running: stopped responding, probably an infinite loop', () => {
    const note = renderCrashed({
      reason: 'heartbeat-timeout',
      silentForMs: 5120,
      phase: 'running',
    });
    expect(note.textContent).toContain('The preview crashed');
    expect(note.textContent).toContain('stopped responding for 5 s, probably an infinite loop');
    expect(note.dataset).toMatchObject({
      reason: 'heartbeat-timeout',
      silentMs: '5120',
      phase: 'running',
    });
  });

  it('a freeze during the load: the build did not finish starting (after the 15 s grace)', () => {
    const note = renderCrashed({
      reason: 'heartbeat-timeout',
      silentForMs: 15_140,
      phase: 'loading',
    });
    expect(note.textContent).toContain('The preview crashed');
    expect(note.textContent).toContain('didn’t finish starting');
    expect(note.textContent).toContain('15 s while it loaded');
    expect(note.dataset['phase']).toBe('loading');
  });

  it('a handshake timeout: the preview could not start', () => {
    const note = renderCrashed({
      reason: 'handshake-timeout',
      silentForMs: 10_100,
      phase: 'connecting',
    });
    expect(note.textContent).toContain('The preview could not start');
    expect(note.textContent).toContain('did not answer');
  });
});
