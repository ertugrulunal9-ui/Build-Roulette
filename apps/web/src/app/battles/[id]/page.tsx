import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { REMOVED_TEXT, RemovedCard } from '../../../components/moderation/Removed';
import { ReportButton } from '../../../components/moderation/ReportButton';
import { MyHistoryLink } from '../../../components/results/MyHistoryLink';
import { AwardBadges, ChallengeCards, VoteTally } from '../../../components/results/ResultPieces';
import {
  CAPTURE_TEXT,
  STATUS_TEXT,
  awardsOf,
  formatCompletion,
  formatTimeLimit,
  isWinner,
} from '../../../lib/solo/format';
import { battleOgImage } from '../../../lib/solo/og-image';
import { getPublicBattle } from '../../../lib/solo/public-battle';
import { screenshotUrl } from '../../../lib/supabase/config';

/**
 * The permanent, shareable results page (docs/01 §1.3). Server-rendered from
 * `get_public_battle` with the anon key: only permanent data, no code.
 *
 * ISR (T-026): rendered on the first visit, then served from the cache (the R2 incremental
 * cache on Cloudflare). The page lives as long as its data (`loadPublicBattle`, see
 * lib/cache/policy.ts): seconds while the battle can still change, an hour once it is
 * DESTROYED with `destroyed_at` set; a takedown revalidates it at once (tag `battle:{id}`).
 * `force-static`: the page never reads cookies or headers (the viewer's own history link is
 * a client component), and Next would hand it empty ones anyway, so a cached copy holds
 * nothing about the viewer.
 *
 * A build a moderator removed after RESULTS (T-028) keeps its place and rank ("#1 Removed
 * by moderators") and its vote counts, but no Winner banner, gold ring or awards; the next
 * build does not become the winner.
 *
 * The social image is the rank-1 screenshot or a static card (lib/solo/og-image.ts), not a
 * card drawn per battle: T-033, Workers Free's CPU limit.
 */

export const dynamic = 'force-static';
/**
 * The longest a copy is cached: SETTLED_BATTLE.revalidate, as a literal (Next reads it at
 * build time). Also the lifetime when no `cacheLife` applies.
 */
export const revalidate = 3600;

interface BattlePageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: BattlePageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await getPublicBattle(id);
  if (!data) return { title: 'Battle not found' };
  const top = data.builds[0];
  const title = top?.name
    ? `${top.name} by ${top.builder_name}`
    : `${data.challenge.build.text} · Battle results`;
  const description = `BUILD: ${data.challenge.build.text} · RULE: ${data.challenge.rule.text} · STYLE: ${data.challenge.style.text} · ${formatTimeLimit(data.challenge.time_limit_seconds)}`;
  // An existing image, never one drawn per request (T-033, lib/solo/og-image.ts).
  const image = battleOgImage(data);
  return {
    title,
    description,
    openGraph: { title, description, type: 'article', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function BattlePage({ params }: BattlePageProps) {
  const { id } = await params;
  const data = await getPublicBattle(id);
  if (!data) notFound();
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
