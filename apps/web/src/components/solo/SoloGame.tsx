'use client';

/**
 * /play: the solo game. Name entry → SPIN → BUILD → (SHIP) → RESULTS → DESTROY, driven by
 * the SoloController from the server's snapshot. `?battle={id}` in the URL resumes a
 * battle after a refresh.
 */
import { isTerminalPhase } from '@br/game';
import { useCallback, useMemo } from 'react';
import { playgroundConfig } from '../../lib/playground/config';
import { SupabaseSoloApi } from '../../lib/solo/api';
import type { SoloControllerDeps } from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';
import { indexedDbWorkspaces } from '../../lib/solo/local-workspaces';
import { useSoloGame } from '../../lib/solo/use-solo-game';
import { useTicker } from '../../lib/solo/use-ticker';
import { ensureSignedIn, getSupabase } from '../../lib/supabase/browser';
import { BuildStage } from './BuildStage';
import { NameEntry, ResumeOffer } from './NameEntry';
import { ResultsStage } from './ResultsStage';
import { SpinReels } from './SpinReels';

function readBattleParam(): string | null {
  const id = new URLSearchParams(window.location.search).get('battle');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
}

function setBattleParam(battleId: string | null): void {
  const url = new URL(window.location.href);
  if (battleId) url.searchParams.set('battle', battleId);
  else url.searchParams.delete('battle');
  window.history.replaceState(window.history.state, '', url);
}

export default function SoloGame() {
  const initialBattle = useMemo(() => readBattleParam(), []);
  const createDeps = useCallback(
    (): SoloControllerDeps => ({
      api: new SupabaseSoloApi(getSupabase(), ensureSignedIn),
      cdnBaseUrl: playgroundConfig.cdnBaseUrl,
      localWorkspaces: indexedDbWorkspaces,
      onBattleChange: setBattleParam,
    }),
    [],
  );
  const { controller, state } = useSoloGame(createDeps, initialBattle);
  const snapshot = state.snapshot;
  const phase = snapshot?.battle.phase;
  // Countdowns re-render four times a second while a battle runs.
  useTicker(250, state.stage === 'battle' && phase !== undefined && !isTerminalPhase(phase));

  if (!controller) {
    return <Centered>Loading…</Centered>;
  }

  if (state.stage === 'name' || state.stage === 'starting') {
    return (
      <NameEntry
        busy={state.stage === 'starting'}
        error={state.error}
        onSpin={(name) => {
          void controller.start(name);
        }}
      />
    );
  }
  if (state.stage === 'resume') {
    return (
      <ResumeOffer
        onResume={() => {
          void controller.resume();
        }}
        onCancel={() => {
          controller.cancelResume();
        }}
      />
    );
  }
  if (state.stage === 'loading' || !snapshot || !phase) {
    return <Centered>Loading the battle…</Centered>;
  }

  const remaining = controller.remainingMs();

  if (phase === 'spinning' || phase === 'building' || phase === 'shipping') {
    if (!snapshot.me.is_player) {
      return <Centered>This battle is still running. Its results will be public soon.</Centered>;
    }
    const me = snapshot.players.find((p) => p.user_id === snapshot.me.user_id);
    return (
      <>
        {/* Mounted during SPIN too, under the reels: preloads the editor and bundler. */}
        <BuildStage controller={controller} state={state} remaining={remaining} />
        {phase === 'spinning' &&
          snapshot.battle.phase_started_at &&
          snapshot.battle.phase_ends_at && (
            <SpinReels
              challenge={snapshot.challenge}
              startedAt={Date.parse(snapshot.battle.phase_started_at)}
              endsAt={Date.parse(snapshot.battle.phase_ends_at)}
              serverNow={() => controller.serverNow()}
              playerName={me?.display_name ?? 'Player'}
            />
          )}
        {state.error && (
          <ErrorBanner
            text={describeError(state.error)}
            onDismiss={() => {
              controller.dismissError();
            }}
          />
        )}
      </>
    );
  }

  return <ResultsStage controller={controller} state={state} remaining={remaining} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid h-dvh place-items-center px-6 text-center text-sm text-zinc-500">
      {children}
    </main>
  );
}

function ErrorBanner({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-4 bg-red-700 px-4 py-2 text-sm text-white"
    >
      <span>{text}</span>
      <button type="button" onClick={onDismiss} className="font-semibold underline">
        Dismiss
      </button>
    </div>
  );
}
