'use client';

import Link from 'next/link';
import { useI18n } from '../../lib/i18n/context';
import { formatDateTime } from '../../lib/i18n/format';
import { awardsOf, formatCompletion, formatTimeLimit, isWinner } from '../../lib/solo/format';
import type { PublicBattle } from '../../lib/solo/types';
import { statsPhrases } from '../../lib/solo/stats';
import { screenshotUrl } from '../../lib/supabase/config';
import { RemovedCard } from '../moderation/Removed';
import { Rich } from '../i18n/Rich';
import { ReportButton } from '../moderation/ReportButton';
import { MyHistoryLink } from './MyHistoryLink';
import { AwardBadges, ChallengeCards, VoteTally } from './ResultPieces';
import { AppHeader } from '../ui/AppHeader';

/**
 * The permanent, shareable results of a battle (docs/01 §1.3): only permanent data from
 * `get_public_battle`, no code. Rendered by /battles/{id} (BattleView) once the data is in.
 *
 * A build a moderator removed after RESULTS (T-028) keeps its place and rank ("#1 Removed
 * by moderators") and its vote counts, but no Winner banner, gold ring or awards; the next
 * build does not become the winner.
 */
export function BattleResults({ data }: { data: PublicBattle }) {
  const { locale, t } = useI18n();
  const page = t.battlePage;
  const { battle, challenge, builds, awards } = data;
  const when = battle.finished_at ?? battle.created_at;
  const voted = builds.some((b) => b.votes !== null && b.votes !== undefined);

  return (
    <div className="br-public-shell min-h-dvh">
      <AppHeader
        className="br-public-header"
        context={
          <span className="br-public-context">
            {battle.mode === 'solo' ? page.soloEyebrow : page.roomEyebrow}
          </span>
        }
      />
      <main className="br-public-results mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10">
        <header className="flex flex-col gap-2">
          <p className="br-public-date text-sm font-semibold tracking-widest uppercase">
            {battle.mode === 'solo' ? page.soloEyebrow : page.roomEyebrow} ·{' '}
            <time dateTime={when}>{formatDateTime(when, locale)}</time>
          </p>
          <h1 className="text-4xl font-black tracking-tight" data-testid="battle-title">
            {challenge.build.text}
          </h1>
        </header>

        <ChallengeCards challenge={challenge} />
        <p className="br-results-rule -mt-4 text-sm">
          {page.timeLimit(formatTimeLimit(challenge.time_limit_seconds, t))} ·{' '}
          {voted ? page.rankedVotes : page.rankedTime}
        </p>

        <ol className="flex flex-col gap-6" aria-label={page.builds}>
          {builds.map((b) => {
            const shipped = b.status === 'shipped' || b.status === 'auto_shipped';
            const removed = b.taken_down === true;
            const buildAwards = awardsOf(awards, b);
            const winner = isWinner(b);
            const stats = statsPhrases(b.stats, t, locale);
            return (
              <li
                key={b.id}
                data-testid="public-build"
                data-build={b.id}
                data-removed={removed ? 'true' : 'false'}
                data-rank={b.final_rank ?? ''}
                data-winner={winner ? 'true' : 'false'}
                className={`br-public-build relative grid grid-cols-1 overflow-hidden md:grid-cols-[3fr_2fr] ${winner ? 'br-public-build--winner' : ''}`}
              >
                {winner && (
                  <span
                    className="br-public-winner absolute top-3 left-3 z-10 rounded-full px-3 py-0.5 text-xs font-black tracking-widest uppercase shadow"
                    data-testid="public-winner"
                  >
                    {t.common.winner}
                  </span>
                )}
                <div className="br-public-build__image relative aspect-[16/10]">
                  {removed ? (
                    <RemovedCard />
                  ) : b.screenshot_path ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
                    <img
                      src={screenshotUrl(b.screenshot_path)}
                      alt={t.common.screenshotOf(b.name ?? t.common.theBuild)}
                      data-testid="public-screenshot"
                      className="absolute inset-0 h-full w-full object-cover object-top"
                    />
                  ) : (
                    <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-500">
                      {shipped ? t.capture[b.capture_status] : page.nothingShipped}
                    </p>
                  )}
                </div>
                <div className="br-public-build__details flex flex-col justify-center gap-3 p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2
                      className="br-public-build__name text-2xl font-black tracking-tight"
                      data-testid="public-build-name"
                    >
                      {b.final_rank !== null && (
                        <span className="mr-2 text-zinc-400">#{b.final_rank}</span>
                      )}
                      {removed
                        ? t.moderation.removed
                        : (b.name ?? (b.status === 'dnf' ? t.common.didNotFinish : page.untitled))}
                    </h2>
                    {shipped && b.completion_ms !== null && (
                      <p className="font-mono text-lg font-bold" data-testid="public-completion">
                        {formatCompletion(b.completion_ms)}
                      </p>
                    )}
                  </div>
                  <p className="text-zinc-600 dark:text-zinc-400">
                    <Rich
                      text={t.reveal.byName}
                      slots={{ name: <span className="font-semibold">{b.builder_name}</span> }}
                    />{' '}
                    · {t.status[b.status]}
                  </p>
                  <AwardBadges awards={buildAwards} />
                  {voted && shipped && <VoteTally votes={b.votes} total={b.total_votes} />}
                  {stats.length > 0 && (
                    <p className="text-sm text-zinc-500" data-testid="public-build-stats">
                      {stats.join(' · ')}
                    </p>
                  )}
                  {shipped && !removed && (
                    <div className="flex justify-end">
                      <ReportButton
                        buildId={b.id}
                        buildLabel={t.common.buildLabel(b.name, b.builder_name)}
                      />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <footer className="br-public-footer flex flex-col items-center gap-3 border-t pt-6 text-center">
          <p className="text-sm text-zinc-500">
            {battle.destroyed_at ? page.destroyedNote : page.tagline}
          </p>
          <Link href="/play" className="br-primary-link rounded-lg px-5 py-3 text-sm font-semibold">
            {page.playSolo}
          </Link>
          <MyHistoryLink className="text-sm font-semibold underline" />
        </footer>
      </main>
    </div>
  );
}
