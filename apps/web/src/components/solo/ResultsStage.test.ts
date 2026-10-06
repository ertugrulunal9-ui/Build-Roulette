// @vitest-environment happy-dom
/**
 * RESULTS rendering of each capture outcome: captured, fallback (the client thumbnail),
 * failed, still pending, and a DNF build. The e2e covers `captured` against the real stack.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_SOLO_STATE, type SoloController, type SoloState } from '../../lib/solo/controller';
import { BATTLE, BUILD_ID, snapshotAt } from '../../lib/solo/test-support';
import type { BattleSnapshot } from '../../lib/solo/types';
import { ResultsStage } from './ResultsStage';

afterEach(cleanup);

function renderResults(
  snapshot: BattleSnapshot,
  patch: Partial<SoloState> = {},
): ReturnType<typeof render> {
  const state: SoloState = {
    ...INITIAL_SOLO_STATE,
    stage: 'battle',
    battleId: BATTLE,
    snapshot,
    reveal: { status: 'unavailable', build: null },
    ...patch,
  };
  return render(
    createElement(ResultsStage, {
      controller: {} as SoloController,
      state,
      remaining: 42_000,
    }),
  );
}

function shipped(capture: 'pending' | 'captured' | 'fallback' | 'failed'): BattleSnapshot {
  const snap = snapshotAt('results', { version: 5, endsInMs: 42_000, status: 'shipped', capture });
  const build = snap.builds[0];
  if (!build) throw new Error('fixture');
  build.name = 'Snack Overflow';
  build.completion_ms = 83_400;
  build.screenshot_path =
    capture === 'captured' || capture === 'fallback' ? `${BATTLE}/${BUILD_ID}.webp` : null;
  snap.awards = [{ build_id: BUILD_ID, award: 'speedrun', source: 'auto', votes: null }];
  return snap;
}

describe('ResultsStage', () => {
  it('captured: the public screenshot, completion time, award and last-look countdown', () => {
    renderResults(shipped('captured'));
    const img = screen.getByTestId('screenshot');
    expect(img.getAttribute('src')).toBe(
      `http://127.0.0.1:54321/storage/v1/object/public/screenshots/${BATTLE}/${BUILD_ID}.webp`,
    );
    expect(img.dataset['capture']).toBe('captured');
    expect(screen.getByTestId('completion-time').textContent).toBe('1:23.4');
    expect(screen.getByTestId('award').dataset['award']).toBe('speedrun');
    expect(screen.getByTestId('last-look').textContent).toContain('self-destructs in 0:42');
  });

  it('fallback: the screenshot is the client thumbnail, and says so', () => {
    renderResults(shipped('fallback'));
    expect(screen.getByTestId('screenshot').dataset['capture']).toBe('fallback');
    expect(screen.getByText(/fallback: the in-browser thumbnail/)).toBeTruthy();
  });

  it('pending and failed: a placeholder with the state', () => {
    renderResults(shipped('pending'));
    expect(screen.getByTestId('screenshot-placeholder').textContent).toBe('Taking the screenshot…');
    cleanup();
    renderResults(shipped('failed'));
    expect(screen.getByTestId('screenshot-placeholder').textContent).toContain(
      'the capture failed',
    );
  });

  it('DNF: nothing was shipped, no screenshot, no time', () => {
    renderResults(snapshotAt('results', { version: 5, endsInMs: 42_000, status: 'dnf' }));
    expect(screen.getByTestId('result-title').textContent).toBe('Did not finish');
    expect(screen.getByTestId('screenshot-placeholder').dataset['capture']).toBe('none');
    expect(screen.queryByTestId('completion-time')).toBeNull();
    expect(screen.getByText('Nothing to show: no build was shipped.')).toBeTruthy();
  });

  it('auto-shipped builds are labelled as such', () => {
    const snap = shipped('captured');
    const build = snap.builds[0];
    if (build) build.status = 'auto_shipped';
    snap.awards = [];
    renderResults(snap);
    expect(screen.getByTestId('build-status-text').textContent).toBe(
      'Auto-shipped at the deadline',
    );
    expect(screen.queryByTestId('award')).toBeNull();
  });
});
