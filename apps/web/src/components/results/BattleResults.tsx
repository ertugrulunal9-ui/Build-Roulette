import Link from 'next/link';
import {
  CAPTURE_TEXT,
  STATUS_TEXT,
  awardsOf,
  formatCompletion,
  formatTimeLimit,
  isWinner,
} from '../../lib/solo/format';
import type { PublicBattle } from '../../lib/solo/types';
import { screenshotUrl } from '../../lib/supabase/config';
import { REMOVED_TEXT, RemovedCard } from '../moderation/Removed';
import { ReportButton } from '../moderation/ReportButton';
import { MyHistoryLink } from './MyHistoryLink';
import { AwardBadges, ChallengeCards, VoteTally } from './ResultPieces';

/**
 * The permanent, shareable results of a battle (docs/01 §1.3): only permanent data from
 * `get_public_battle`, no code. Rendered by /battles/{id} (BattleView) once the data is in.
 *
 * A build a moderator removed after RESULTS (T-028) keeps its place and rank ("#1 Removed
 * by moderators") and its vote counts, but no Winner banner, gold ring or awards; the next
 * build does not become the winner.
 */
export function BattleResults({ data }: { data: PublicBattle }) {
  const { battle, challenge, builds, awards } = data;
  const when = battle.finished_at ?? battle.created_at;
  const voted = builds.some((b) => b.votes !== null && b.votes !== undefined);

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <p className="text-sm font-semibold tracking-widest text-zinc-500 uppercase">
          {battle.mode === 'solo' ? 'Solo battle' : 'Battle'} results ·{' '}
          <time dateTime={when}>{new Date(when).toUTCString().replace(' GMT', ' UTC')}</time>
        </p>
        <h1 className="text-4xl font-black tracking-tight" data-testid="battle-title">
          {challenge.build.text}
        </h1>
      </header>

      <ChallengeCards challenge={challenge} />
      <p className="-mt-4 text-sm text-zinc-500">
        Time limit: {formatTimeLimit(challenge.time_limit_seconds)} ·{' '}
        {voted
          ? 'ranked by the players’ votes (Best Build, then all votes, then the earlier ship); one winner per award category (a tie goes to more votes in all, then the earlier ship)'
          : 'ranked by completion time'}
      </p>

      <ol className="flex flex-col gap-6" aria-label="Builds">
        {builds.map((b) => {
          const shipped = b.status === 'shipped' || b.status === 'auto_shipped';
          const removed = b.taken_down === true;
          const buildAwards = awardsOf(awards, b);
          const winner = isWinner(b);
          return (
            <li
              key={b.id}
              data-testid="public-build"
              data-build={b.id}
              data-removed={removed ? 'true' : 'false'}
              data-rank={b.final_rank ?? ''}
              data-winner={winner ? 'true' : 'false'}
              className={`relative grid grid-cols-1 overflow-hidden rounded-2xl border bg-white shadow-sm md:grid-cols-[3fr_2fr] dark:bg-zinc-900 ${
                winner
                  ? 'border-amber-400 ring-4 ring-amber-300/50 dark:border-amber-500'
                  : 'border-zinc-200 dark:border-zinc-800'
              }`}
            >
              {winner && (
                <span
                  className="absolute top-3 left-3 z-10 rounded-full bg-amber-400 px-3 py-0.5 text-xs font-black tracking-widest text-amber-950 uppercase shadow"
                  data-testid="public-winner"
                >
                  🏆 Winner
                </span>
              )}
              <div className="relative aspect-[16/10] bg-zinc-100 dark:bg-zinc-800">
                {removed ? (
                  <RemovedCard />
                ) : b.screenshot_path ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
                  <img
                    src={screenshotUrl(b.screenshot_path)}
                    alt={`Screenshot of ${b.name ?? 'the build'}`}
                    data-testid="public-screenshot"
                    className="absolute inset-0 h-full w-full object-cover object-top"
                  />
                ) : (
                  <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-500">
                    {shipped ? CAPTURE_TEXT[b.capture_status] : 'Nothing was shipped.'}
                  </p>
                )}
              </div>
              <div className="flex flex-col justify-center gap-3 p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2
                    className="text-2xl font-black tracking-tight"
                    data-testid="public-build-name"
                  >
                    {b.final_rank !== null && (
                      <span className="mr-2 text-zinc-400">#{b.final_rank}</span>
                    )}
                    {removed
                      ? REMOVED_TEXT
                      : (b.name ?? (b.status === 'dnf' ? 'Did not finish' : 'Untitled build'))}
                  </h2>
                  {shipped && b.completion_ms !== null && (
                    <p className="font-mono text-lg font-bold" data-testid="public-completion">
                      {formatCompletion(b.completion_ms)}
                    </p>
                  )}
                </div>
                <p className="text-zinc-600 dark:text-zinc-400">
                  by <span className="font-semibold">{b.builder_name}</span> ·{' '}
                  {STATUS_TEXT[b.status]}
                </p>
                <AwardBadges awards={buildAwards} />
                {voted && shipped && <VoteTally votes={b.votes} total={b.total_votes} />}
                {b.stats.deps && b.stats.deps.length > 0 && (
                  <p className="text-sm text-zinc-500">
                    {b.stats.files ?? 0} files · {b.stats.lines ?? 0} lines · made with{' '}
                    {b.stats.deps.join(', ')}
                  </p>
                )}
                {shipped && !removed && (
                  <div className="flex justify-end">
                    <ReportButton
                      buildId={b.id}
                      buildLabel={`${b.name ? `“${b.name}”` : 'A build'} by ${b.builder_name}`}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="flex flex-col items-center gap-3 border-t border-zinc-200 pt-6 text-center dark:border-zinc-800">
        <p className="text-sm text-zinc-500">
          {battle.destroyed_at
            ? 'The builds were destroyed after the battle. Builds are temporary. Results are permanent.'
            : 'Builds are temporary. Results are permanent.'}
        </p>
        <Link
          href="/play"
          className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          Play solo
        </Link>
        <MyHistoryLink className="text-sm font-semibold underline" />
      </footer>
    </main>
  );
}
