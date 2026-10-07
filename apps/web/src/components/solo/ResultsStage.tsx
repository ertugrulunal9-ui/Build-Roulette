'use client';

/**
 * RESULTS → DESTROY. Left: the permanent result (screenshot from the capture worker, the
 * completion time, the auto-awards, the challenge). Right: the last look at the live build
 * until DESTROY, then the destroy moment, and links to the permanent page and a new game.
 */
import Link from 'next/link';
import { myBuild, type SoloController, type SoloState } from '../../lib/solo/controller';
import {
  CAPTURE_TEXT,
  STATUS_TEXT,
  formatCompletion,
  formatCountdown,
} from '../../lib/solo/format';
import { screenshotUrl } from '../../lib/supabase/config';
import { AwardBadges, ChallengeCards } from '../results/ResultPieces';
import { RevealPane } from './RevealPane';

interface ResultsStageProps {
  controller: SoloController;
  state: SoloState;
  remaining: number | null;
}

export function ResultsStage({ controller, state, remaining }: ResultsStageProps) {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('ResultsStage needs a snapshot');
  const battle = snapshot.battle;
  const mine = myBuild(snapshot);
  const awards = snapshot.awards.filter((a) => a.build_id === mine?.id);
  const name = snapshot.players.find((p) => p.user_id === mine?.builder_id)?.display_name ?? '';
  const shipped = mine?.status === 'shipped' || mine?.status === 'auto_shipped';
  const destroyed = battle.phase === 'destroyed' || battle.phase === 'abandoned';
  const capture = mine?.capture_status ?? 'pending';

  const caption = destroyed
    ? state.destroy === 'animating'
      ? 'Destroying the build…'
      : 'Build destroyed'
    : remaining !== null && remaining > 0
      ? `Last look · this build self-destructs in ${formatCountdown(remaining)}`
      : capture === 'pending' && shipped
        ? 'Last look · destroying it as soon as the screenshot is done…'
        : 'Last look · destroying…';

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8"
      data-testid="results"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold tracking-widest text-zinc-500 uppercase">
            {destroyed ? 'Destroy build' : 'Results'}
          </p>
          <h1 className="text-4xl font-black tracking-tight" data-testid="result-title">
            {mine?.name ?? (mine?.status === 'dnf' ? 'Did not finish' : 'Your build')}
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            by {name} ·{' '}
            <span data-testid="build-status-text">{STATUS_TEXT[mine?.status ?? 'dnf']}</span>
            {mine?.completion_ms !== null && mine?.completion_ms !== undefined && shipped && (
              <>
                {' '}
                in{' '}
                <span className="font-mono font-bold" data-testid="completion-time">
                  {formatCompletion(mine.completion_ms)}
                </span>
              </>
            )}
          </p>
        </div>
        <AwardBadges awards={awards} />
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-4">
          <figure className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="relative aspect-[16/10] bg-zinc-100 dark:bg-zinc-800">
              {shipped &&
              mine.screenshot_path &&
              (capture === 'captured' || capture === 'fallback') ? (
                // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
                <img
                  src={screenshotUrl(mine.screenshot_path)}
                  alt={`Screenshot of ${mine.name ?? 'the build'}`}
                  data-testid="screenshot"
                  data-capture={capture}
                  className="absolute inset-0 h-full w-full object-cover object-top"
                />
              ) : (
                <p
                  className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-500"
                  data-testid="screenshot-placeholder"
                  data-capture={shipped ? capture : 'none'}
                >
                  {shipped
                    ? CAPTURE_TEXT[capture]
                    : 'Nothing was shipped, so there is no screenshot.'}
                </p>
              )}
            </div>
            <figcaption className="px-4 py-2 text-xs text-zinc-500">
              {shipped ? CAPTURE_TEXT[capture] : 'Did not finish'}
            </figcaption>
          </figure>
          <ChallengeCards challenge={snapshot.challenge} />
          {mine?.stats.deps && mine.stats.deps.length > 0 && (
            <p className="text-sm text-zinc-500">
              {mine.stats.files ?? 0} files · {mine.stats.lines ?? 0} lines · made with{' '}
              {mine.stats.deps.join(', ')}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <RevealPane
            build={state.reveal.build}
            status={state.reveal.status}
            destroy={state.destroy}
            caption={caption}
          />
          {state.destroy === 'done' && (
            <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="source-status">
                {state.sourceDestroyed
                  ? '✓ Source and bundle deleted from the server.'
                  : 'Deleting the source and bundle from the server…'}
              </p>
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/battles/${battle.id}`}
                  data-testid="permanent-link"
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-bold text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  View the permanent results
                </Link>
                <Link
                  href={`/u/${snapshot.me.user_id}`}
                  data-testid="my-history-link"
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold dark:border-zinc-700"
                >
                  Your battle history
                </Link>
                <button
                  type="button"
                  data-testid="play-again"
                  onClick={() => {
                    controller.playAgain();
                  }}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold dark:border-zinc-700"
                >
                  Play again
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
