import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AwardBadges, VoteTally } from '../../../components/results/ResultPieces';
import {
  getPlayerHistory,
  historyHref,
  isUserId,
  parseCursor,
  type HistoryBattle,
} from '../../../lib/history/player-history';
import { formatCompletion, formatTimeLimit } from '../../../lib/solo/format';
import { REMOVED_TEXT, RemovedCard } from '../../../components/moderation/Removed';
import { screenshotUrl } from '../../../lib/supabase/config';

/**
 * A player's history (docs/01 §1.3 `/u/[id]`): their past battles, newest first, from
 * `get_player_history` with the anon key: only permanent data of their own build (the
 * challenge, the build name, rank out of N, the time, awards, the screenshot) and a link
 * to each battle's results page. Only battles in RESULTS or DESTROYED. Paginated with the
 * server's keyset cursor (`?before=…&before_battle=…`).
 *
 * The id is the player's (anonymous) auth user id: clearing the browser's storage loses
 * the way back here, but not the page. Account linking (docs/06 M6) will keep it across
 * devices.
 */

interface PlayerPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string | string[]; before_battle?: string | string[] }>;
}

async function load(props: PlayerPageProps) {
  const { id } = await props.params;
  const cursor = parseCursor(await props.searchParams);
  if (!isUserId(id)) return null;
  const data = await getPlayerHistory(
    id.toLowerCase(),
    cursor?.before ?? null,
    cursor?.before_battle ?? null,
  );
  return data?.player ? { id: id.toLowerCase(), cursor, data, player: data.player } : null;
}

export async function generateMetadata(props: PlayerPageProps): Promise<Metadata> {
  const page = await load(props);
  if (!page) return { title: 'Player not found', robots: { index: false } };
  const { player, data } = page;
  const wins = data.battles.filter((b) => b.build.final_rank === 1).length;
  const title = `${player.display_name}'s battles`;
  const latest = data.battles[0];
  const description = latest
    ? `${player.display_name} on Build Roulette: ${latest.challenge.build.text}${
        latest.build.name ? `, “${latest.build.name}”` : ''
      }${wins > 0 ? ` · ${String(wins)} ${wins === 1 ? 'win' : 'wins'} on this page` : ''}.`
    : `${player.display_name} on Build Roulette.`;
  return {
    title,
    description,
    // Older pages are the same page, further down: one canonical URL.
    alternates: { canonical: `/u/${page.id}` },
    openGraph: { title, description, type: 'profile' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function PlayerPage(props: PlayerPageProps) {
  const page = await load(props);
  if (!page) notFound();
  const { id, cursor, data, player } = page;

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <p className="text-sm font-semibold tracking-widest text-zinc-500 uppercase">
          Player history
        </p>
        <h1 className="text-4xl font-black tracking-tight break-words" data-testid="player-name">
          {player.display_name}
        </h1>
        <p className="text-sm text-zinc-500">
          Finished battles, newest first. Builds are destroyed after each battle; their results and
          screenshots stay.
        </p>
      </header>

      <ol className="flex flex-col gap-5" aria-label="Battles" data-testid="history">
        {data.battles.map((b) => (
          <HistoryItem key={b.battle_id} battle={b} />
        ))}
      </ol>

      <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Pages">
        {cursor ? (
          <Link
            href={historyHref(id, null)}
            className="text-sm font-semibold underline"
            data-testid="history-newest"
          >
            ← Newest battles
          </Link>
        ) : (
          <span />
        )}
        {data.next && (
          <Link
            href={historyHref(id, data.next)}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            data-testid="history-older"
          >
            Older battles →
          </Link>
        )}
      </nav>

      <footer className="border-t border-zinc-200 pt-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
        <p>
          This history belongs to an anonymous player on one browser. Clearing that browser’s data
          loses the way back here (bookmark this page to keep it).
        </p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white hover:bg-emerald-700"
        >
          Play a battle
        </Link>
      </footer>
    </main>
  );
}

const MEDALS = ['🥇', '🥈', '🥉'];

function rankText(b: HistoryBattle): string {
  const { status, final_rank } = b.build;
  if (final_rank !== null) return `#${String(final_rank)} of ${String(b.players_count)}`;
  if (status === 'dnf') return 'Did not finish';
  return 'Unranked';
}

function HistoryItem({ battle: b }: { battle: HistoryBattle }) {
  const shipped = b.build.status === 'shipped' || b.build.status === 'auto_shipped';
  const voted = b.build.votes !== null;
  const winner = b.build.final_rank === 1 && b.players_count > 1;
  const removed = b.build.taken_down === true;
  const name = removed
    ? REMOVED_TEXT
    : (b.build.name ?? (b.build.status === 'dnf' ? 'Did not finish' : `${b.display_name}'s build`));
  return (
    <li
      className={`grid grid-cols-1 overflow-hidden rounded-2xl border bg-white shadow-sm sm:grid-cols-[14rem_minmax(0,1fr)] dark:bg-zinc-900 ${
        winner
          ? 'border-amber-400 ring-2 ring-amber-300/50 dark:border-amber-500'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
      data-testid="history-battle"
      data-battle={b.battle_id}
      data-rank={b.build.final_rank ?? ''}
      data-status={b.build.status}
      data-removed={removed ? 'true' : 'false'}
    >
      <div className="relative aspect-[16/10] bg-zinc-100 sm:aspect-auto dark:bg-zinc-800">
        {removed ? (
          <RemovedCard />
        ) : b.build.screenshot_path ? (
          // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
          <img
            src={screenshotUrl(b.build.screenshot_path)}
            alt={`Screenshot of ${name}`}
            className="absolute inset-0 h-full w-full object-cover object-top"
            data-testid="history-screenshot"
          />
        ) : (
          <p className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-zinc-500">
            {shipped ? 'No screenshot' : 'Nothing was shipped'}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs font-semibold tracking-widest text-zinc-500 uppercase">
            {b.mode === 'solo' ? 'Solo' : 'Room battle'} ·{' '}
            <time dateTime={b.finished_at}>
              {new Date(b.finished_at).toUTCString().replace(' GMT', ' UTC')}
            </time>
          </p>
          <p className="font-mono text-sm font-bold" data-testid="history-rank">
            <span aria-hidden="true">
              {b.build.final_rank !== null ? (MEDALS[b.build.final_rank - 1] ?? '🏅') : '·'}
            </span>{' '}
            {rankText(b)}
          </p>
        </div>
        <h2
          className="text-xl font-black tracking-tight break-words"
          data-testid="history-challenge"
        >
          {b.challenge.build.text}
        </h2>
        <p className="text-xs text-zinc-500">
          RULE: {b.challenge.rule.text} · STYLE: {b.challenge.style.text} ·{' '}
          {formatTimeLimit(b.challenge.time_limit_seconds)}
        </p>
        <p className="text-sm">
          <strong data-testid="history-build-name">{name}</strong>
          {shipped && b.build.completion_ms !== null && (
            <>
              {' '}
              · <span className="font-mono">{formatCompletion(b.build.completion_ms)}</span>
            </>
          )}
          {b.build.status === 'auto_shipped' && (
            <span className="text-zinc-500"> · auto-shipped</span>
          )}
        </p>
        <AwardBadges awards={b.awards.map((a) => ({ ...a, build_id: b.build.id }))} />
        {voted && shipped && (
          <VoteTally votes={b.build.votes} total={b.build.total_votes} compact />
        )}
        <Link
          href={`/battles/${b.battle_id}`}
          className="mt-1 self-start text-sm font-semibold underline"
          data-testid="history-battle-link"
        >
          Full results →
        </Link>
      </div>
    </li>
  );
}
