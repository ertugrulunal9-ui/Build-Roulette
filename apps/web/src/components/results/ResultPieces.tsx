/**
 * Presentational pieces shared by the RESULTS phase of /play and the permanent
 * /battles/[id] page. No hooks, so they render on the server too.
 */
import { VOTE_CATEGORIES } from '@br/game';
import { awardInfo, categoryEmoji, formatTimeLimit, isVoteAward } from '../../lib/solo/format';
import type { Award, Challenge, VoteCounts } from '../../lib/solo/types';

const CARD_STYLE = {
  build: 'border-sky-400 bg-sky-50 text-sky-950 dark:bg-sky-950/60 dark:text-sky-50',
  rule: 'border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/60 dark:text-amber-50',
  style:
    'border-fuchsia-400 bg-fuchsia-50 text-fuchsia-950 dark:bg-fuchsia-950/60 dark:text-fuchsia-50',
} as const;

export type CardKind = keyof typeof CARD_STYLE;

export const CARD_LABEL: Record<CardKind, string> = {
  build: 'BUILD',
  rule: 'RULE',
  style: 'STYLE',
};

export function cardClass(kind: CardKind): string {
  return CARD_STYLE[kind];
}

/** The three challenge cards with their hints, plus the time limit. */
export function ChallengeCards({
  challenge,
  compact = false,
}: {
  challenge: Challenge;
  compact?: boolean;
}) {
  const kinds: CardKind[] = ['build', 'rule', 'style'];
  return (
    <ul
      className={`grid gap-2 ${compact ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-3'}`}
      data-testid="challenge"
    >
      {kinds.map((k) => (
        <li
          key={k}
          className={`rounded-lg border-l-4 px-3 ${compact ? 'py-1.5' : 'py-2.5'} ${CARD_STYLE[k]}`}
          data-card={k}
        >
          <p className="text-[10px] font-black tracking-widest opacity-70">{CARD_LABEL[k]}</p>
          <p className={`font-semibold ${compact ? 'text-sm' : 'text-base'}`}>
            {challenge[k].text}
          </p>
          {challenge[k].hint && !compact && (
            <p className="mt-0.5 text-xs opacity-75">{challenge[k].hint}</p>
          )}
        </li>
      ))}
      <li className="sr-only">Time limit: {formatTimeLimit(challenge.time_limit_seconds)}</li>
    </ul>
  );
}

/**
 * Award chips: the vote category awards first (gold, with the vote count), then the
 * auto-awards (speedrun, clutch ship, fastest ship).
 */
export function AwardBadges({ awards }: { awards: readonly Award[] }) {
  if (awards.length === 0) return null;
  const sorted = [...awards].sort(
    (a, b) =>
      Number(isVoteAward(b.award)) - Number(isVoteAward(a.award)) || awardOrder(a) - awardOrder(b),
  );
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Awards">
      {sorted.map((a) => {
        const info = awardInfo(a.award);
        const vote = isVoteAward(a.award);
        return (
          <li
            key={`${a.award}:${a.build_id}`}
            data-testid="award"
            data-award={a.award}
            data-source={vote ? 'vote' : 'auto'}
            title={info.text}
            className={
              vote
                ? 'rounded-full border border-amber-500 bg-gradient-to-r from-amber-200 to-yellow-100 px-3 py-1 text-sm font-bold text-amber-950 shadow-sm dark:border-amber-500 dark:from-amber-700 dark:to-yellow-800 dark:text-amber-50'
                : 'rounded-full border border-yellow-400 bg-yellow-50 px-3 py-1 text-sm font-semibold text-yellow-900 dark:border-yellow-600 dark:bg-yellow-950/60 dark:text-yellow-100'
            }
          >
            <span aria-hidden="true">{info.emoji}</span> {info.title}
            {vote && a.votes !== null && (
              <span className="font-normal opacity-80">
                {' '}
                · {a.votes} {a.votes === 1 ? 'vote' : 'votes'}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function awardOrder(a: Award): number {
  const i = VOTE_CATEGORIES.findIndex((c) => c.slug === a.award);
  return i === -1 ? 100 : i;
}

/**
 * A build's votes per category (`builds[].votes`, frozen at RESULTS), in the categories'
 * display order, plus the total. Nothing for battles without voting.
 */
export function VoteTally({
  votes,
  total,
  compact = false,
}: {
  votes: VoteCounts | null | undefined;
  total: number;
  compact?: boolean;
}) {
  if (!votes) return null;
  const known = VOTE_CATEGORIES.filter((c) => c.slug in votes);
  const extra = Object.keys(votes).filter((k) => !VOTE_CATEGORIES.some((c) => c.slug === k));
  const rows = [
    ...known.map((c) => ({ slug: c.slug, label: c.label })),
    ...extra.map((k) => ({ slug: k, label: k })),
  ];
  return (
    <ul
      className="flex flex-wrap items-center gap-1.5 text-xs"
      aria-label="Votes per category"
      data-testid="vote-tally"
      data-total={total}
    >
      {rows.map((r) => (
        <li
          key={r.slug}
          data-testid="vote-count"
          data-category={r.slug}
          data-count={votes[r.slug] ?? 0}
          title={`${r.label}: ${String(votes[r.slug] ?? 0)}`}
          className={`rounded-md px-2 py-0.5 font-semibold tabular-nums ${
            (votes[r.slug] ?? 0) > 0
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          <span aria-hidden="true">{categoryEmoji(r.slug)}</span>{' '}
          {compact ? '' : <span className="sr-only">{r.label} </span>}
          {votes[r.slug] ?? 0}
        </li>
      ))}
      <li className="ml-1 font-bold text-zinc-600 dark:text-zinc-300">
        {total} {total === 1 ? 'vote' : 'votes'}
      </li>
    </ul>
  );
}
