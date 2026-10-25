'use client';

/**
 * Presentational pieces shared by the RESULTS phase of /play and the permanent
 * /battles/[id] page, in the page's language (T-050).
 */
import { VOTE_CATEGORIES } from '@br/game';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import { PaletteIcon } from '@phosphor-icons/react/dist/csr/Palette';
import { ScrollIcon } from '@phosphor-icons/react/dist/csr/Scroll';
import { ShuffleIcon } from '@phosphor-icons/react/dist/csr/Shuffle';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { TrophyIcon } from '@phosphor-icons/react/dist/csr/Trophy';
import { useT } from '../../lib/i18n/context';
import '../room/room-results.css';
import { awardInfo, categoryLabel, formatTimeLimit, isVoteAward } from '../../lib/solo/format';
import type { Award, Challenge, VoteCounts } from '../../lib/solo/types';

const CATEGORY_ICONS = {
  overall: TrophyIcon,
  rule: ScrollIcon,
  style: PaletteIcon,
  chaos: ShuffleIcon,
} as const;

const CARD_STYLE = {
  build: 'br-challenge-card--blue',
  rule: 'br-challenge-card--peach',
  style: 'br-challenge-card--lime',
} as const;

export type CardKind = keyof typeof CARD_STYLE;

export function cardClass(kind: CardKind): string {
  return CARD_STYLE[kind];
}

/** The three challenge cards with their hints, plus the time limit. */
export function ChallengeCards({
  challenge,
  compact = false,
  stacked = false,
}: {
  challenge: Challenge;
  compact?: boolean;
  /** One card per row (a narrow column such as the REVEAL sidebar). */
  stacked?: boolean;
}) {
  const t = useT();
  const kinds: CardKind[] = ['build', 'rule', 'style'];
  return (
    <ul
      className={`br-challenge ${compact ? 'br-challenge--compact' : ''} ${stacked ? 'br-challenge--stacked' : ''} grid gap-2 ${stacked ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3'}`}
      data-testid="challenge"
    >
      {kinds.map((k) => (
        <li
          key={k}
          className={`br-challenge__card rounded-lg px-3 ${compact ? 'py-1.5' : 'py-2.5'} ${CARD_STYLE[k]}`}
          data-card={k}
        >
          <p className="text-[10px] font-black tracking-widest opacity-70">{t.cards[k]}</p>
          <p className={`font-semibold ${compact ? 'text-sm' : 'text-base'}`}>
            {challenge[k].text}
          </p>
          {challenge[k].hint && !compact && (
            <p className="mt-0.5 text-xs opacity-75">{challenge[k].hint}</p>
          )}
        </li>
      ))}
      <li className="sr-only">
        {t.cards.timeLimitSr(formatTimeLimit(challenge.time_limit_seconds, t))}
      </li>
    </ul>
  );
}

/**
 * Award chips: the vote category awards first (gold, with the vote count), then the
 * auto-awards (speedrun, clutch ship, fastest ship).
 */
export function AwardBadges({ awards }: { awards: readonly Award[] }) {
  const t = useT();
  if (awards.length === 0) return null;
  const sorted = [...awards].sort(
    (a, b) =>
      Number(isVoteAward(b.award)) - Number(isVoteAward(a.award)) || awardOrder(a) - awardOrder(b),
  );
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t.awards.label}>
      {sorted.map((a) => {
        const info = awardInfo(a.award, t);
        const vote = isVoteAward(a.award);
        return (
          <li
            key={`${a.award}:${a.build_id}`}
            data-testid="award"
            data-award={a.award}
            data-source={vote ? 'vote' : 'auto'}
            title={info.text}
            className={`br-award-badge ${
              vote
                ? 'rounded-full border border-amber-500 bg-gradient-to-r from-amber-200 to-yellow-100 px-3 py-1 text-sm font-bold text-amber-950 shadow-sm dark:border-amber-500 dark:from-amber-700 dark:to-yellow-800 dark:text-amber-50'
                : 'rounded-full border border-yellow-400 bg-yellow-50 px-3 py-1 text-sm font-semibold text-yellow-900 dark:border-yellow-600 dark:bg-yellow-950/60 dark:text-yellow-100'
            }`}
          >
            {vote ? (
              <TrophyIcon size={16} weight="fill" aria-hidden="true" />
            ) : (
              <LightningIcon size={16} weight="fill" aria-hidden="true" />
            )}{' '}
            {info.title}
            {vote && a.votes !== null && (
              <span className="font-normal opacity-80"> · {t.awards.votes(a.votes)}</span>
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
  const t = useT();
  if (!votes) return null;
  const known = VOTE_CATEGORIES.filter((c) => c.slug in votes);
  const extra = Object.keys(votes).filter((k) => !VOTE_CATEGORIES.some((c) => c.slug === k));
  const rows = [
    ...known.map((c) => ({ slug: c.slug, label: categoryLabel(c.slug, t) })),
    ...extra.map((k) => ({ slug: k, label: k })),
  ];
  return (
    <ul
      className="flex flex-wrap items-center gap-1.5 text-xs"
      aria-label={t.awards.perCategory}
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
          className={`br-vote-count-chip rounded-md px-2 py-0.5 font-semibold tabular-nums ${
            (votes[r.slug] ?? 0) > 0
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          {(() => {
            const Icon = Object.hasOwn(CATEGORY_ICONS, r.slug)
              ? CATEGORY_ICONS[r.slug as keyof typeof CATEGORY_ICONS]
              : SparkleIcon;
            return <Icon size={14} weight="duotone" aria-hidden="true" />;
          })()}{' '}
          {compact ? '' : <span className="sr-only">{r.label} </span>}
          {votes[r.slug] ?? 0}
        </li>
      ))}
      <li className="ml-1 font-bold text-zinc-600 dark:text-zinc-300">{t.awards.votes(total)}</li>
    </ul>
  );
}
