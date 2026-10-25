'use client';

/**
 * A spectator during SPIN / BUILD / SHIP (a late joiner, or a member over the player
 * limit): the challenge, the countdown and everyone's progress, but no import. A player on
 * a phone sees the same view with a "building needs a computer" notice.
 */
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n/context';
import type { PresenceMap } from '../../lib/room/types';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { ChallengeCards } from '../results/ResultPieces';
import { Countdown } from '../solo/Countdown';
import { AppHeader } from '../ui/AppHeader';
import { PhaseTrack } from '../ui/PhaseTrack';
import { CopyInvite } from './pieces';
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
  const t = useT();
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('SpectatorStage needs a snapshot');
  const phase = snapshot.battle.phase;
  return (
    <main
      className="br-room-stage br-spectator-screen flex min-h-dvh flex-col"
      data-testid="spectator-stage"
      data-role={playerNotice ? 'player' : 'spectator'}
    >
      <AppHeader
        compact
        practice={false}
        className="br-phase-header br-phase-header--spectator"
        context={
          <div className="br-phase-context">
            <h1>{t.common.roomCode(code)}</h1>
            <span className="br-phase-pill">{t.phases[phase]}</span>
          </div>
        }
        actions={
          <>
            <span className="br-role-pill">
              {playerNotice ? t.spectator.playerWatching : t.spectator.spectating}
            </span>
            <CopyInvite code={code} />
            {headerActions}
            <Countdown
              getRemaining={() => controller.remainingMs()}
              label={
                phase === 'shipping'
                  ? t.build.countdownGrace
                  : phase === 'spinning'
                    ? t.build.countdownSpin
                    : t.build.countdownBuild
              }
            />
          </>
        }
      />
      <PhaseTrack phase={phase} />
      <div className="br-spectator-content mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        {playerNotice}
        <ChallengeCards challenge={snapshot.challenge} />
        {!playerNotice && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.spectator.note}</p>
        )}
        <ProgressSidebar battle={snapshot} presence={presence} layout="grid" />
      </div>
    </main>
  );
}
