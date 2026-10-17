'use client';

/**
 * Everyone's progress during BUILD: "building…" until a player's first import, then
 * "imported" (with how many imports) from Presence (at most one update per 15 s per player,
 * T-029), and the shipped badges from `build` events, e.g. "Ada shipped 'Snack Overflow' at
 * 3:12". Players build on their own computers (docs/09), so imports are all the room sees.
 * No database writes: Presence is client-claimed and only decorates; the ship badges are
 * server state.
 */
import { useT } from '../../lib/i18n/context';
import type { PresenceMap } from '../../lib/room/types';
import { formatCountdown } from '../../lib/solo/format';
import type { BattleSnapshot } from '../../lib/solo/types';
import { Avatar, OnlineDot } from './pieces';

interface ProgressSidebarProps {
  battle: BattleSnapshot;
  presence: PresenceMap;
  /** `sidebar`: a column next to the import area; `grid`: cards for spectators. */
  layout: 'sidebar' | 'grid';
}

type RowState = 'shipped' | 'building' | 'left' | 'kicked' | 'disqualified';

export function ProgressSidebar({ battle, presence, layout }: ProgressSidebarProps) {
  const t = useT();
  const words = t.progress;
  const me = battle.me.user_id;
  const shipped = battle.builds.filter((b) => b.status === 'shipped').length;
  const rows = battle.players.map((p) => {
    const build = battle.builds.find((b) => b.builder_id === p.user_id) ?? null;
    const live = presence[p.user_id] ?? null;
    const state: RowState =
      build?.status === 'shipped'
        ? 'shipped'
        : build?.status === 'disqualified'
          ? 'disqualified'
          : p.state === 'kicked'
            ? 'kicked'
            : p.state === 'left'
              ? 'left'
              : 'building';
    return { p, build, live, state };
  });

  const list = (
    <ul
      className={
        layout === 'grid'
          ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4'
          : 'flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible'
      }
    >
      {rows.map(({ p, build, live, state }) => (
        <li
          key={p.user_id}
          data-testid="progress-player"
          data-user={p.user_id}
          data-name={p.display_name}
          data-state={state}
          data-online={live ? 'true' : 'false'}
          data-host={battle.battle.host_id === p.user_id ? 'true' : 'false'}
          className={`flex min-w-52 flex-col gap-1.5 rounded-xl border p-3 text-sm ${
            state === 'shipped'
              ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/50'
              : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
          } ${state === 'left' || state === 'kicked' ? 'opacity-50' : ''}`}
        >
          <div className="flex items-center gap-2">
            <Avatar userId={p.user_id} name={p.display_name} size="sm" />
            <span className="min-w-0 flex-1 truncate font-bold">
              {battle.battle.host_id === p.user_id && (
                <span title={t.common.host} aria-label={t.common.host} data-testid="host-crown">
                  👑{' '}
                </span>
              )}
              {p.display_name}
              {p.user_id === me && (
                <span className="font-normal text-zinc-500"> {t.common.you}</span>
              )}
            </span>
            <OnlineDot online={live !== null} />
          </div>
          {state === 'shipped' && build ? (
            <p
              className="text-xs font-semibold text-emerald-800 dark:text-emerald-300"
              data-testid="shipped-badge"
            >
              {words.shipped(
                build.name ?? '',
                build.completion_ms === null ? null : formatCountdown(build.completion_ms),
              )}
            </p>
          ) : state === 'left' ? (
            <p className="text-xs text-zinc-500">{words.left}</p>
          ) : state === 'kicked' || state === 'disqualified' ? (
            <p className="text-xs text-zinc-500">{words.removed}</p>
          ) : live ? (
            <p
              className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-600 dark:text-zinc-400"
              data-testid="activity"
              data-imported={live.activity.imported ? 'true' : 'false'}
            >
              {live.activity.imported ? (
                <span className="font-semibold text-sky-700 dark:text-sky-300">
                  {words.imported}
                  {live.activity.imports > 1 && (
                    <span className="font-normal"> {words.imports(live.activity.imports)}</span>
                  )}
                </span>
              ) : (
                <span>{words.building}</span>
              )}
              {live.device === 'mobile' && <span title={words.onPhone}>📱</span>}
            </p>
          ) : (
            <p className="text-xs text-zinc-500">{words.offline}</p>
          )}
        </li>
      ))}
    </ul>
  );

  if (layout === 'grid') return <div data-testid="progress-sidebar">{list}</div>;
  return (
    <aside
      data-testid="progress-sidebar"
      aria-label={words.players}
      className="flex shrink-0 flex-col gap-2 border-t border-zinc-200 bg-zinc-50 p-3 lg:w-72 lg:overflow-y-auto lg:border-t-0 lg:border-l dark:border-zinc-800 dark:bg-zinc-950"
    >
      <p className="text-xs font-bold tracking-widest text-zinc-500 uppercase">
        {words.header(shipped, battle.players.length)}
      </p>
      {list}
    </aside>
  );
}
