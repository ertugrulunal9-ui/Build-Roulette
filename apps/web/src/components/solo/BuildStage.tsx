'use client';

/**
 * BUILD: the playground's editor and preview (shared WorkspacePanes) under a challenge
 * header with the countdown, autosave state and the Ship button. Mounted already during
 * SPIN, underneath the reels, so CodeMirror, the bundler worker and esbuild.wasm load and
 * the template's first preview is ready when the build starts (docs/03 §3.8 "preloaded").
 *
 * The workspace is a fresh template per battle, stored in IndexedDB under `battle:{id}`
 * (restored from the remote autosave when this device has no copy).
 */
import { useEffect, useState } from 'react';
import { WorkspacePanes } from '../playground/WorkspacePanes';
import { PasteImportDialog } from '../playground/PasteImportDialog';
import { BuildStatusText } from '../playground/BuildStatusText';
import { usePrefersDark } from '../../lib/playground/use-prefers-dark';
import { buildStatus, useWorkspaceSession } from '../../lib/playground/use-workspace-session';
import {
  battleWorkspaceId,
  myBuild,
  type SoloController,
  type SoloState,
} from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';
import { suggestBuildName } from '../../lib/solo/names';
import { CARD_LABEL, cardClass } from '../results/ResultPieces';
import { Countdown, LOW_TIME_MS, timeLevel, type TimeLevel } from './Countdown';
import { ShipDialog } from './ShipDialog';

interface BuildStageProps {
  controller: SoloController;
  state: SoloState;
  /** Time left in the phase (ticks in the parent). */
  remaining: number | null;
}

const headerButton =
  'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

const TOASTS: Partial<Record<TimeLevel, string>> = {
  low: 'One minute left. Ship soon!',
  critical: 'Ten seconds! Ship now or your last autosave ships for you.',
};

function autosaveText(state: SoloState): string {
  const a = state.autosave;
  switch (a.status) {
    case 'saving':
      return 'Autosaving…';
    case 'saved':
      return `Autosaved ${a.lastSavedAt ? new Date(a.lastSavedAt).toLocaleTimeString() : ''}`;
    case 'error':
      return 'Autosave failed (retrying)';
    case 'closed':
      return 'Autosave closed';
    case 'idle':
      return 'Autosaves every 30 s';
  }
}

export function BuildStage({ controller, state, remaining }: BuildStageProps) {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('BuildStage needs a snapshot');
  const battleId = snapshot.battle.id;
  const phase = snapshot.battle.phase;
  const mine = myBuild(snapshot);
  const shipBusy = state.ship.status !== 'idle' && state.ship.status !== 'error';
  const timeUp = phase === 'shipping' || (phase === 'building' && remaining === 0);
  const locked = phase !== 'building' || timeUp || shipBusy || mine?.status !== 'draft';

  const session = useWorkspaceSession(battleWorkspaceId(battleId), {
    restore: () => controller.restoreWorkspace(),
    readOnly: locked,
  });
  const {
    workspace,
    snapshot: sandbox,
    controller: sandboxController,
    apply,
    notice,
    getWorkspace,
    countPaste,
    pasteCount,
    setEditError,
    setActivePath,
  } = session;
  const dark = usePrefersDark();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [shipOpen, setShipOpen] = useState(false);
  const [defaultName] = useState(() => suggestBuildName(snapshot.challenge.build.text));

  // Expose the workspace to the controller (autosave, ship) while mounted.
  useEffect(() => {
    const sc = sandboxController;
    if (!sc) return;
    return controller.attachWorkspace({
      workspace: getWorkspace,
      // The BuildResult itself (same object until the next good build), so an unchanged
      // build is recognised and not autosaved again.
      lastGoodBuild: () => sc.lastGoodBuild(),
      productionBuild: async () => {
        const r = await sc.productionBuild();
        return { ...r, errorCount: r.diagnostics.filter((d) => d.severity === 'error').length };
      },
      thumbnail: (size) => sc.captureThumbnail(size),
      counters: () => ({ rebuilds: sc.buildCount, pastes: pasteCount() }),
    });
  }, [controller, sandboxController, getWorkspace, pasteCount]);

  // Low-time warnings: a banner for 4 s after crossing one minute, and for the last 10 s.
  const level = timeLevel(phase === 'building' ? remaining : null);
  const toast =
    remaining === null || phase !== 'building'
      ? null
      : level === 'critical'
        ? TOASTS.critical
        : level === 'low' && remaining > LOW_TIME_MS - 4000
          ? TOASTS.low
          : null;

  const shipOpenNow = shipOpen || shipBusy || state.ship.status === 'error';

  return (
    <main className="flex h-dvh flex-col bg-zinc-50 dark:bg-zinc-950" data-testid="build-stage">
      <header className="flex flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-sm font-bold tracking-tight">
            Build Roulette <span className="font-normal text-zinc-500">· Solo</span>
          </h1>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setPasteOpen(true);
            }}
            className={headerButton}
          >
            Paste import
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
            <BuildStatusText status={buildStatus(sandbox)} />
            <span
              data-testid="autosave-status"
              data-state={state.autosave.status}
              className="text-zinc-500"
              title={state.autosave.error ? describeError(state.autosave.error) : undefined}
            >
              {autosaveText(state)}
            </span>
            <Countdown
              getRemaining={() => controller.remainingMs()}
              label={phase === 'building' ? 'Build' : 'Grace'}
            />
            <button
              type="button"
              data-testid="ship-button"
              disabled={locked || sandbox.lastBuild === null}
              onClick={() => {
                setShipOpen(true);
              }}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-black tracking-wide text-white shadow disabled:opacity-50"
            >
              Ship it 🚀
            </button>
          </div>
        </div>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="challenge">
          {(['build', 'rule', 'style'] as const).map((k) => (
            <li key={k} className={`rounded-md border-l-4 px-2.5 py-1 ${cardClass(k)}`}>
              <p className="text-sm leading-tight">
                <span className="mr-1.5 text-[10px] font-black tracking-widest opacity-70">
                  {CARD_LABEL[k]}
                </span>
                <span className="font-semibold">{snapshot.challenge[k].text}</span>
              </p>
              {snapshot.challenge[k].hint && (
                <p className="text-[11px] leading-tight opacity-75">{snapshot.challenge[k].hint}</p>
              )}
            </li>
          ))}
        </ul>
      </header>

      {toast && (
        <p
          role="status"
          data-testid="time-toast"
          className={`px-3 py-1.5 text-center text-sm font-bold ${
            level === 'critical' ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-950'
          }`}
        >
          {toast}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {notice}
        </p>
      )}

      {workspace ? (
        <WorkspacePanes
          session={session}
          dark={dark}
          previewOverlay={
            timeUp && mine?.status === 'draft' ? (
              <div
                className="absolute inset-0 z-10 grid place-items-center bg-zinc-950/85 p-6 text-center text-white"
                data-testid="times-up"
              >
                <div className="flex flex-col gap-2">
                  <p className="text-4xl font-black">Time&apos;s up!</p>
                  <p className="text-sm text-zinc-300">
                    {state.autosave.lastSavedAt !== null || state.autosave.status === 'saving'
                      ? 'Your last autosave is being shipped for you…'
                      : 'Wrapping up the battle…'}
                  </p>
                </div>
              </div>
            ) : null
          }
        />
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-zinc-500">
          Loading your workspace…
        </div>
      )}

      {workspace && (
        <PasteImportDialog
          open={pasteOpen}
          workspace={workspace}
          onClose={() => {
            setPasteOpen(false);
          }}
          onImport={(next, paths) => {
            if (apply(() => ({ ok: true, workspace: next })) === null) countPaste();
            setPasteOpen(false);
            setEditError(null);
            const first = paths[0];
            if (first !== undefined) setActivePath(first);
          }}
        />
      )}
      <ShipDialog
        open={shipBusy || (shipOpenNow && !timeUp)}
        defaultName={defaultName}
        ship={state.ship}
        onShip={(name, opts) => {
          void controller.ship(name, opts);
        }}
        onClose={() => {
          setShipOpen(false);
          if (state.ship.status === 'error') controller.clearShipError();
        }}
      />
    </main>
  );
}
