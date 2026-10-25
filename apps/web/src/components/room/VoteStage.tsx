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
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { PaletteIcon } from '@phosphor-icons/react/dist/csr/Palette';
import { ScrollIcon } from '@phosphor-icons/react/dist/csr/Scroll';
import { ShuffleIcon } from '@phosphor-icons/react/dist/csr/Shuffle';
import { TrophyIcon } from '@phosphor-icons/react/dist/csr/Trophy';
import { useT } from '../../lib/i18n/context';
import { en, type Messages } from '../../lib/i18n/messages/en';
import type { RevealVoteController, RevealVoteState } from '../../lib/room/reveal-vote';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { describeVoteError } from '../../lib/solo/errors';
import { categoryDescription, categoryLabel } from '../../lib/solo/format';
import type { BattleSnapshot, SnapshotBuild, VoteCategoryInfo } from '../../lib/solo/types';
import { Countdown } from '../solo/Countdown';
import { AppHeader } from '../ui/AppHeader';
import { PhaseTrack } from '../ui/PhaseTrack';
import { PlaceholderCard, SHORT_PHASE_LOW_MS, buildImage } from './RevealStage';
import { CopyInvite } from './pieces';

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

const CATEGORY_ICONS = {
  overall: TrophyIcon,
  rule: ScrollIcon,
  style: PaletteIcon,
  chaos: ShuffleIcon,
} as const;

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
      className="br-room-stage br-vote-screen flex min-h-dvh flex-col"
      data-testid="vote-stage"
      data-can-vote={canVote ? 'true' : 'false'}
    >
      <AppHeader
        compact
        practice={false}
        className="br-phase-header br-phase-header--vote"
        context={
          <div className="br-phase-context">
            <h1>{t.common.roomCode(code)}</h1>
            <span className="br-phase-pill">{v.badge}</span>
          </div>
        }
        actions={
          <>
            <CopyInvite code={code} />
            {headerActions}
            {progress && (
              <VoteProgressBadge voted={progress.voted_count} eligible={progress.eligible_count} />
            )}
            <Countdown
              getRemaining={() => battle.remainingMs()}
              label={v.countdown}
              lowMs={SHORT_PHASE_LOW_MS}
            />
          </>
        }
      />
      <PhaseTrack phase={snapshot.battle.phase} />

      <div className="br-vote-content mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        <div className="br-vote-intro flex flex-col gap-1">
          <h2 className="text-4xl font-black tracking-tight">{v.heading}</h2>
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
            <EyeIcon size={19} weight="duotone" aria-hidden="true" /> {note}
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
      className="br-vote-progress flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-bold"
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
  const CategoryIcon = CATEGORY_ICONS[category.slug as keyof typeof CATEGORY_ICONS];
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
      className="br-vote-category rounded-2xl border bg-white p-3 shadow-sm sm:p-4"
      data-testid="vote-category"
      data-category={category.slug}
      data-state={state}
      aria-labelledby={`cat-${category.slug}`}
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3
          id={`cat-${category.slug}`}
          className="br-vote-category__title text-xl font-black tracking-tight"
        >
          <CategoryIcon size={22} weight="duotone" aria-hidden="true" /> {label}
        </h3>
        <p className="br-vote-category__description text-sm">
          {categoryDescription(category.slug, t, category.description)}
        </p>
        {canVote && (
          <span
            className={`br-vote-category__status ml-auto text-xs font-bold br-vote-category__status--${state}`}
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
      <ul className="br-vote-grid grid grid-cols-1 gap-2 sm:gap-3">
        {builds.map((b) => {
          const own = b.builder_id === snapshot.me.user_id;
          const shown = pending ?? unsent ?? chosen;
          const selected = shown === b.id;
          const confirmed = chosen === b.id && pending === undefined && unsent === undefined;
          const image = buildImage(b, showState.thumbs[b.id] ?? null);
          const name = b.name ?? t.common.buildOf(nameOf(b.builder_id));
          const badge = confirmed
            ? { text: v.yourPick, state: 'confirmed' }
            : pending === b.id
              ? { text: v.saving, state: 'saving' }
              : { text: v.notSaved, state: 'unsent' };
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
                    className={`br-vote-pick-status br-vote-pick-status--${badge.state} absolute top-1.5 right-1.5 hidden rounded-full px-2 py-0.5 text-xs font-black shadow sm:inline`}
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
                    className={`br-vote-pick-status br-vote-pick-status--${badge.state} mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-black sm:hidden`}
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
                  className={`br-vote-option rounded-xl border-2 p-2 ${own ? 'border-dashed border-zinc-300 opacity-60' : 'border-zinc-200'}`}
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
                  className="br-vote-option min-h-16 w-full rounded-xl border-2 p-2 text-left transition hover:-translate-y-0.5 hover:shadow-md"
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
