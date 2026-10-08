'use client';

/**
 * A spectator during SPIN / BUILD / SHIP (a late joiner, or a member over the player
 * limit): the challenge, the countdown and everyone's progress, but no editor. A player
 * on a phone sees the same view with a "building needs a desktop browser" notice. On a
 * desktop the template's packages are warmed into the browser's cache for REVEAL (T-032).
 */
import type { ReactNode } from 'react';
import { useTouchPrimary } from '../../lib/device';
import type { PresenceMap } from '../../lib/room/types';
import { TemplateWarmup } from '../playground/TemplateWarmup';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { ChallengeCards } from '../results/ResultPieces';
import { Countdown } from '../solo/Countdown';
import { ProgressSidebar } from './ProgressSidebar';

interface SpectatorStageProps {
  controller: SoloController;
  state: SoloState;
  presence: PresenceMap;
  code: string;
  headerActions: ReactNode;
  /**
   * A roster player on a phone watches too (building needs a desktop browser): their own
   * notice replaces the spectator text, and the badge says "Player".
   */
  playerNotice?: ReactNode;
}

export function SpectatorStage({
  controller,
  state,
  presence,
  code,
  headerActions,
  playerNotice,
}: SpectatorStageProps) {
  const touch = useTouchPrimary();
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('SpectatorStage needs a snapshot');
  const phase = snapshot.battle.phase;
  return (
    <main
      className="flex min-h-dvh flex-col bg-zinc-50 dark:bg-zinc-950"
      data-testid="spectator-stage"
      data-role={playerNotice ? 'player' : 'spectator'}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-sm font-bold tracking-tight">
          Build Roulette <span className="font-normal text-zinc-500">· Room {code}</span>
        </h1>
        <span className="rounded-full bg-zinc-200 px-2.5 py-0.5 text-xs font-black tracking-widest text-zinc-700 uppercase dark:bg-zinc-800 dark:text-zinc-300">
          {playerNotice ? '📱 Player · watching' : '👀 Spectating'}
        </span>
        {headerActions}
        <div className="ml-auto">
          <Countdown
            getRemaining={() => controller.remainingMs()}
            label={phase === 'shipping' ? 'Grace' : phase === 'spinning' ? 'Spin' : 'Build'}
          />
        </div>
      </header>
      {/* T-032: a spectator runs no BUILD preview; warm React for the REVEAL. */}
      {!touch && <TemplateWarmup />}
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        {playerNotice}
        <ChallengeCards challenge={snapshot.challenge} />
        {!playerNotice && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            You are watching this battle (it started before you joined, or the player slots are
            taken). When it ends, you get a player slot for the rematch if one is free.
          </p>
        )}
        <ProgressSidebar battle={snapshot} presence={presence} layout="grid" />
      </div>
    </main>
  );
}
