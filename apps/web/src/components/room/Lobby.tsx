'use client';

/**
 * The lobby: who is here (Presence + last_seen_at), ready-up, the host's controls
 * (max players, kick with confirmation, Start when at least 2 players are ready), the invite
 * link, and the last battle's podium once a battle has ended (rematch = start again).
 */
import { ROOM_LIMITS, isTerminalPhase } from '@br/game';
import Link from 'next/link';
import { useState } from 'react';
import {
  playerCount,
  readyCount,
  type RoomController,
  type RoomState,
} from '../../lib/room/controller';
import type { RoomMember, RoomSnapshot } from '../../lib/room/types';
import { formatCompletion } from '../../lib/solo/format';
import type { BattleSnapshot } from '../../lib/solo/types';
import { useTicker } from '../../lib/solo/use-ticker';
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
          className={`rounded-full px-2 py-0.5 text-[10px] font-black tracking-widest uppercase ${
            m.role === 'player'
              ? 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200'
              : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
          }`}
        >
          {m.role === 'player' ? 'Player' : 'Spectator'}
        </span>
        {m.role === 'player' && m.state === 'active' && (
          <span
            className={`w-20 text-right text-xs font-bold ${
              m.is_ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'
            }`}
          >
            {m.is_ready ? '✓ Ready' : 'Not ready'}
          </span>
        )}
        {me.is_host && !isMe && (
          <button
            type="button"
            data-testid="kick"
            title={`Remove ${m.display_name}`}
            onClick={() => {
              setKickTarget(m);
            }}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-zinc-700 dark:text-red-300 dark:hover:bg-red-950"
          >
            Kick
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="lobby">
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
              <p
                className="text-sm text-zinc-600 dark:text-zinc-400"
                data-testid="waiting-for-host"
              >
                Waiting for <strong>{host?.display_name ?? 'the host'}</strong> to start
                {hadBattle ? ' the rematch' : ' the battle'}… ({ready} ready)
              </p>
            )}
          </div>
        </section>

        {hadBattle && <LastBattle battle={lastBattle} />}

        <section className={`${panel} text-sm text-zinc-600 dark:text-zinc-400`}>
          <h2 className="mb-2 font-bold text-zinc-900 dark:text-zinc-100">How a battle works</h2>
          <ol className="list-inside list-decimal space-y-1">
            <li>The reels pick a BUILD, a RULE, a STYLE and a time limit (5, 10 or 15 min).</li>
            <li>Everyone builds the same challenge in the browser.</li>
            <li>Ship before the clock runs out. Fast ships earn awards.</li>
            <li>Results, a last look, and then every build is destroyed.</li>
          </ol>
        </section>
      </aside>

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
  const ranked = battle.builds
    .filter((b) => b.final_rank !== null)
    .sort((a, b) => (a.final_rank ?? 0) - (b.final_rank ?? 0))
    .slice(0, 3);
  const name = (id: string) => battle.players.find((p) => p.user_id === id)?.display_name ?? '';
  const medals = ['🥇', '🥈', '🥉'];
  return (
    <section className={panel} data-testid="last-battle">
      <h2 className="font-bold">Last battle</h2>
      <p className="mb-3 text-sm text-zinc-500">{battle.challenge.build.text}</p>
      {ranked.length === 0 ? (
        <p className="text-sm text-zinc-500">Nobody shipped.</p>
      ) : (
        <ol className="flex flex-col gap-1.5 text-sm">
          {ranked.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <span aria-hidden="true">{medals[(b.final_rank ?? 1) - 1] ?? '🏅'}</span>
              <span className="min-w-0 flex-1 truncate">
                <strong>{b.name ?? 'Untitled'}</strong> · {name(b.builder_id)}
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
        <Link
          href={`/battles/${battle.battle.id}`}
          className="mt-3 inline-block text-sm font-semibold underline"
          data-testid="last-battle-link"
        >
          Full results →
        </Link>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          It was abandoned (nobody was left), so it has no results page.
        </p>
      )}
    </section>
  );
}
