/**
 * Presentational pieces shared by the RESULTS phase of /play and the permanent
 * /battles/[id] page. No hooks, so they render on the server too.
 */
import { awardInfo, formatTimeLimit } from '../../lib/solo/format';
import type { Award, Challenge } from '../../lib/solo/types';

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

export function AwardBadges({ awards }: { awards: readonly Award[] }) {
  if (awards.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Awards">
      {awards.map((a) => {
        const info = awardInfo(a.award);
        return (
          <li
            key={`${a.award}:${a.build_id}`}
            data-testid="award"
            data-award={a.award}
            title={info.text}
            className="rounded-full border border-yellow-400 bg-yellow-50 px-3 py-1 text-sm font-semibold text-yellow-900 dark:border-yellow-600 dark:bg-yellow-950/60 dark:text-yellow-100"
          >
            <span aria-hidden="true">{info.emoji}</span> {info.title}
          </li>
        );
      })}
    </ul>
  );
}
