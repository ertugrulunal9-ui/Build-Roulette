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
import { useI18n } from '../../lib/i18n/context';
import { formatClockTime } from '../../lib/i18n/format';
import type { Locale } from '../../lib/i18n/locale';
import type { Messages } from '../../lib/i18n/messages/en';
import type { PreviewController } from '../../lib/preview/preview-controller';
import type { Activity } from '../../lib/room/types';
import { myBuild, type SoloController, type SoloState } from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';
import { formatCountdown } from '../../lib/solo/format';
import { suggestBuildName } from '../../lib/solo/names';
import { ImportHelp } from '../onboarding/ImportHelp';
import { AppHeader } from '../ui/AppHeader';
import { PhaseTrack } from '../ui/PhaseTrack';
import { SiteWorkbench } from '../site/SiteWorkbench';
import { Countdown, LOW_TIME_MS, timeLevel } from './Countdown';
import { ShipDialog } from './ShipDialog';
import './solo-screens.css';

interface BuildStageProps {
  controller: SoloController;
  state: SoloState;
  /** Time left in the phase (ticks in the parent). */
  remaining: number | null;
  /**
   * After "Build Roulette ·" in the header (default: "Solo" in the page's language; a room
   * shows its code).
   */
  subtitle?: ReactNode;
  /** Extra header buttons (a room's "Leave room"). */
  headerActions?: ReactNode;
  /** Shown next to the import area (a room's progress sidebar). */
  sidebar?: ReactNode;
  /** The player's activity for the others (rooms): imported, how many imports. */
  onActivity?: (activity: Activity) => void;
  /** After "Shipped … Your build is locked." (a room: waiting for the others). */
  shippedNote?: ReactNode;
  /** The "How do I import?" help next to the drop zone (default: `ImportHelp`, T-049). */
  importHelp?: ReactNode;
}

function autosaveText(state: SoloState, m: Messages, locale: Locale): string {
  const a = state.autosave;
  const words = m.build.autosave;
  if (state.site === null && a.status === 'idle') {
    return state.restoring ? words.looking : words.nothing;
  }
  switch (a.status) {
    case 'saving':
      return words.saving;
    case 'saved':
      return words.saved(a.lastSavedAt ? formatClockTime(a.lastSavedAt, locale) : '');
    case 'error':
      return words.failed;
    case 'closed':
      return words.closed;
    case 'idle':
      return words.notSaved;
  }
}

export function BuildStage({
  controller,
  state,
  remaining,
  subtitle,
  headerActions,
  sidebar,
  onActivity,
  shippedNote,
  importHelp = <ImportHelp />,
}: BuildStageProps) {
  const { locale, t } = useI18n();
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
        ? t.build.criticalTime
        : level === 'low' && remaining > LOW_TIME_MS - 4000
          ? t.build.lowTime
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
          <div className="br-build-timesup" data-testid="times-up">
            <div className="br-build-timesup__message">
              <p>{t.build.timesUp}</p>
              <span>{state.site !== null ? t.build.shippingForYou : t.build.nothingToShip}</span>
            </div>
          </div>
        ) : null
      }
    />
  );

  return (
    <main className="br-build-page" data-testid="build-stage">
      <AppHeader compact context={subtitle ?? t.build.subtitle} actions={headerActions} />
      <PhaseTrack phase={phase} />
      <header className="br-build-toolbar">
        <div className="br-build-toolbar__title">
          <p className="br-eyebrow">{t.phases[phase]}</p>
          <h1>{t.phases.building}</h1>
        </div>
        <div className="br-build-toolbar__controls">
          <span
            data-testid="autosave-status"
            data-state={state.autosave.status}
            className={`br-build-autosave${state.autosave.status === 'error' ? ' is-error' : ''}`}
            title={state.autosave.error ? describeError(state.autosave.error, t) : undefined}
          >
            {autosaveText(state, t, locale)}
          </span>
          <Countdown
            getRemaining={() => controller.remainingMs()}
            label={phase === 'building' ? t.build.countdownBuild : t.build.countdownGrace}
          />
          <button
            type="button"
            data-testid="ship-button"
            disabled={locked || state.site === null}
            title={state.site === null ? t.build.importFirst : undefined}
            onClick={() => {
              setShipOpen(true);
            }}
            className="br-btn br-btn--primary br-build-ship"
          >
            {t.build.ship}
          </button>
        </div>
        <ul className="br-build-challenges" data-testid="challenge">
          {(['build', 'rule', 'style'] as const).map((k) => (
            <li key={k} className={`br-build-challenge br-build-challenge--${k}`}>
              <p>
                <span>{t.cards[k]}</span>
                <strong>{snapshot.challenge[k].text}</strong>
              </p>
              {snapshot.challenge[k].hint && <p>{snapshot.challenge[k].hint}</p>}
            </li>
          ))}
        </ul>
      </header>

      {toast && (
        <p
          role="status"
          data-testid="time-toast"
          className={`br-build-time-toast${level === 'critical' ? ' is-critical' : ''}`}
        >
          {toast}
        </p>
      )}
      {shipped && (
        <p role="status" data-testid="shipped-banner" className="br-build-shipped">
          {t.build.shipped(
            mine?.name ?? null,
            mine?.completion_ms !== null && mine?.completion_ms !== undefined
              ? formatCountdown(mine.completion_ms)
              : null,
          )}{' '}
          {shippedNote ?? t.build.wrappingUp}
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
