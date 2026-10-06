'use client';

/**
 * /r/[code]: the room. Joins on open (a name prompt with a fun default if the profile has
 * none), then the lobby, the battle (the solo stages, driven by the room's sync engine) and
 * back to the lobby for the rematch. Every join error and end state has its own screen.
 */
import { ROOM_LIMITS, isTerminalPhase, type JoinRoomError } from '@br/game';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { playgroundConfig } from '../../lib/playground/config';
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
import { useBattleState, useRoom } from '../../lib/room/use-room';
import { SupabaseSoloApi } from '../../lib/solo/api';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { describeError, type GameError } from '../../lib/solo/errors';
import { indexedDbWorkspaces } from '../../lib/solo/local-workspaces';
import { randomDisplayName } from '../../lib/solo/names';
import { useTicker } from '../../lib/solo/use-ticker';
import { ensureSignedIn, getSupabase } from '../../lib/supabase/browser';
import { BuildStage } from '../solo/BuildStage';
import { SpinReels } from '../solo/SpinReels';
import { Lobby } from './Lobby';
import { ProgressSidebar } from './ProgressSidebar';
import { RoomResults } from './RoomResults';
import { SpectatorStage } from './SpectatorStage';
import { Centered, ConfirmDialog, ErrorBanner, Toasts } from './pieces';

const smallButton =
  'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';
const bigButton =
  'rounded-lg bg-zinc-900 px-5 py-3 font-bold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900';
const outlineButton =
  'rounded-lg border border-zinc-300 px-5 py-3 font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800';

export default function RoomApp({ code }: { code: string }) {
  const createDeps = useCallback((): RoomControllerDeps => {
    const supabase = getSupabase();
    return {
      api: new SupabaseRoomApi(supabase, ensureSignedIn),
      soloApi: new SupabaseSoloApi(supabase, ensureSignedIn),
      realtime: new SupabaseRealtime(supabase),
      cdnBaseUrl: playgroundConfig.cdnBaseUrl,
      localWorkspaces: indexedDbWorkspaces,
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
    return <Centered>Opening room {shownCode}…</Centered>;
  }
  if (state.stage === 'joining') {
    return <Centered>Joining room {shownCode}…</Centered>;
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
          text={describeError(state.actionError)}
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
        <Centered>Connecting to room {shownCode}…</Centered>
        {overlays}
      </>
    );
  }

  const running =
    battleState.snapshot !== null && !isTerminalPhase(battleState.snapshot.battle.phase);
  const leave = <LeaveButton controller={controller} state={state} confirm={running} />;

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
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8">
        <RoomHeader state={state} code={room.room.code} leave={leave} />
        <Lobby
          controller={controller}
          state={state}
          room={room}
          lastBattle={
            state.sync.battle?.battle.id === room.room.current_battle_id ? state.sync.battle : null
          }
        />
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
  const snapshot = battleState.snapshot;
  const phase = snapshot?.battle.phase;
  useTicker(1000, phase !== undefined && !isTerminalPhase(phase));
  const onActivity = useCallback(
    (a: Activity) => {
      controller.setActivity(a);
    },
    [controller],
  );
  if (!snapshot || !phase) return <Centered>Loading the battle…</Centered>;
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
          heading={`Room ${code} · everyone's challenge is…`}
        />
      ) : null;
    if (!snapshot.me.is_player) {
      return (
        <>
          <SpectatorStage
            controller={battle}
            state={battleState}
            presence={state.sync.presence}
            code={code}
            headerActions={leave}
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
          subtitle={`Room ${code}`}
          headerActions={leave}
          sidebar={
            <ProgressSidebar battle={snapshot} presence={state.sync.presence} layout="sidebar" />
          }
          onActivity={onActivity}
          shippedNote={`Waiting for the others (${String(
            snapshot.builds.filter((b) => b.status === 'shipped').length,
          )}/${String(snapshot.players.length)} shipped)…`}
        />
        {spin}
        {battleState.error && (
          <ErrorBanner
            text={describeError(battleState.error)}
            onDismiss={() => {
              battle.dismissError();
            }}
          />
        )}
      </>
    );
  }
  return <RoomResults state={battleState} remaining={remaining} />;
}

// ─── Chrome ───────────────────────────────────────────────────────────────────────────

function RoomHeader({ state, code, leave }: { state: RoomState; code: string; leave: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <p className="text-xs font-bold tracking-widest text-zinc-500 uppercase">Room</p>
        <h1 className="font-mono text-5xl font-black tracking-widest" data-testid="room-code">
          {code}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Reconnecting state={state} />
        <CopyInvite code={code} />
        {leave}
      </div>
    </header>
  );
}

/** Shown while the room's Realtime channel is down (the engine polls meanwhile). */
function Reconnecting({ state }: { state: RoomState }) {
  if (state.sync.connection !== 'degraded') return null;
  return (
    <span
      role="status"
      className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      data-testid="reconnecting"
    >
      Reconnecting…
    </span>
  );
}

function CopyInvite({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(id);
    };
  }, [copied]);
  const link = typeof window === 'undefined' ? `/r/${code}` : `${window.location.origin}/r/${code}`;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white p-1.5 pl-3 dark:border-zinc-800 dark:bg-zinc-900">
      <span className="hidden font-mono text-xs text-zinc-500 sm:inline" data-testid="invite-link">
        {link}
      </span>
      <button
        type="button"
        data-testid="copy-invite"
        onClick={() => {
          void navigator.clipboard.writeText(link).then(
            () => {
              setCopied(true);
            },
            () => {
              window.prompt('Copy the invite link:', link);
            },
          );
        }}
        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-700"
      >
        {copied ? 'Copied!' : 'Copy invite link'}
      </button>
    </div>
  );
}

function LeaveButton({
  controller,
  state,
  confirm,
}: {
  controller: RoomController;
  state: RoomState;
  confirm: boolean;
}) {
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
        Leave room
      </button>
      <ConfirmDialog
        open={asking}
        testId="leave-confirm"
        title="Leave the room?"
        body="The battle goes on without you. If you do not come back, your last autosave ships for you at the deadline."
        confirm="Leave"
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
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <Centered testId="room-name-form">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <p className="text-xs font-bold tracking-widest text-zinc-500 uppercase">
          You are invited to room
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
          Your name
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
            title="Another random name"
            aria-label="Another random name"
            onClick={() => {
              setName(randomDisplayName());
            }}
            className="rounded-lg border border-zinc-300 px-3 text-xl hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            🎲
          </button>
        </div>
        <button
          type="submit"
          data-testid="join-room"
          disabled={busy || trimmed.length === 0}
          className="rounded-lg bg-zinc-900 px-5 py-4 text-lg font-black tracking-wide text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? 'Joining…' : 'Join the room'}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {describeError(error)}
          </p>
        )}
      </form>
      <p className="text-xs text-zinc-500">
        No account needed. Builds are deleted after each battle.
      </p>
    </Centered>
  );
}

/**
 * A screen for every `join_room` error (`invalid_display_name` goes back to the name
 * prompt). Typed against @br/game's list, so a new code cannot be forgotten.
 */
const JOIN_ERRORS: Record<
  Exclude<JoinRoomError, 'invalid_display_name'>,
  { title: string; text: (code: string) => string }
> = {
  room_not_found: {
    title: 'Room not found',
    text: (code) => `No room has the code ${code}. Check the code, or create your own room.`,
  },
  room_closed: {
    title: 'This room is closed',
    text: () => 'Rooms close when everyone has left, or after two hours without a battle.',
  },
  kicked: {
    title: 'You cannot join this room',
    text: () => 'The host removed you from this room, so you cannot come back to it.',
  },
  room_full: {
    title: 'This room is full',
    text: () =>
      `Every player and spectator slot is taken (${String(ROOM_LIMITS.max_players)} players and ${String(ROOM_LIMITS.max_spectators)} spectators).`,
  },
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
  const known =
    error && Object.prototype.hasOwnProperty.call(JOIN_ERRORS, error.code)
      ? JOIN_ERRORS[error.code as keyof typeof JOIN_ERRORS]
      : undefined;
  return (
    <Centered testId="join-error">
      <p className="text-6xl" aria-hidden="true">
        {error?.code === 'kicked' ? '🚫' : error?.code === 'room_full' ? '🈵' : '🔍'}
      </p>
      <h1 className="text-3xl font-black tracking-tight" data-code={error?.code ?? 'unknown'}>
        {known?.title ?? 'Could not join the room'}
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        {known ? known.text(code) : describeError(error ?? 'unknown')}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        {!known && (
          <button type="button" onClick={onRetry} className={bigButton} data-testid="retry-join">
            Try again
          </button>
        )}
        <Link href="/" className={known ? bigButton : outlineButton}>
          Create or join another room
        </Link>
      </div>
    </Centered>
  );
}

const ENDED: Record<EndReason, { icon: string; title: (code: string) => string; text: string }> = {
  kicked: {
    icon: '🚫',
    title: (code) => `You were removed from room ${code}`,
    text: 'The host kicked you, so you cannot rejoin this room. You can always start your own.',
  },
  left: {
    icon: '👋',
    title: (code) => `You left room ${code}`,
    text: 'Changed your mind? You can rejoin while the room is open.',
  },
  closed: {
    icon: '🔒',
    title: (code) => `Room ${code} is closed`,
    text: 'Everyone left, or nobody played for two hours.',
  },
  gone: {
    icon: '🔍',
    title: (code) => `Room ${code} is gone`,
    text: 'This room no longer exists.',
  },
};

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
  const info = ENDED[reason];
  return (
    <Centered testId={reason === 'kicked' ? 'kicked' : 'room-ended'}>
      <p className="text-6xl" aria-hidden="true">
        {info.icon}
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
            className={bigButton}
            data-testid="rejoin"
          >
            Rejoin the room
          </button>
        )}
        <Link href="/" className={reason === 'left' ? outlineButton : bigButton}>
          Home
        </Link>
      </div>
    </Centered>
  );
}
