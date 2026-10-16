'use client';

/**
 * The lobby: who is here (Presence + last_seen_at), ready-up, the host's controls
 * (max players, kick with confirmation, Start when at least 2 players are ready), the invite
 * link, and the last battle's podium once a battle has ended (rematch = start again).
 *
 * Onboarding (T-049): the welcome screen may show here (never once the battle runs: the lobby
 * unmounts), a "New here?" card until it was seen to the end, and a reminder to have the AI
 * tool ready.
 */
import {
  DEFAULT_VOTING_SECONDS,
  REVEAL_SLOT_MAX_SECONDS,
  REVEAL_SLOT_MIN_SECONDS,
  RANDOM_BUILD_TIME_LIMITS_MINUTES,
  ROOM_LIMITS,
  VOTING_MAX_SECONDS,
  VOTING_MIN_SECONDS,
  isTerminalPhase,
} from '@br/game';
import { useState } from 'react';
import { useTouchPrimary } from '../../lib/device';
import {
  playerCount,
  readyCount,
  type RoomController,
  type RoomState,
} from '../../lib/room/controller';
import type {
  RoomMember,
  RoomSettings,
  RoomSettingsPatch,
  RoomSnapshot,
} from '../../lib/room/types';
import { formatCompletion } from '../../lib/solo/format';
import type { BattleSnapshot } from '../../lib/solo/types';
import { useTicker } from '../../lib/solo/use-ticker';
import { openWelcome } from '../../lib/onboarding/welcome';
import { GUIDE_PATH, LOBBY_COPY, NEW_TAB, PHONE_COPY, TRY_PATH } from '../onboarding/copy';
import { Welcome, useWelcomeStatus } from '../onboarding/Welcome';
import { Avatar, ConfirmDialog, OnlineDot, ago } from './pieces';

interface LobbyProps {
  controller: RoomController;
  state: RoomState;
  room: RoomSnapshot;
  /** The last (finished) battle of the room, for the podium. */
  lastBattle: BattleSnapshot | null;
}

const panel =
  'rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';

export function Lobby({ controller, state, room, lastBattle }: LobbyProps) {
  useTicker(5_000); // "last seen" texts
  const [kickTarget, setKickTarget] = useState<RoomMember | null>(null);
  const me = room.me;
  const presence = state.sync.presence;
  const players = room.members.filter((m) => m.role === 'player' && m.state === 'active');
  const spectators = room.members.filter((m) => m.role === 'spectator' && m.state === 'active');
  const away = room.members.filter((m) => m.state !== 'active');
  const ready = readyCount(room);
  const host = room.members.find((m) => m.user_id === room.room.host_id);
  const hadBattle = lastBattle !== null && isTerminalPhase(lastBattle.battle.phase);
  const canStart = me.is_host && ready >= ROOM_LIMITS.min_players && !state.pending.start;
  const touch = useTouchPrimary();
  const welcome = useWelcomeStatus();
  const serverNow = controller.serverNow();

  const onlineOf = (m: RoomMember) => m.user_id in presence;
  const statusOf = (m: RoomMember): string => {
    if (m.state === 'left') return 'left';
    if (onlineOf(m)) return 'online';
    return m.last_seen_at ? `last seen ${ago(serverNow - Date.parse(m.last_seen_at))}` : 'offline';
  };

  const memberRow = (m: RoomMember) => {
    const isMe = m.user_id === me.user_id;
    return (
      <li
        key={m.user_id}
        data-testid="member"
        data-user={m.user_id}
        data-name={m.display_name}
        data-online={onlineOf(m) ? 'true' : 'false'}
        data-role={m.role}
        data-ready={m.is_ready ? 'true' : 'false'}
        data-host={m.is_host ? 'true' : 'false'}
        className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        <Avatar userId={m.user_id} name={m.display_name} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-semibold">
            {m.is_host && (
              <span title="Host" aria-label="Host" data-testid="host-crown">
                👑
              </span>
            )}
            <span className="truncate">{m.display_name}</span>
            {isMe && <span className="text-xs font-normal text-zinc-500">(you)</span>}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <OnlineDot online={onlineOf(m)} />
            <span data-testid="member-status">{statusOf(m)}</span>
          </p>
        </div>
        <span
          data-testid="role-badge"
          className={`hidden rounded-full px-2 sm:inline py-0.5 text-[10px] font-black tracking-widest uppercase ${
            m.role === 'player'
              ? 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200'
              : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
          }`}
        >
          {m.role === 'player' ? 'Player' : 'Spectator'}
        </span>
        {m.role === 'player' && m.state === 'active' && (
          <span
            className={`w-16 shrink-0 text-right text-xs font-bold sm:w-20 ${
              m.is_ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'
            }`}
          >
            {m.is_ready ? '✓ Ready' : 'Not ready'}
          </span>
        )}
        {me.is_host &&
          (isMe ? (
            <span className="w-12" aria-hidden="true" />
          ) : (
            <button
              type="button"
              data-testid="kick"
              title={`Remove ${m.display_name}`}
              onClick={() => {
                setKickTarget(m);
              }}
              className="w-12 rounded-md border border-zinc-300 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-zinc-700 dark:text-red-300 dark:hover:bg-red-950"
            >
              Kick
            </button>
          ))}
      </li>
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="lobby">
      <section className={panel}>
        <header className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-black tracking-tight">Players</h2>
          <p className="text-sm font-semibold text-zinc-500" data-testid="player-count">
            {players.length}/{room.room.max_players} players
          </p>
        </header>
        <ul className="flex flex-col gap-1" aria-label="Players">
          {players.map(memberRow)}
        </ul>
        {spectators.length > 0 && (
          <>
            <h3 className="mt-5 mb-2 text-sm font-bold tracking-wide text-zinc-500 uppercase">
              Spectators ({spectators.length}/{room.room.max_spectators})
            </h3>
            <ul className="flex flex-col gap-1" aria-label="Spectators">
              {spectators.map(memberRow)}
            </ul>
          </>
        )}
        {away.length > 0 && (
          <>
            <h3 className="mt-5 mb-2 text-sm font-bold tracking-wide text-zinc-500 uppercase">
              Left the room
            </h3>
            <ul className="flex flex-col gap-1 opacity-60" aria-label="Left the room">
              {away.map(memberRow)}
            </ul>
          </>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        {welcome !== 'done' && (
          <section
            className="flex flex-col gap-2 rounded-2xl border border-sky-200 bg-sky-50 p-5 text-sky-950 shadow-sm dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-50"
            data-testid="new-here"
            aria-labelledby="new-here-title"
          >
            <h2 id="new-here-title" className="text-lg font-black tracking-tight">
              <span aria-hidden="true">👋 </span>
              {LOBBY_COPY.newHereTitle}
            </h2>
            <p className="text-sm">{LOBBY_COPY.newHereText}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="new-here-show"
                aria-haspopup="dialog"
                onClick={openWelcome}
                className="min-h-10 rounded-lg bg-sky-700 px-4 py-2 text-sm font-bold text-white hover:bg-sky-800 dark:bg-sky-300 dark:text-sky-950 dark:hover:bg-sky-200"
              >
                {LOBBY_COPY.newHereShow}
              </button>
              <a
                href={TRY_PATH}
                target="_blank"
                rel="noopener"
                className="inline-flex min-h-10 items-center rounded-lg border border-sky-300 px-4 py-2 text-sm font-semibold hover:bg-sky-100 dark:border-sky-800 dark:hover:bg-sky-900"
              >
                {LOBBY_COPY.newHerePractice} <span aria-hidden="true">&nbsp;↗</span>
                <span className="sr-only"> {NEW_TAB}</span>
              </a>
            </div>
          </section>
        )}
        <section className={panel}>
          {me.role === 'player' ? (
            <button
              type="button"
              data-testid="ready-toggle"
              aria-pressed={me.is_ready}
              disabled={state.pending.ready}
              onClick={() => {
                void controller.setReady(!me.is_ready);
              }}
              className={`w-full rounded-xl px-5 py-4 text-lg font-black tracking-wide transition disabled:opacity-60 ${
                me.is_ready
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'border-2 border-emerald-600 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950'
              }`}
            >
              {me.is_ready ? '✓ Ready!' : 'Ready up'}
            </button>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="spectator-note">
              You are <strong>spectating</strong>. When a player slot frees up, you get it.
            </p>
          )}
          {me.role === 'player' && !touch && (
            <p
              className="mt-3 text-sm text-zinc-600 dark:text-zinc-400"
              data-testid="build-reminder"
            >
              <span aria-hidden="true">💻 </span>
              {LOBBY_COPY.reminder}
            </p>
          )}

          <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            {me.is_host ? (
              <div className="flex flex-col gap-3" data-testid="host-controls">
                <label className="flex items-center justify-between gap-3 text-sm font-semibold">
                  Max players
                  <select
                    data-testid="max-players"
                    value={room.room.max_players}
                    disabled={state.pending.settings}
                    onChange={(e) => {
                      void controller.setMaxPlayers(Number(e.target.value));
                    }}
                    className="rounded-lg border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    {Array.from(
                      { length: ROOM_LIMITS.max_players - ROOM_LIMITS.min_players + 1 },
                      (_, i) => ROOM_LIMITS.min_players + i,
                    ).map((n) => (
                      <option key={n} value={n} disabled={n < playerCount(room)}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <RevealVoteSettings
                  settings={room.room.settings}
                  disabled={state.pending.settings}
                  onChange={(patch) => {
                    void controller.updateSettings(patch);
                  }}
                />
                <button
                  type="button"
                  data-testid="start-battle"
                  disabled={!canStart}
                  onClick={() => {
                    void controller.start();
                  }}
                  className="rounded-xl bg-zinc-900 px-5 py-4 text-lg font-black tracking-wide text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  {state.pending.start
                    ? 'Spinning up…'
                    : hadBattle
                      ? 'Start the rematch'
                      : 'Start battle'}
                </button>
                <p className="text-xs text-zinc-500" data-testid="ready-summary">
                  {ready} ready ·{' '}
                  {ready >= ROOM_LIMITS.min_players
                    ? 'everyone who is ready and online plays'
                    : `at least ${String(ROOM_LIMITS.min_players)} ready players are needed`}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p
                  className="text-sm text-zinc-600 dark:text-zinc-400"
                  data-testid="waiting-for-host"
                >
                  Waiting for <strong>{host?.display_name ?? 'the host'}</strong> to start
                  {hadBattle ? ' the rematch' : ' the battle'}… ({ready} ready)
                </p>
                <p className="text-xs text-zinc-500" data-testid="settings-summary">
                  {settingsSummary(room.room.settings)}
                </p>
              </div>
            )}
          </div>
          {touch && me.role === 'player' && (
            <p
              className="mt-4 rounded-xl bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-950/60 dark:text-sky-100"
              data-testid="phone-lobby-note"
            >
              📱 On a phone you watch the battle, then play the reveal and the vote. Building needs
              a computer (you build with your own AI tools and import the result): if you play from
              here, your build ends as DNF.{' '}
              <a
                href={GUIDE_PATH}
                target="_blank"
                rel="noopener"
                className="font-semibold underline underline-offset-2"
              >
                {PHONE_COPY.guideLink}
                <span className="sr-only"> {NEW_TAB}</span>
              </a>
            </p>
          )}
          <a
            href={`/u/${me.user_id}`}
            target="_blank"
            className="mt-4 inline-block text-sm font-semibold underline"
            data-testid="my-history-link"
          >
            Your battle history ↗
          </a>
        </section>

        {hadBattle && <LastBattle battle={lastBattle} />}

        <section className={`${panel} text-sm text-zinc-600 dark:text-zinc-400`}>
          <h2 className="mb-2 font-bold text-zinc-900 dark:text-zinc-100">How a battle works</h2>
          <ol className="list-inside list-decimal space-y-1">
            <li>
              The reels pick a BUILD, a RULE, a STYLE and a time limit (
              {RANDOM_BUILD_TIME_LIMITS_MINUTES.join(', ').replace(/, (\d+)$/, ' or $1')} min).
            </li>
            <li>
              Everyone builds the same challenge on their own computer, with their own AI tools, and
              imports the built site.
            </li>
            <li>Ship before the clock runs out. Fast ships earn awards.</li>
            <li>The reveal: everyone watches every build, one at a time.</li>
            <li>Everyone votes in four categories (never for their own build).</li>
            <li>Results by votes, a last look, and then every build is destroyed.</li>
          </ol>
        </section>
      </aside>

      {/* A new tab for its links: leaving this page would leave the room. */}
      <Welcome newTab />

      <ConfirmDialog
        open={kickTarget !== null}
        testId="kick-confirm"
        title={`Kick ${kickTarget?.display_name ?? ''}?`}
        body="They leave the room at once and cannot come back with this code."
        confirm="Kick"
        busy={state.pending.kick !== null}
        onCancel={() => {
          setKickTarget(null);
        }}
        onConfirm={() => {
          const target = kickTarget;
          setKickTarget(null);
          if (target) void controller.kick(target.user_id);
        }}
      />
    </div>
  );
}

function LastBattle({ battle }: { battle: BattleSnapshot }) {
  const abandoned = battle.battle.phase === 'abandoned';
  // An abandoned battle has no ranks: its shipped builds are listed in shipping order.
  const shown = abandoned
    ? battle.builds
        .filter((b) => b.status === 'shipped' || b.status === 'auto_shipped')
        .sort((a, b) => (a.shipped_at ?? '').localeCompare(b.shipped_at ?? ''))
    : battle.builds
        .filter((b) => b.final_rank !== null)
        .sort((a, b) => (a.final_rank ?? 0) - (b.final_rank ?? 0))
        .slice(0, 3);
  const name = (id: string) => battle.players.find((p) => p.user_id === id)?.display_name ?? '';
  const medals = ['🥇', '🥈', '🥉'];
  return (
    <section className={panel} data-testid="last-battle" data-phase={battle.battle.phase}>
      <h2 className="font-bold">Last battle</h2>
      <p className="mb-3 text-sm text-zinc-500">{battle.challenge.build.text}</p>
      {shown.length === 0 ? (
        <p className="text-sm text-zinc-500">Nobody shipped.</p>
      ) : (
        <ol className="flex flex-col gap-1.5 text-sm">
          {shown.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <span aria-hidden="true">
                {abandoned ? '🚀' : (medals[(b.final_rank ?? 1) - 1] ?? '🏅')}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <strong>{b.name ?? `${name(b.builder_id)}'s build`}</strong> · {name(b.builder_id)}
              </span>
              {b.completion_ms !== null && (
                <span className="font-mono text-xs text-zinc-500">
                  {formatCompletion(b.completion_ms)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {battle.battle.phase === 'destroyed' ? (
        <a
          href={`/battles/${battle.battle.id}`}
          className="mt-3 inline-block text-sm font-semibold underline"
          data-testid="last-battle-link"
        >
          Full results →
        </a>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          It was abandoned (nobody was left), so it has no results page.
        </p>
      )}
    </section>
  );
}

// ─── Reveal and vote settings ─────────────────────────────────────────────────────────

/** Choices within the server's ranges (`update_room_settings`; drift-tested in @br/game). */
export const REVEAL_SLOT_CHOICES = [30, 40, 45, 50, 60].filter(
  (s) => s >= REVEAL_SLOT_MIN_SECONDS && s <= REVEAL_SLOT_MAX_SECONDS,
);
export const VOTING_CHOICES = [30, 45, 60, 90, 120, 180].filter(
  (s) => s >= VOTING_MIN_SECONDS && s <= VOTING_MAX_SECONDS,
);

const AUTO_SLOT = `${String(REVEAL_SLOT_MIN_SECONDS)}–${String(REVEAL_SLOT_MAX_SECONDS)} s`;

/** "Reveal and vote on · 45 s per build · 90 s to vote", for everyone in the lobby. */
export function settingsSummary(settings: RoomSettings): string {
  if (settings.reveal_vote === false) {
    return 'Reveal and vote off: results by completion time.';
  }
  const slot =
    typeof settings.reveal_slot_s === 'number'
      ? `${String(settings.reveal_slot_s)} s per build`
      : `${AUTO_SLOT} per build (by the number of builds)`;
  const voting = settings.voting_s ?? DEFAULT_VOTING_SECONDS;
  return `Reveal and vote on · ${slot} · ${String(voting)} s to vote.`;
}

const settingSelect =
  'min-h-9 rounded-lg border border-zinc-300 bg-white px-2 py-1 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950';

/** Host only: REVEAL + VOTE on or off, the reveal slot and the voting time. */
export function RevealVoteSettings({
  settings,
  disabled,
  onChange,
}: {
  settings: RoomSettings;
  disabled: boolean;
  onChange: (patch: RoomSettingsPatch) => void;
}) {
  const on = settings.reveal_vote !== false;
  return (
    <fieldset
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
      data-testid="reveal-vote-settings"
      disabled={disabled}
    >
      <legend className="px-1 text-xs font-bold tracking-wide text-zinc-500 uppercase">
        After the build
      </legend>
      <label className="flex items-center justify-between gap-3 text-sm font-semibold">
        <span>
          Reveal and vote
          <span className="block text-xs font-normal text-zinc-500">
            {on ? 'Everyone watches every build, then votes.' : 'Results by completion time.'}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          data-testid="setting-reveal-vote"
          checked={on}
          onChange={(e) => {
            onChange({ reveal_vote: e.target.checked });
          }}
          className="h-6 w-6 accent-emerald-600"
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm font-semibold">
        Time per build
        <select
          data-testid="setting-reveal-slot"
          value={
            typeof settings.reveal_slot_s === 'number' ? String(settings.reveal_slot_s) : 'auto'
          }
          disabled={!on}
          onChange={(e) => {
            onChange({
              reveal_slot_s: e.target.value === 'auto' ? null : Number(e.target.value),
            });
          }}
          className={settingSelect}
        >
          <option value="auto">Auto ({AUTO_SLOT})</option>
          {REVEAL_SLOT_CHOICES.map((s) => (
            <option key={s} value={s}>
              {s} s
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-3 text-sm font-semibold">
        Voting time
        <select
          data-testid="setting-voting"
          value={String(settings.voting_s ?? DEFAULT_VOTING_SECONDS)}
          disabled={!on}
          onChange={(e) => {
            onChange({ voting_s: Number(e.target.value) });
          }}
          className={settingSelect}
        >
          {VOTING_CHOICES.map((s) => (
            <option key={s} value={s}>
              {s % 60 === 0 ? `${String(s / 60)} min` : `${String(s)} s`}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}
