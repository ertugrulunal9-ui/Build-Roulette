// @vitest-environment happy-dom
/**
 * useSoloGame: one controller per mount (StrictMode-safe), state through
 * useSyncExternalStore, tab visibility wired to autosave/resync, disposal on unmount.
 */
import { act, renderHook } from '@testing-library/react';
import { StrictMode, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoloControllerDeps } from './controller';
import { BATTLE, FakeApi, FakeBridge, FakeLocalWorkspaces, snapshotAt } from './test-support';
import { useSoloGame } from './use-solo-game';

let api: FakeApi;
const deps = (): SoloControllerDeps => ({
  api,
  cdnBaseUrl: 'https://pkg.test',
  localWorkspaces: new FakeLocalWorkspaces(),
  clock: { now: () => Date.now(), setTimeout, clearTimeout, random: () => 0 },
});

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
  api = new FakeApi();
  api.snapshot = snapshotAt('building', { endsInMs: 300_000, version: 2 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useSoloGame', () => {
  it('starts on the name entry and re-renders as the controller moves', async () => {
    const { result, unmount } = renderHook(() => useSoloGame(deps, null));
    expect(result.current.state.stage).toBe('name');
    expect(result.current.controller).not.toBeNull();
    await act(async () => {
      await result.current.controller?.start('Otter');
    });
    expect(result.current.state.stage).toBe('battle');
    expect(result.current.state.snapshot?.battle.phase).toBe('building');
    unmount();
  });

  it('opens the battle from the URL', async () => {
    const { result, unmount } = renderHook(() => useSoloGame(deps, BATTLE));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ stage: 'battle', battleId: BATTLE });
    unmount();
  });

  it('autosaves when the tab is hidden and resyncs when it is visible again', async () => {
    const { result, unmount } = renderHook(() => useSoloGame(deps, BATTLE));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.controller?.attachWorkspace(new FakeBridge());
    });
    await act(async () => {
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.uploadsOf('autosave/bundle.js')).toBe(1);
    const polls = api.count('getSnapshot');
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.count('getSnapshot')).toBe(polls + 1);
    unmount();
  });

  it('under StrictMode, the first controller is disposed and only one keeps running', async () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);
    const { result, unmount } = renderHook(() => useSoloGame(deps, BATTLE), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.stage).toBe('battle');
    // Both mounts asked for the snapshot once; afterwards only one controller polls.
    const before = api.count('getSnapshot');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.count('getSnapshot') - before).toBe(1);
    unmount();
  });

  it('unmount disposes the controller: no more calls', async () => {
    const { unmount } = renderHook(() => useSoloGame(deps, BATTLE));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    const n = api.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    setVisibility('hidden');
    expect(api.calls.length).toBe(n);
  });
});
