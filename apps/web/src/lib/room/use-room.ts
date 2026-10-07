'use client';

/**
 * React binding of the RoomController: created once per mount (StrictMode-safe, like
 * useSoloGame), state through useSyncExternalStore. The battle controller inside is read
 * with useBattleState.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { INITIAL_SOLO_STATE, type SoloController, type SoloState } from '../solo/controller';
import {
  RoomController,
  initialRoomState,
  type RoomControllerDeps,
  type RoomState,
} from './controller';
import {
  initialRevealVoteState,
  type RevealVoteController,
  type RevealVoteState,
} from './reveal-vote';

const noopSubscribe = () => () => undefined;

export interface RoomHandle {
  controller: RoomController | null;
  state: RoomState;
}

export function useRoom(code: string, createDeps: () => RoomControllerDeps): RoomHandle {
  const [controller, setController] = useState<RoomController | null>(null);
  const [initial] = useState(() => initialRoomState(null));

  useEffect(() => {
    const c = new RoomController(code, createDeps());
    // The controller is an external system with its own timers and sockets, created per
    // mount; React learns about it once, here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setController(c);
    void c.init();
    return () => {
      c.dispose();
      setController(null);
    };
    // Created once per mount; the code and the factory are read only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? (() => initial),
    () => initial,
  );
  return { controller, state };
}

const initialSolo = () => INITIAL_SOLO_STATE;
const noShow = initialRevealVoteState('');
const initialShow = () => noShow;

/** The state of the battle's REVEAL / VOTING controller (or an empty one). */
export function useShowState(show: RevealVoteController | null): RevealVoteState {
  return useSyncExternalStore(
    show?.subscribe ?? noopSubscribe,
    show?.getSnapshot ?? initialShow,
    initialShow,
  );
}

/** The state of the room's current battle controller (or the initial state). */
export function useBattleState(battle: SoloController | null): SoloState {
  return useSyncExternalStore(
    battle?.subscribe ?? noopSubscribe,
    battle?.getSnapshot ?? initialSolo,
    initialSolo,
  );
}
