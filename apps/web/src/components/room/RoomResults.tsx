'use client';

/**
 * RESULTS → DESTROY for a room battle: every build ranked (rank, name, builder, time,
 * screenshot or its capture state, awards, auto-shipped / DNF badges), and the player's own
 * build in a reveal-mode preview for the last look, until DESTROY. Then the room goes back
 * to the lobby (RoomApp), where the host can start the rematch.
 *
 * With voting (M4) the ranking is by votes (Best Build, then all votes, then the earlier
 * ship): each build shows its votes per category, the category awards come first, and the
 * winner is highlighted. Every category award has one winner, ties broken the same way
 * (T-022), so the Best Build award sits on the rank-1 build.
 *
 * A build a moderator removed after RESULTS (T-028) keeps its rank and its vote counts but
 * has no Winner banner, gold ring, medal or awards; nobody else becomes the winner.
 */
import { isTerminalPhase } from '@br/game';
import { useT } from '../../lib/i18n/context';
import { en, type Messages } from '../../lib/i18n/messages/en';
import { myBuild, type SoloState } from '../../lib/solo/controller';
import {
  awardsOf,
  categoryLabel,
  formatCompletion,
  formatCountdown,
  isWinner,
  rankMedal,
} from '../../lib/solo/format';
import type { BattleSnapshot, SnapshotBuild } from '../../lib/solo/types';
import { screenshotUrl } from '../../lib/supabase/config';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { Rich } from '../i18n/Rich';
import { RemovedCard } from '../moderation/Removed';
import { ReportButton } from '../moderation/ReportButton';
import { AwardBadges, ChallengeCards, VoteTally } from '../results/ResultPieces';
import { RevealPane } from '../solo/RevealPane';

interface RoomResultsProps {
  state: SoloState;
  remaining: number | null;
  /**
   * category → build id of the player's picks that never counted (offline until the vote
   * closed, or a click that arrived just after): RESULTS says so instead of hiding it.
   */
  lostVotes?: Readonly<Record<string, string>>;
}

/**
 * "Not counted: your pick for Best Build (“Snack Overflow”) did not reach the server…", or
 * null, in the catalog's language (default English).
 */
export function lostVotesText(
  snapshot: BattleSnapshot,
  lost: Readonly<Record<string, string>> | undefined,
  m: Messages = en,
): string | null {
  const entries = Object.entries(lost ?? {});
  if (entries.length === 0) return null;
  const label = (slug: string) =>
    categoryLabel(slug, m, snapshot.vote_categories?.find((c) => c.slug === slug)?.label);
  const picks = entries.map(([slug, buildId]) =>
    m.roomResults.lostPick(
      label(slug),
      snapshot.builds.find((b) => b.id === buildId)?.name ?? null,
    ),
  );
  return m.roomResults.lost(picks.length, m.units.andList(picks));
}

const STATUS_BADGE: Partial<
  Record<SnapshotBuild['status'], { text: 'autoShipped' | 'dnf' | 'disqualified'; tone: string }>
> = {
  auto_shipped: {
    text: 'autoShipped',
    tone: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  dnf: { text: 'dnf', tone: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  disqualified: {
    text: 'disqualified',
    tone: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  },
};

export function RoomResults({ state, remaining, lostVotes }: RoomResultsProps) {
  const t = useT();
  const rr = t.roomResults;
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('RoomResults needs a snapshot');
  const destroyed = isTerminalPhase(snapshot.battle.phase);
  const mine = myBuild(snapshot);
  const isPlayer = snapshot.me.is_player;
  const shipped = mine?.status === 'shipped' || mine?.status === 'auto_shipped';
  // The last look runs the player's own final build; without one there is nothing to run
  // (a DNF, e.g. a phone player), so the pane would only take a phone's whole screen. A
  // build a moderator removed is not shown either (T-024).
  const lastLook = isPlayer && shipped && mine.taken_down !== true;
  const pendingCaptures = snapshot.builds.some(
    (b) =>
      (b.status === 'shipped' || b.status === 'auto_shipped') && b.capture_status === 'pending',
  );

  const caption = destroyed
    ? state.destroy === 'animating'
      ? rr.destroying
      : rr.destroyed
    : remaining !== null && remaining > 0
      ? rr.lastLookIn(isPlayer, formatCountdown(remaining))
      : pendingCaptures
        ? rr.lastLookCaptures
        : rr.lastLookDestroying;

  const lost = lostVotesText(snapshot, lostVotes, t);

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8"
      data-testid="results"
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold tracking-widest text-zinc-500 uppercase">
            {destroyed ? t.results.eyebrowDestroy : t.results.eyebrowResults}
          </p>
          <LanguagePicker />
        </div>
        <h1 className="text-3xl font-black tracking-tight break-words sm:text-4xl">
          {snapshot.challenge.build.text}
        </h1>
        <ChallengeCards challenge={snapshot.challenge} compact />
        <p className="text-sm text-zinc-500" data-testid="ranking-rule">
          {votedResults(snapshot) ? rr.rankedVotes : rr.rankedTime}
        </p>
        {lost && (
          <p
            role="alert"
            data-testid="lost-votes"
            className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100"
          >
            ⚠ {lost}
          </p>
        )}
      </header>

      <div
        className={`grid grid-cols-1 gap-6 ${lastLook ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]' : ''}`}
      >
        <section className="flex flex-col gap-3" aria-label={rr.ranking}>
          <RankedBuilds snapshot={snapshot} />
          {!lastLook && (
            <p className="text-sm text-zinc-500" data-testid="last-look">
              {caption}
            </p>
          )}
          {mine && (!shipped || mine.taken_down === true) && (
            <p className="text-sm text-zinc-500" data-testid="no-last-look">
              {mine.taken_down === true
                ? rr.removedMine
                : mine.status === 'disqualified'
                  ? rr.disqualifiedMine
                  : rr.didNotShip}
            </p>
          )}
        </section>
        {lastLook && (
          <section className="flex flex-col gap-3">
            <RevealPane
              battleId={snapshot.battle.id}
              build={state.reveal.build}
              status={state.reveal.status}
              destroy={state.destroy}
              caption={caption}
            />
          </section>
        )}
      </div>
    </main>
  );
}

/** This battle was decided by votes (it had a VOTE stage and the tallies are in). */
export function votedResults(snapshot: BattleSnapshot): boolean {
  return snapshot.builds.some((b) => b.votes !== null && b.votes !== undefined);
}

function RankedBuilds({ snapshot }: { snapshot: BattleSnapshot }) {
  const t = useT();
  const rr = t.roomResults;
  const voted = votedResults(snapshot);
  const builds = [...snapshot.builds].sort((a, b) => {
    const ra = a.final_rank ?? Number.POSITIVE_INFINITY;
    const rb = b.final_rank ?? Number.POSITIVE_INFINITY;
    return ra - rb;
  });
  const nameOf = (id: string) =>
    snapshot.players.find((p) => p.user_id === id)?.display_name ?? t.common.someone;
  return (
    <ol className="flex flex-col gap-3">
      {builds.map((b) => {
        const shipped = b.status === 'shipped' || b.status === 'auto_shipped';
        const removed = b.taken_down === true;
        const isMe = b.builder_id === snapshot.me.user_id;
        const badge = removed ? undefined : STATUS_BADGE[b.status];
        const hasShot =
          shipped &&
          b.screenshot_path !== null &&
          (b.capture_status === 'captured' || b.capture_status === 'fallback');
        const winner = isWinner(b);
        return (
          <li
            key={b.id}
            data-testid="ranked-build"
            data-rank={b.final_rank ?? ''}
            data-status={b.status}
            data-removed={removed ? 'true' : 'false'}
            data-builder={b.builder_id}
            data-capture={shipped ? b.capture_status : 'none'}
            data-winner={winner ? 'true' : 'false'}
            data-total-votes={voted ? b.total_votes : ''}
            className={`relative flex gap-3 rounded-2xl border bg-white p-3 shadow-sm sm:gap-4 dark:bg-zinc-900 ${
              winner
                ? 'border-amber-400 bg-gradient-to-r from-amber-50 to-white ring-4 ring-amber-300/50 dark:border-amber-500 dark:from-amber-950/60 dark:to-zinc-900'
                : isMe
                  ? 'border-sky-400 dark:border-sky-700'
                  : 'border-zinc-200 dark:border-zinc-800'
            }`}
          >
            {winner && (
              <span
                className="absolute -top-3 left-4 rounded-full bg-amber-400 px-3 py-0.5 text-xs font-black tracking-widest text-amber-950 uppercase shadow"
                data-testid="winner-banner"
              >
                {t.common.winner}
              </span>
            )}
            <div className="flex w-8 shrink-0 flex-col items-center justify-center text-center sm:w-10">
              <span className="text-2xl" aria-hidden="true">
                {rankMedal(b)}
              </span>
              <span className="font-mono text-xs font-bold text-zinc-500">
                {b.final_rank !== null ? `#${String(b.final_rank)}` : '–'}
              </span>
            </div>
            <div className="relative aspect-[16/10] w-24 shrink-0 self-start overflow-hidden rounded-lg bg-zinc-100 sm:w-48 sm:self-auto dark:bg-zinc-800">
              {removed ? (
                <RemovedCard compact />
              ) : hasShot && b.screenshot_path ? (
                // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
                <img
                  src={screenshotUrl(b.screenshot_path)}
                  alt={t.common.screenshotOf(b.name ?? t.common.theBuild)}
                  data-testid="build-screenshot"
                  className="absolute inset-0 h-full w-full object-cover object-top"
                />
              ) : (
                <p className="absolute inset-0 grid place-items-center p-2 text-center text-[11px] text-zinc-500">
                  {shipped ? t.capture[b.capture_status] : rr.nothingShipped}
                </p>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p
                className="truncate text-base font-black sm:text-lg"
                data-testid="ranked-build-name"
              >
                {removed
                  ? t.moderation.removed
                  : (b.name ??
                    (b.status === 'dnf'
                      ? t.common.didNotFinish
                      : t.common.buildOf(nameOf(b.builder_id))))}
              </p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                <Rich
                  text={t.reveal.byName}
                  slots={{
                    name: (
                      <a
                        href={`/u/${b.builder_id}`}
                        className="font-bold underline decoration-zinc-300 underline-offset-2 hover:decoration-current dark:decoration-zinc-600"
                        data-testid="player-history-link"
                        // A new tab: the room (and the last look) keeps running here.
                        target="_blank"
                        title={rr.historyTitle(nameOf(b.builder_id))}
                      >
                        {nameOf(b.builder_id)}
                      </a>
                    ),
                  }}
                />
                {isMe && ` ${t.common.you}`}
                {shipped && b.completion_ms !== null && (
                  <>
                    {' '}
                    ·{' '}
                    <span className="font-mono font-bold" data-testid="ranked-build-time">
                      {formatCompletion(b.completion_ms)}
                    </span>
                  </>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {badge && (
                  <span
                    data-testid="status-badge"
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge.tone}`}
                  >
                    {rr[badge.text]}
                  </span>
                )}
                <AwardBadges awards={awardsOf(snapshot.awards, b)} />
                {shipped && !removed && !isMe && (
                  <span className="ml-auto">
                    <ReportButton
                      buildId={b.id}
                      buildLabel={t.common.buildLabel(b.name, nameOf(b.builder_id))}
                    />
                  </span>
                )}
              </div>
              {voted && shipped && <VoteTally votes={b.votes} total={b.total_votes} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
