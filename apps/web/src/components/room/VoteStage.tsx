'use client';

/**
 * VOTE: every player picks one build per category (Best Build, Best Use of the Rule, Best
 * Style, Most Chaotic; the snapshot's `vote_categories`), never their own. Picks can change
 * until the timer ends; a refresh restores them (`get_my_votes`). The room sees how many
 * ballots are complete ("2/3 voted", from `vote_progress`), never who voted for what.
 * Voting ends early when every present player has a complete ballot. Spectators watch the
 * progress but cannot vote.
 */
import type { ReactNode } from 'react';
import type { RevealVoteController, RevealVoteState } from '../../lib/room/reveal-vote';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { describeVoteError } from '../../lib/solo/errors';
import { categoryEmoji } from '../../lib/solo/format';
import type { BattleSnapshot, SnapshotBuild, VoteCategoryInfo } from '../../lib/solo/types';
import { screenshotUrl } from '../../lib/supabase/config';
import { Countdown } from '../solo/Countdown';
import { PlaceholderCard, SHORT_PHASE_LOW_MS } from './RevealStage';

interface VoteStageProps {
  battle: SoloController;
  battleState: SoloState;
  show: RevealVoteController;
  showState: RevealVoteState;
  code: string;
  headerActions: ReactNode;
}

/** The image of a build in the VOTE grid: its screenshot, its thumbnail, or nothing. */
export function buildImage(build: SnapshotBuild, thumb: string | null): string | null {
  const shot =
    build.screenshot_path !== null &&
    (build.capture_status === 'captured' || build.capture_status === 'fallback');
  if (shot && build.screenshot_path) return screenshotUrl(build.screenshot_path);
  return thumb;
}

/** Why this viewer has no ballot, or null when they can vote. */
export function ballotNote(snapshot: BattleSnapshot): string | null {
  if (snapshot.me.can_vote) return null;
  if (!snapshot.me.is_player) {
    return 'You are watching: only the players of this battle vote. The results come next.';
  }
  if (!snapshot.me.is_voter) return 'You cannot vote in this battle.';
  const me = snapshot.players.find((p) => p.user_id === snapshot.me.user_id);
  if (me?.state === 'left') return 'You left the room, so you cannot vote. Join it again to vote.';
  return 'Voting is closed.';
}

export function VoteStage({
  battle,
  battleState,
  show,
  showState,
  code,
  headerActions,
}: VoteStageProps) {
  const snapshot = battleState.snapshot;
  if (!snapshot) throw new Error('VoteStage needs a snapshot');
  const order = snapshot.battle.reveal_order ?? [];
  const builds = order
    .map((id) => snapshot.builds.find((b) => b.id === id))
    .filter((b): b is SnapshotBuild => b !== undefined);
  const categories = snapshot.vote_categories ?? [];
  const progress = snapshot.vote_progress ?? null;
  const ballot = showState.ballot;
  const canVote = snapshot.me.can_vote === true;
  const note = ballotNote(snapshot);
  const picked = categories.filter((c) => ballot.votes[c.slug] !== undefined).length;
  const nameOf = (id: string) =>
    snapshot.players.find((p) => p.user_id === id)?.display_name ?? 'Someone';

  return (
    <main
      className="flex min-h-dvh flex-col bg-zinc-50 dark:bg-zinc-950"
      data-testid="vote-stage"
      data-can-vote={canVote ? 'true' : 'false'}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-sm font-bold tracking-tight">
          Build Roulette <span className="font-normal text-zinc-500">· Room {code}</span>
        </h1>
        <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-black tracking-widest text-white uppercase">
          🗳️ Vote
        </span>
        {headerActions}
        <div className="ml-auto flex items-center gap-3">
          {progress && (
            <VoteProgressBadge voted={progress.voted_count} eligible={progress.eligible_count} />
          )}
          <Countdown
            getRemaining={() => battle.remainingMs()}
            label="Voting"
            lowMs={SHORT_PHASE_LOW_MS}
          />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-3xl font-black tracking-tight">Vote for the best builds</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {canVote
              ? `One pick per category, never your own build. You can change your picks until the timer ends (${String(picked)}/${String(categories.length)} picked).`
              : note}
          </p>
        </div>

        {canVote && ballot.complete && (
          <p
            role="status"
            data-testid="ballot-complete"
            className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 font-semibold text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-100"
          >
            ✓ Ballot complete. Waiting for the others
            {progress
              ? ` (${String(progress.voted_count)}/${String(progress.eligible_count)} voted)`
              : ''}
            . You can still change a pick until the timer ends.
          </p>
        )}
        {!canVote && (
          <p
            className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            data-testid="vote-spectator-note"
          >
            👀 {note}
          </p>
        )}

        {categories.map((cat) => (
          <CategorySection
            key={cat.slug}
            category={cat}
            builds={builds}
            snapshot={snapshot}
            showState={showState}
            canVote={canVote}
            nameOf={nameOf}
            onVote={(buildId) => {
              show.vote(cat.slug, buildId);
            }}
            onDismissError={() => {
              show.dismissVoteError(cat.slug);
            }}
          />
        ))}
      </div>
    </main>
  );
}

export function VoteProgressBadge({ voted, eligible }: { voted: number; eligible: number }) {
  const pct = eligible > 0 ? Math.round((voted / eligible) * 100) : 0;
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-emerald-100 px-3 py-1.5 text-sm font-bold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      data-testid="vote-progress"
      data-voted={voted}
      data-eligible={eligible}
      role="status"
      aria-label={`${String(voted)} of ${String(eligible)} players voted`}
    >
      <span className="tabular-nums">
        {voted}/{eligible} voted
      </span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-emerald-200 dark:bg-emerald-900">
        <span className="block h-full bg-emerald-600" style={{ width: `${String(pct)}%` }} />
      </span>
    </div>
  );
}

function CategorySection({
  category,
  builds,
  snapshot,
  showState,
  canVote,
  nameOf,
  onVote,
  onDismissError,
}: {
  category: VoteCategoryInfo;
  builds: SnapshotBuild[];
  snapshot: BattleSnapshot;
  showState: RevealVoteState;
  canVote: boolean;
  nameOf: (userId: string) => string;
  onVote: (buildId: string) => void;
  onDismissError: () => void;
}) {
  const ballot = showState.ballot;
  const chosen = ballot.votes[category.slug];
  const pending = ballot.pending[category.slug];
  const error = ballot.errors[category.slug];
  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      data-testid="vote-category"
      data-category={category.slug}
      aria-labelledby={`cat-${category.slug}`}
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`cat-${category.slug}`} className="text-xl font-black tracking-tight">
          <span aria-hidden="true">{categoryEmoji(category.slug)}</span> {category.label}
        </h3>
        <p className="text-sm text-zinc-500">{category.description}</p>
        {canVote && (
          <span
            className={`ml-auto text-xs font-bold ${chosen ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}`}
          >
            {pending ? 'Saving…' : chosen ? '✓ Picked' : 'Pick one'}
          </span>
        )}
      </header>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {builds.map((b) => {
          const own = b.builder_id === snapshot.me.user_id;
          const selected = (pending ?? chosen) === b.id;
          const confirmed = chosen === b.id && pending === undefined;
          const image = buildImage(b, showState.thumbs[b.id] ?? null);
          const name = b.name ?? `${nameOf(b.builder_id)}'s build`;
          const body = (
            <>
              <div className="relative aspect-[16/10] overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a Storage URL or an object URL
                  <img
                    src={image}
                    alt={`${name} by ${nameOf(b.builder_id)}`}
                    className="absolute inset-0 h-full w-full object-cover object-top"
                    data-testid="vote-image"
                  />
                ) : (
                  <PlaceholderCard name={name} />
                )}
                {selected && (
                  <span className="absolute top-1.5 right-1.5 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-black text-white shadow">
                    {confirmed ? '✓ Your pick' : 'Saving…'}
                  </span>
                )}
                {own && (
                  <span
                    className="absolute top-1.5 left-1.5 rounded-full bg-zinc-900/80 px-2 py-0.5 text-xs font-black text-white"
                    data-testid="own-build-badge"
                  >
                    Your build
                  </span>
                )}
              </div>
              <p className="mt-1.5 truncate text-sm font-bold">{name}</p>
              <p className="truncate text-xs text-zinc-500">by {nameOf(b.builder_id)}</p>
            </>
          );
          const common = {
            'data-testid': 'vote-option',
            'data-build': b.id,
            'data-own': own ? 'true' : 'false',
            'data-selected': confirmed ? 'true' : 'false',
          };
          return (
            <li key={b.id}>
              {own || !canVote ? (
                <div
                  {...common}
                  className={`rounded-xl border-2 p-2 ${own ? 'border-dashed border-zinc-300 opacity-60 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800'}`}
                  title={own ? 'You cannot vote for your own build' : undefined}
                >
                  {body}
                </div>
              ) : (
                <button
                  type="button"
                  {...common}
                  aria-pressed={confirmed}
                  aria-label={`${category.label}: ${name} by ${nameOf(b.builder_id)}`}
                  onClick={() => {
                    onVote(b.id);
                  }}
                  className={`w-full rounded-xl border-2 p-2 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                    selected
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                      : 'border-zinc-200 hover:border-emerald-300 dark:border-zinc-800'
                  }`}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p
          role="alert"
          data-testid="vote-error"
          data-code={error.code}
          className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/60 dark:text-red-200"
        >
          <span>{describeVoteError(error)}</span>
          <button type="button" onClick={onDismissError} className="font-semibold underline">
            OK
          </button>
        </p>
      )}
    </section>
  );
}
