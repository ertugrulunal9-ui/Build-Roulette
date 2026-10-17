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
import { useT } from '../../lib/i18n/context';
import { en, type Messages } from '../../lib/i18n/messages/en';
import type { RevealVoteController, RevealVoteState } from '../../lib/room/reveal-vote';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { describeVoteError } from '../../lib/solo/errors';
import { categoryDescription, categoryEmoji, categoryLabel } from '../../lib/solo/format';
import type { BattleSnapshot, SnapshotBuild, VoteCategoryInfo } from '../../lib/solo/types';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { Countdown } from '../solo/Countdown';
import { PlaceholderCard, SHORT_PHASE_LOW_MS, buildImage } from './RevealStage';

interface VoteStageProps {
  battle: SoloController;
  battleState: SoloState;
  show: RevealVoteController;
  showState: RevealVoteState;
  code: string;
  headerActions: ReactNode;
}

/** The image of a build in the VOTE grid: its screenshot, its thumbnail, or nothing. */
export { buildImage };

/** Why this viewer has no ballot, or null when they can vote (default English). */
export function ballotNote(snapshot: BattleSnapshot, m: Messages = en): string | null {
  if (snapshot.me.can_vote) return null;
  if (!snapshot.me.is_player) return m.vote.watching;
  if (!snapshot.me.is_voter) return m.vote.cannotVote;
  const me = snapshot.players.find((p) => p.user_id === snapshot.me.user_id);
  if (me?.state === 'left') return m.vote.left;
  return m.vote.closed;
}

export function VoteStage({
  battle,
  battleState,
  show,
  showState,
  code,
  headerActions,
}: VoteStageProps) {
  const t = useT();
  const v = t.vote;
  const snapshot = battleState.snapshot;
  if (!snapshot) throw new Error('VoteStage needs a snapshot');
  const order = snapshot.battle.reveal_order ?? [];
  // A build a moderator took down (T-024) is out of the vote.
  const builds = order
    .map((id) => snapshot.builds.find((b) => b.id === id))
    .filter((b): b is SnapshotBuild => b !== undefined && b.taken_down !== true);
  const categories = snapshot.vote_categories ?? [];
  const progress = snapshot.vote_progress ?? null;
  const ballot = showState.ballot;
  const canVote = snapshot.me.can_vote === true;
  const note = ballotNote(snapshot, t);
  const picked = categories.filter((c) => ballot.votes[c.slug] !== undefined).length;
  const nameOf = (id: string) =>
    snapshot.players.find((p) => p.user_id === id)?.display_name ?? t.common.someone;

  return (
    <main
      className="flex min-h-dvh flex-col bg-zinc-50 dark:bg-zinc-950"
      data-testid="vote-stage"
      data-can-vote={canVote ? 'true' : 'false'}
    >
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
        {/* The header stays on screen while voting: on a phone, only what matters. */}
        <h1 className="hidden text-sm font-bold tracking-tight sm:block">
          Build Roulette{' '}
          <span className="font-normal text-zinc-500">· {t.common.roomCode(code)}</span>
        </h1>
        <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-black tracking-widest text-white uppercase">
          {v.badge}
        </span>
        <LanguagePicker />
        {headerActions}
        <div className="ml-auto flex items-center gap-3">
          {progress && (
            <VoteProgressBadge voted={progress.voted_count} eligible={progress.eligible_count} />
          )}
          <Countdown
            getRemaining={() => battle.remainingMs()}
            label={v.countdown}
            lowMs={SHORT_PHASE_LOW_MS}
          />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-3xl font-black tracking-tight">{v.heading}</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {canVote ? v.intro(picked, categories.length) : note}
          </p>
        </div>

        {canVote && Object.keys(ballot.unsent).length > 0 && (
          <p
            role="alert"
            data-testid="votes-unsent"
            className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100"
          >
            {v.unsent(Object.keys(ballot.unsent).length)}
          </p>
        )}
        {canVote && ballot.complete && (
          <p
            role="status"
            data-testid="ballot-complete"
            className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 font-semibold text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-100"
          >
            {v.complete(progress?.voted_count ?? null, progress?.eligible_count ?? null)}
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
  const v = useT().vote;
  const pct = eligible > 0 ? Math.round((voted / eligible) * 100) : 0;
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-emerald-100 px-3 py-1.5 text-sm font-bold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      data-testid="vote-progress"
      data-voted={voted}
      data-eligible={eligible}
      role="status"
      aria-label={v.progressLabel(voted, eligible)}
    >
      <span className="tabular-nums">{v.progress(voted, eligible)}</span>
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
  const t = useT();
  const v = t.vote;
  const label = categoryLabel(category.slug, t, category.label);
  const ballot = showState.ballot;
  const chosen = ballot.votes[category.slug];
  const pending = ballot.pending[category.slug];
  const unsent = ballot.unsent[category.slug];
  // A pick waiting for the connection already says so (the banner and its badge).
  const error = unsent === undefined ? ballot.errors[category.slug] : undefined;
  const state =
    pending !== undefined
      ? 'saving'
      : unsent !== undefined
        ? 'unsent'
        : chosen !== undefined
          ? 'picked'
          : 'none';
  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm sm:p-4 dark:border-zinc-800 dark:bg-zinc-900"
      data-testid="vote-category"
      data-category={category.slug}
      data-state={state}
      aria-labelledby={`cat-${category.slug}`}
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`cat-${category.slug}`} className="text-xl font-black tracking-tight">
          <span aria-hidden="true">{categoryEmoji(category.slug)}</span> {label}
        </h3>
        <p className="text-sm text-zinc-500">
          {categoryDescription(category.slug, t, category.description)}
        </p>
        {canVote && (
          <span
            className={`ml-auto text-xs font-bold ${
              state === 'unsent'
                ? 'text-amber-700 dark:text-amber-300'
                : chosen
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-zinc-400'
            }`}
            data-testid="category-status"
          >
            {state === 'saving'
              ? v.saving
              : state === 'unsent'
                ? v.unsentStatus
                : state === 'picked'
                  ? v.picked
                  : v.pickOne}
          </span>
        )}
      </header>
      {/* Phones: one build per row (a big tap target); wider screens: a grid of cards. */}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
        {builds.map((b) => {
          const own = b.builder_id === snapshot.me.user_id;
          const shown = pending ?? unsent ?? chosen;
          const selected = shown === b.id;
          const confirmed = chosen === b.id && pending === undefined && unsent === undefined;
          const image = buildImage(b, showState.thumbs[b.id] ?? null);
          const name = b.name ?? t.common.buildOf(nameOf(b.builder_id));
          const badge = confirmed
            ? { text: v.yourPick, tone: 'bg-emerald-600' }
            : pending === b.id
              ? { text: v.saving, tone: 'bg-emerald-600' }
              : { text: v.notSaved, tone: 'bg-amber-600' };
          const body = (
            <div className="flex items-center gap-3 sm:block">
              <div className="relative aspect-[16/10] w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-100 sm:w-auto dark:bg-zinc-800">
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a Storage URL or an object URL
                  <img
                    src={image}
                    alt={v.imageAlt(name, nameOf(b.builder_id))}
                    className="absolute inset-0 h-full w-full object-cover object-top"
                    data-testid="vote-image"
                  />
                ) : (
                  <PlaceholderCard name={name} />
                )}
                {selected && (
                  <span
                    className={`absolute top-1.5 right-1.5 hidden rounded-full px-2 py-0.5 text-xs font-black text-white shadow sm:inline ${badge.tone}`}
                  >
                    {badge.text}
                  </span>
                )}
                {own && (
                  <span
                    className="absolute top-1.5 left-1.5 rounded-full bg-zinc-900/80 px-2 py-0.5 text-xs font-black text-white"
                    data-testid="own-build-badge"
                  >
                    {v.yourBuild}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold sm:mt-1.5 sm:text-sm">{name}</p>
                <p className="truncate text-sm text-zinc-500 sm:text-xs">
                  {t.common.by(nameOf(b.builder_id))}
                </p>
                {selected && (
                  <span
                    className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-black text-white sm:hidden ${badge.tone}`}
                  >
                    {badge.text}
                  </span>
                )}
              </div>
            </div>
          );
          const common = {
            'data-testid': 'vote-option',
            'data-build': b.id,
            'data-own': own ? 'true' : 'false',
            'data-selected': confirmed ? 'true' : 'false',
            'data-unsent': unsent === b.id ? 'true' : 'false',
          };
          return (
            <li key={b.id}>
              {own || !canVote ? (
                <div
                  {...common}
                  className={`rounded-xl border-2 p-2 ${own ? 'border-dashed border-zinc-300 opacity-60 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800'}`}
                  title={own ? v.ownTitle : undefined}
                >
                  {body}
                </div>
              ) : (
                <button
                  type="button"
                  {...common}
                  aria-pressed={confirmed}
                  aria-label={v.optionLabel(label, name, nameOf(b.builder_id))}
                  onClick={() => {
                    onVote(b.id);
                  }}
                  className={`min-h-16 w-full rounded-xl border-2 p-2 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                    selected
                      ? unsent === b.id
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
                        : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
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
          <span>{describeVoteError(error, t)}</span>
          <button type="button" onClick={onDismissError} className="font-semibold underline">
            {t.common.ok}
          </button>
        </p>
      )}
    </section>
  );
}
