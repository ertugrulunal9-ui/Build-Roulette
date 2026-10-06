import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AwardBadges, ChallengeCards } from '../../../components/results/ResultPieces';
import {
  CAPTURE_TEXT,
  STATUS_TEXT,
  formatCompletion,
  formatTimeLimit,
} from '../../../lib/solo/format';
import { getPublicBattle } from '../../../lib/solo/public-battle';
import { screenshotUrl } from '../../../lib/supabase/config';

/**
 * The permanent, shareable results page (docs/01 §1.3). Server-rendered from
 * `get_public_battle` with the anon key: only permanent data, no code. Rendered per
 * request for now (ISR on the R2 incremental cache is a follow-up, see DEPLOY.md).
 */

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
  return {
    title,
    description,
    openGraph: { title, description, type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function BattlePage({ params }: BattlePageProps) {
  const { id } = await params;
  const data = await getPublicBattle(id);
  if (!data) notFound();
  const { battle, challenge, builds, awards } = data;
  const when = battle.finished_at ?? battle.created_at;

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
        Time limit: {formatTimeLimit(challenge.time_limit_seconds)}
      </p>

      <ol className="flex flex-col gap-6" aria-label="Builds">
        {builds.map((b) => {
          const shipped = b.status === 'shipped' || b.status === 'auto_shipped';
          const buildAwards = awards.filter((a) => a.build_id === b.id);
          return (
            <li
              key={b.id}
              data-testid="public-build"
              className="grid overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm md:grid-cols-[3fr_2fr] dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="relative aspect-[16/10] bg-zinc-100 dark:bg-zinc-800">
                {b.screenshot_path ? (
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
                    {b.name ?? (b.status === 'dnf' ? 'Did not finish' : 'Untitled build')}
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
                {b.stats.deps && b.stats.deps.length > 0 && (
                  <p className="text-sm text-zinc-500">
                    {b.stats.files ?? 0} files · {b.stats.lines ?? 0} lines · made with{' '}
                    {b.stats.deps.join(', ')}
                  </p>
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
      </footer>
    </main>
  );
}
