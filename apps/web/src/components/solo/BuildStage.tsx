'use client';

/**
 * BUILD (docs/09 §9.5): the challenge header (the BUILD / RULE / STYLE cards, the countdown,
 * the autosave state and **Ship it**) over the import area (SiteWorkbench): a large drop zone
 * until the player imports the site they built with their own tools, then its live preview.
 * Every good import goes to the battle's controller, which keeps it on this device, uploads it
 * as the autosave and ships it. Mounted already during SPIN, underneath the reels, so the
 * preview's sandbox is connected when the build starts.
 */
import type { ImportedSite } from '@br/site';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PreviewController } from '../../lib/preview/preview-controller';
import type { Activity } from '../../lib/room/types';
import { myBuild, type SoloController, type SoloState } from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';
import { formatCountdown } from '../../lib/solo/format';
import { suggestBuildName } from '../../lib/solo/names';
import { CARD_LABEL, cardClass } from '../results/ResultPieces';
import { SiteWorkbench } from '../site/SiteWorkbench';
import { Countdown, LOW_TIME_MS, timeLevel, type TimeLevel } from './Countdown';
import { ShipDialog } from './ShipDialog';

interface BuildStageProps {
  controller: SoloController;
  state: SoloState;
  /** Time left in the phase (ticks in the parent). */
  remaining: number | null;
  /** After "Build Roulette ·" in the header (default "Solo"; a room shows its code). */
  subtitle?: ReactNode;
  /** Extra header buttons (a room's "Leave room"). */
  headerActions?: ReactNode;
  /** Shown next to the import area (a room's progress sidebar). */
  sidebar?: ReactNode;
  /** The player's activity for the others (rooms): imported, how many imports. */
  onActivity?: (activity: Activity) => void;
  /** After "Shipped … Your build is locked." (a room: waiting for the others). */
  shippedNote?: ReactNode;
  /** The "How do I import?" help next to the drop zone (T-049). */
  importHelp?: ReactNode;
}

const TOASTS: Partial<Record<TimeLevel, string>> = {
  low: 'One minute left. Ship soon!',
  critical: 'Ten seconds! Ship now or your last import ships for you.',
};

function autosaveText(state: SoloState): string {
  const a = state.autosave;
  if (state.site === null && a.status === 'idle') {
    return state.restoring ? 'Looking for your last import…' : 'Nothing imported yet';
  }
  switch (a.status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return `Saved ${a.lastSavedAt ? new Date(a.lastSavedAt).toLocaleTimeString() : ''}`.trim();
    case 'error':
      return 'Save failed, retrying';
    case 'closed':
      return 'Saving closed';
    case 'idle':
      return 'Not saved yet';
  }
}

export function BuildStage({
  controller,
  state,
  remaining,
  subtitle = 'Solo',
  headerActions,
  sidebar,
  onActivity,
  shippedNote = 'Wrapping up the battle…',
  importHelp,
}: BuildStageProps) {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('BuildStage needs a snapshot');
  const battleId = snapshot.battle.id;
  const phase = snapshot.battle.phase;
  const mine = myBuild(snapshot);
  const shipBusy = state.ship.status !== 'idle' && state.ship.status !== 'error';
  /** Shipped: the dialog closes and a banner says so (a room keeps BUILD on screen). */
  const shipped = state.ship.status === 'done' || mine?.status === 'shipped';
  const shipInFlight = shipBusy && !shipped;
  const timeUp = phase === 'shipping' || (phase === 'building' && remaining === 0);
  const locked = phase !== 'building' || timeUp || shipBusy || mine?.status !== 'draft';
  const [shipOpen, setShipOpen] = useState(false);
  const [defaultName] = useState(() => suggestBuildName(snapshot.challenge.build.text));

  // The live preview makes the ship thumbnail while it is mounted.
  const detachPreview = useRef<(() => void) | null>(null);
  const onPreview = useCallback(
    (preview: PreviewController | null) => {
      detachPreview.current?.();
      detachPreview.current = preview
        ? controller.attachPreview({ thumbnail: (size) => preview.captureThumbnail(size) })
        : null;
    },
    [controller],
  );

  const onImported = useCallback(
    (site: ImportedSite) => {
      controller.importSite(site);
    },
    [controller],
  );

  // Rooms: the activity the others see in their progress sidebar (Presence, sent by the sync
  // engine only when it changes, at most every 15 s).
  const imported = state.site !== null;
  const imports = state.imports;
  useEffect(() => {
    onActivity?.({ imported, imports });
  }, [onActivity, imported, imports]);

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

  const shipOpenNow = (shipOpen || shipInFlight || state.ship.status === 'error') && !shipped;

  const workbench = (
    <SiteWorkbench
      site={state.site}
      onImported={onImported}
      battleId={battleId}
      locked={locked}
      restoring={state.restoring}
      onPreview={onPreview}
      help={importHelp}
      overlay={
        timeUp && mine?.status === 'draft' ? (
          <div
            className="absolute inset-0 z-20 grid place-items-center bg-zinc-950/95 p-6 text-center text-white"
            data-testid="times-up"
          >
            <div className="flex flex-col gap-2">
              <p className="text-4xl font-black">Time&apos;s up!</p>
              <p className="text-sm text-zinc-300">
                {state.site !== null
                  ? 'Your last import is being shipped for you…'
                  : 'Nothing was imported, so there is nothing to ship. Wrapping up the battle…'}
              </p>
            </div>
          </div>
        ) : null
      }
    />
  );

  return (
    <main className="flex h-dvh flex-col bg-zinc-50 dark:bg-zinc-950" data-testid="build-stage">
      <header className="flex flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-sm font-bold tracking-tight">
            Build Roulette <span className="font-normal text-zinc-500">· {subtitle}</span>
          </h1>
          {headerActions}
          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
            <span
              data-testid="autosave-status"
              data-state={state.autosave.status}
              className={
                state.autosave.status === 'error'
                  ? 'font-semibold text-red-600 dark:text-red-400'
                  : 'text-zinc-500'
              }
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
              disabled={locked || state.site === null}
              title={state.site === null ? 'Import your built site first' : undefined}
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
      {shipped && (
        <p
          role="status"
          data-testid="shipped-banner"
          className="border-b border-emerald-200 bg-emerald-50 px-3 py-1.5 text-center text-sm font-semibold text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
        >
          🚀 Shipped{mine?.name ? ` “${mine.name}”` : ''}
          {mine?.completion_ms !== null && mine?.completion_ms !== undefined
            ? ` at ${formatCountdown(mine.completion_ms)}`
            : ''}
          . Your build is locked. {shippedNote}
        </p>
      )}

      {sidebar ? (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{workbench}</div>
          {sidebar}
        </div>
      ) : (
        workbench
      )}

      <ShipDialog
        open={shipInFlight || (shipOpenNow && !timeUp)}
        defaultName={defaultName}
        ship={state.ship}
        onShip={(name) => {
          void controller.ship(name);
        }}
        onClose={() => {
          setShipOpen(false);
          if (state.ship.status === 'error') controller.clearShipError();
        }}
      />
    </main>
  );
}
