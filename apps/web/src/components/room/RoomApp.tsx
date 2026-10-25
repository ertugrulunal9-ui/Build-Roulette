'use client';

/**
 * /r/[code]: the room. Joins on open (a name prompt with a fun default if the profile has
 * none), then the lobby, the battle (the solo stages, driven by the room's sync engine) and
 * back to the lobby for the rematch. Every join error and end state has its own screen.
 */
import { isTerminalPhase, type JoinRoomError } from '@br/game';
import { LockKeyIcon } from '@phosphor-icons/react/dist/csr/LockKey';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import { UsersThreeIcon } from '@phosphor-icons/react/dist/csr/UsersThree';
import { HandWavingIcon } from '@phosphor-icons/react/dist/csr/HandWaving';
import { DiceFiveIcon } from '@phosphor-icons/react/dist/csr/DiceFive';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../lib/i18n/context';
import type { Messages } from '../../lib/i18n/messages/en';
import { indexedDbSites } from '../../lib/site/local-sites';
import { SupabaseRealtime, SupabaseRoomApi } from '../../lib/room/api';
import {
  browserNameStore,
  roomView,
  type RoomController,
  type RoomControllerDeps,
  type RoomState,
} from '../../lib/room/controller';
import { browserEnvironment, type EndReason } from '../../lib/room/sync';
import type { Activity } from '../../lib/room/types';
import { useBattleState, useRoom, useShowState } from '../../lib/room/use-room';
import { SupabaseSoloApi } from '../../lib/solo/api';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { describeError, type GameError } from '../../lib/solo/errors';
import { randomDisplayName } from '../../lib/solo/names';
import { useTicker } from '../../lib/solo/use-ticker';
import { ensureSignedIn, getSupabase } from '../../lib/supabase/browser';
import { useTouchPrimary } from '../../lib/device';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { AppHeader } from '../ui/AppHeader';
import { HowItWorksButton } from '../onboarding/Welcome';
import { BuildStage } from '../solo/BuildStage';
import { DesktopNeeded } from './DesktopNeeded';
import { SpinReels } from '../solo/SpinReels';
import { Lobby } from './Lobby';
import { ProgressSidebar } from './ProgressSidebar';
import { RevealStage } from './RevealStage';
import { RoomResults } from './RoomResults';
import { SpectatorStage } from './SpectatorStage';
import { VoteStage } from './VoteStage';
import { Centered, ConfirmDialog, CopyInvite, ErrorBanner, Toasts } from './pieces';

const smallButton = 'br-leave-button';
export default function RoomApp({ code }: { code: string }) {
  const t = useT();
  const createDeps = useCallback((): RoomControllerDeps => {
    const supabase = getSupabase();
    return {
      api: new SupabaseRoomApi(supabase, ensureSignedIn),
      soloApi: new SupabaseSoloApi(supabase, ensureSignedIn),
      realtime: new SupabaseRealtime(supabase),
      localSites: indexedDbSites,
      nameStore: browserNameStore,
      env: browserEnvironment,
    };
  }, []);
  const { controller, state } = useRoom(code, createDeps);
  const battleState = useBattleState(state.battle);

  // Hiding the tab autosaves the build (docs/03 §3.6), as on /play.
  const battle = state.battle;
  useEffect(() => {
    if (!battle) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') battle.onHidden();
    };
    const onPageHide = () => {
      battle.onHidden();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [battle]);

  const shownCode = state.code ?? code.toUpperCase();
  if (!controller || state.stage === 'starting') {
    return <Centered>{t.room.opening(shownCode)}</Centered>;
  }
  if (state.stage === 'joining') {
    return <Centered>{t.room.joining(shownCode)}</Centered>;
  }
  if (state.stage === 'name') {
    return (
      <NameForm
        code={shownCode}
        initial={state.displayName}
        busy={false}
        error={state.error}
        onJoin={(name) => {
          void controller.join(name);
        }}
      />
    );
  }
  if (state.stage === 'join_error') {
    return (
      <JoinError code={shownCode} error={state.error} onRetry={() => void controller.retry()} />
    );
  }
  if (state.stage === 'ended') {
    return (
      <Ended
        code={shownCode}
        reason={state.ended ?? 'gone'}
        busy={false}
        onRejoin={() => void controller.retry()}
      />
    );
  }

  const room = state.sync.room;
  const view = roomView(room, state.sync.battle, battleState.destroy);
  const overlays = (
    <>
      <Toasts
        toasts={state.toasts}
        onDismiss={(id) => {
          controller.dismissToast(id);
        }}
      />
      {state.actionError && (
        <ErrorBanner
          text={describeError(state.actionError, t)}
          onDismiss={() => {
            controller.dismissActionError();
          }}
        />
      )}
    </>
  );

  if (view === 'loading' || !room) {
    return (
      <>
        <Centered>{t.room.connecting(shownCode)}</Centered>
        {overlays}
      </>
    );
  }

  const running =
    battleState.snapshot !== null && !isTerminalPhase(battleState.snapshot.battle.phase);
  const phase = battleState.snapshot?.battle.phase;
  const leave = (
    <LeaveButton
      controller={controller}
      state={state}
      confirm={running}
      afterShipping={phase === 'reveal' || phase === 'voting' || phase === 'results'}
    />
  );

  if (view === 'battle' && state.battle && battleState.snapshot) {
    return (
      <>
        <BattleView
          controller={controller}
          battle={state.battle}
          battleState={battleState}
          state={state}
          code={room.room.code}
          leave={
            <>
              <Reconnecting state={state} />
              {leave}
            </>
          }
        />
        {overlays}
      </>
    );
  }

  return (
    <>
      <div className="br-room-shell min-h-dvh">
        <RoomHeader state={state} code={room.room.code} leave={leave} />
        <main className="br-room-content">
          <Lobby
            controller={controller}
            state={state}
            room={room}
            lastBattle={
              state.sync.battle?.battle.id === room.room.current_battle_id
                ? state.sync.battle
                : null
            }
          />
        </main>
      </div>
      {overlays}
    </>
  );
}

// ─── Battle ───────────────────────────────────────────────────────────────────────────

function BattleView({
  controller,
  battle,
  battleState,
  state,
  code,
  leave,
}: {
  controller: RoomController;
  battle: SoloController;
  battleState: SoloState;
  state: RoomState;
  code: string;
  leave: ReactNode;
}) {
  const t = useT();
  const snapshot = battleState.snapshot;
  const phase = snapshot?.battle.phase;
  const show = state.show;
  const showState = useShowState(show);
  useTicker(1000, phase !== undefined && !isTerminalPhase(phase));
  // Phones and tablets watch BUILD instead of building (DesktopNeeded), unless asked to.
  const touch = useTouchPrimary();
  const [buildHere, setBuildHere] = useState(false);
  const onActivity = useCallback(
    (a: Activity) => {
      controller.setActivity(a);
    },
    [controller],
  );
  if (!snapshot || !phase) return <Centered>{t.common.loadingBattle}</Centered>;
  const remaining = battle.remainingMs();

  if (phase === 'spinning' || phase === 'building' || phase === 'shipping') {
    const spin =
      phase === 'spinning' && snapshot.battle.phase_started_at && snapshot.battle.phase_ends_at ? (
        <SpinReels
          challenge={snapshot.challenge}
          startedAt={Date.parse(snapshot.battle.phase_started_at)}
          endsAt={Date.parse(snapshot.battle.phase_ends_at)}
          serverNow={() => battle.serverNow()}
          playerName=""
          heading={t.room.spinHeading(code)}
        />
      ) : null;
    const phonePlayer = snapshot.me.is_player && touch && !buildHere;
    if (!snapshot.me.is_player || phonePlayer) {
      return (
        <>
          <SpectatorStage
            controller={battle}
            state={battleState}
            presence={state.sync.presence}
            code={code}
            headerActions={leave}
            playerNotice={
              phonePlayer ? (
                <DesktopNeeded
                  snapshot={snapshot}
                  onBuildHere={() => {
                    setBuildHere(true);
                  }}
                />
              ) : undefined
            }
          />
          {spin}
        </>
      );
    }
    return (
      <>
        <BuildStage
          controller={battle}
          state={battleState}
          remaining={remaining}
          subtitle={t.common.roomCode(code)}
          headerActions={leave}
          sidebar={
            <ProgressSidebar battle={snapshot} presence={state.sync.presence} layout="sidebar" />
          }
          onActivity={onActivity}
          shippedNote={t.room.waitingOthers(
            snapshot.builds.filter((b) => b.status === 'shipped').length,
            snapshot.players.length,
          )}
        />
        {spin}
        {battleState.error && (
          <ErrorBanner
            text={describeError(battleState.error, t)}
            onDismiss={() => {
              battle.dismissError();
            }}
          />
        )}
      </>
    );
  }
  if ((phase === 'reveal' || phase === 'voting') && show) {
    const Stage = phase === 'reveal' ? RevealStage : VoteStage;
    return (
      <Stage
        battle={battle}
        battleState={battleState}
        show={show}
        showState={showState}
        code={code}
        headerActions={leave}
      />
    );
  }
  return (
    <RoomResults state={battleState} remaining={remaining} lostVotes={showState.ballot.lost} />
  );
}

// ─── Chrome ───────────────────────────────────────────────────────────────────────────

function RoomHeader({ state, code, leave }: { state: RoomState; code: string; leave: ReactNode }) {
  const t = useT();
  return (
    <AppHeader
      className="br-room-app-header"
      context={
        <span className="flex flex-col gap-1">
          <span className="text-[10px] font-bold tracking-[0.16em] uppercase">
            {t.room.eyebrow}
          </span>
          <h1
            className="br-room-code font-mono text-2xl font-black tracking-[0.16em]"
            data-testid="room-code"
          >
            {code}
          </h1>
        </span>
      }
      guide={false}
      practice={false}
      actions={
        <>
          <Reconnecting state={state} />
          <HowItWorksButton />
          <CopyInvite code={code} />
          {leave}
        </>
      }
    />
  );
}

/** Shown while the room's Realtime channel is down (the engine polls meanwhile). */
function Reconnecting({ state }: { state: RoomState }) {
  const t = useT();
  if (state.sync.connection !== 'degraded') return null;
  return (
    <span
      role="status"
      className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      data-testid="reconnecting"
    >
      {t.room.reconnecting}
    </span>
  );
}

function LeaveButton({
  controller,
  state,
  confirm,
  afterShipping,
}: {
  controller: RoomController;
  state: RoomState;
  confirm: boolean;
  /** The builds are final (REVEAL, VOTING, RESULTS). */
  afterShipping: boolean;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="leave-room"
        disabled={state.pending.leave}
        onClick={() => {
          if (confirm) setAsking(true);
          else void controller.leave();
        }}
        className={smallButton}
      >
        {t.room.leave}
      </button>
      <ConfirmDialog
        open={asking}
        testId="leave-confirm"
        title={t.room.leaveTitle}
        body={afterShipping ? t.room.leaveAfterShipping : t.room.leaveDuring}
        confirm={t.room.leaveConfirm}
        busy={state.pending.leave}
        onCancel={() => {
          setAsking(false);
        }}
        onConfirm={() => {
          setAsking(false);
          void controller.leave();
        }}
      />
    </>
  );
}

// ─── Join and end screens ─────────────────────────────────────────────────────────────

function NameForm({
  code,
  initial,
  busy,
  error,
  onJoin,
}: {
  code: string;
  initial: string;
  busy: boolean;
  error: GameError | null;
  onJoin: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <Centered testId="room-name-form" className="br-room-entry">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <p className="text-xs font-bold tracking-widest text-zinc-500 uppercase">
          {t.room.invited}
        </p>
        <h1 className="font-mono text-5xl font-black tracking-widest">{code}</h1>
      </header>
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && trimmed.length > 0) onJoin(trimmed);
        }}
      >
        <label htmlFor="display-name" className="text-left text-sm font-semibold">
          {t.common.yourName}
        </label>
        <div className="flex gap-2">
          <input
            id="display-name"
            data-testid="display-name"
            value={name}
            maxLength={24}
            autoComplete="nickname"
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-3 text-lg dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            title={t.common.anotherName}
            aria-label={t.common.anotherName}
            onClick={() => {
              setName(randomDisplayName());
            }}
            className="rounded-lg border border-zinc-300 px-3 text-xl hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <DiceFiveIcon size={22} weight="duotone" aria-hidden="true" />
          </button>
        </div>
        <button
          type="submit"
          data-testid="join-room"
          disabled={busy || trimmed.length === 0}
          className="br-room-entry__action rounded-lg px-5 py-4 text-lg font-black tracking-wide disabled:opacity-50"
        >
          {busy ? t.room.joiningButton : t.room.join}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {describeError(error, t)}
          </p>
        )}
      </form>
      <p className="text-xs text-zinc-500">{t.room.nameFooter}</p>
      <LanguagePicker />
    </Centered>
  );
}

type ShownJoinError = Exclude<JoinRoomError, 'invalid_display_name' | 'name_not_allowed'>;

/**
 * A screen for every `join_room` error (`invalid_display_name` and `name_not_allowed` go
 * back to the name prompt). Typed against @br/game's list, so a new code cannot be forgotten;
 * the words are the catalogs' (`room.joinErrors`).
 */
const JOIN_ERRORS: Record<
  ShownJoinError,
  (m: Messages, code: string, error: GameError | null) => { title: string; text: string }
> = {
  room_not_found: (m, code) => ({
    title: m.room.joinErrors.room_not_found.title,
    text: m.room.joinErrors.room_not_found.text(code),
  }),
  room_closed: (m) => ({
    title: m.room.joinErrors.room_closed.title,
    text: m.room.joinErrors.room_closed.text(),
  }),
  kicked: (m) => ({
    title: m.room.joinErrors.kicked.title,
    text: m.room.joinErrors.kicked.text(),
  }),
  rate_limited: (m, _code, error) => ({
    title: m.room.joinErrors.rate_limited.title,
    text: m.room.joinErrors.rate_limited.text(describeError(error ?? 'rate_limited', m)),
  }),
  room_full: (m) => ({
    title: m.room.joinErrors.room_full.title,
    text: m.room.joinErrors.room_full.text(),
  }),
};

function JoinError({
  code,
  error,
  onRetry,
}: {
  code: string;
  error: GameError | null;
  onRetry: () => void;
}) {
  const t = useT();
  const known =
    error && Object.prototype.hasOwnProperty.call(JOIN_ERRORS, error.code)
      ? JOIN_ERRORS[error.code as ShownJoinError](t, code, error)
      : undefined;
  return (
    <Centered testId="join-error" className="br-room-entry">
      <p className="br-room-entry__icon" aria-hidden="true">
        {error?.code === 'kicked' ? (
          <ProhibitIcon size={42} weight="duotone" />
        ) : error?.code === 'room_full' ? (
          <UsersThreeIcon size={42} weight="duotone" />
        ) : (
          <MagnifyingGlassIcon size={42} weight="duotone" />
        )}
      </p>
      <h1 className="text-3xl font-black tracking-tight" data-code={error?.code ?? 'unknown'}>
        {known?.title ?? t.room.couldNotJoin}
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        {known ? known.text : describeError(error ?? 'unknown', t)}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        {!known && (
          <button
            type="button"
            onClick={onRetry}
            className="br-room-entry__action"
            data-testid="retry-join"
          >
            {t.common.tryAgain}
          </button>
        )}
        <Link href="/" className={known ? 'br-room-entry__action' : 'br-room-entry__secondary'}>
          {t.room.another}
        </Link>
      </div>
      <LanguagePicker />
    </Centered>
  );
}

const ENDED_ICON = {
  kicked: ProhibitIcon,
  left: HandWavingIcon,
  closed: LockKeyIcon,
  gone: MagnifyingGlassIcon,
} satisfies Record<EndReason, typeof MagnifyingGlassIcon>;

function Ended({
  code,
  reason,
  busy,
  onRejoin,
}: {
  code: string;
  reason: EndReason;
  busy: boolean;
  onRejoin: () => void;
}) {
  const t = useT();
  const info = t.room.ended[reason];
  return (
    <Centered testId={reason === 'kicked' ? 'kicked' : 'room-ended'} className="br-room-entry">
      <p className="br-room-entry__icon" aria-hidden="true">
        {(() => {
          const Icon = ENDED_ICON[reason];
          return <Icon size={42} weight="duotone" />;
        })()}
      </p>
      <h1 className="text-3xl font-black tracking-tight" data-reason={reason}>
        {info.title(code)}
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400">{info.text}</p>
      <div className="flex flex-wrap justify-center gap-3">
        {reason === 'left' && (
          <button
            type="button"
            disabled={busy}
            onClick={onRejoin}
            className="br-room-entry__action"
            data-testid="rejoin"
          >
            {t.room.rejoin}
          </button>
        )}
        <Link
          href="/"
          className={reason === 'left' ? 'br-room-entry__secondary' : 'br-room-entry__action'}
        >
          {t.common.home}
        </Link>
      </div>
      <LanguagePicker />
    </Centered>
  );
}
