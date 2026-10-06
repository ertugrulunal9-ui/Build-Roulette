'use client';

/**
 * React binding of the SoloController: creates it once per mount (StrictMode-safe: the
 * effect's cleanup disposes it and the re-run creates a fresh one), exposes its state with
 * useSyncExternalStore, and wires the tab's visibility to autosave and resync.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  INITIAL_SOLO_STATE,
  SoloController,
  type SoloControllerDeps,
  type SoloState,
} from './controller';

const noopSubscribe = () => () => undefined;
const initial = () => INITIAL_SOLO_STATE;

export interface SoloGame {
  /** null until the effect has created the controller (first client render). */
  controller: SoloController | null;
  state: SoloState;
}

export function useSoloGame(
  createDeps: () => SoloControllerDeps,
  initialBattleId: string | null,
): SoloGame {
  const [controller, setController] = useState<SoloController | null>(null);

  useEffect(() => {
    const c = new SoloController(createDeps());
    // The controller is an external system with its own timers, created per mount (so
    // StrictMode's second mount gets a fresh one); React learns about it once, here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setController(c);
    c.init(initialBattleId);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') c.onHidden();
      else c.onVisible();
    };
    const onPageHide = () => {
      c.onHidden();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      c.dispose();
      setController(null);
    };
    // Created once per mount; the factory and the initial id are read only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? initial,
    initial,
  );
  return { controller, state };
}
