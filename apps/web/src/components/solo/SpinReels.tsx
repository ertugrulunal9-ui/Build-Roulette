'use client';

/**
 * SPIN: three reels (BUILD, RULE, STYLE) plus the time limit, landing one after another on
 * the cards the server already drew. Purely cosmetic: the challenge is in the snapshot from
 * the start of SPINNING, and the landing times are fractions of the server's spin window
 * (`phase_started_at` → `phase_ends_at`), so a late or refreshed client lands at the same
 * moments, or shows the landed cards at once.
 */
import { BUILD_TIME_LIMITS_MINUTES } from '@br/game';
import { useT } from '../../lib/i18n/context';
import { formatTimeLimit } from '../../lib/solo/format';
import type { Challenge } from '../../lib/solo/types';
import { useTicker } from '../../lib/solo/use-ticker';
import type { CardKind } from '../results/ResultPieces';
import './solo-screens.css';

/**
 * Decoys that scroll past while a reel spins (not the real deck). English in every language,
 * like the deck the reels land on (server content, T-050).
 */
const DECOYS: Record<CardKind, readonly string[]> = {
  build: [
    'A pixel art editor',
    'A tiny synth',
    'A habit tracker',
    'A meme generator',
    'A typing game',
    'A recipe scaler',
    'A star map',
    'A to-do list',
  ],
  rule: [
    'No mouse allowed',
    'Everything rotates',
    'Only emoji',
    'One color only',
    'It must make a sound',
    'No buttons',
    'Gravity is reversed',
    'Under 50 lines',
  ],
  style: [
    'Vaporwave',
    'Brutalist',
    'Windows 95',
    'Newspaper',
    'Neon arcade',
    'Pastel kawaii',
    'Terminal green',
    'Swiss poster',
  ],
};

/**
 * When each reel lands, as a fraction of the spin window. The last one lands at 72%, so the
 * whole challenge stays on screen for the last ~1.7 s of a 6 s spin before BUILD starts.
 */
const LANDS_AT: Record<CardKind | 'time', number> = {
  build: 0.3,
  rule: 0.45,
  style: 0.6,
  time: 0.72,
};

function Reel({
  kind,
  label,
  value,
  landed,
}: {
  kind: CardKind | 'time';
  label: string;
  value: string;
  landed: boolean;
}) {
  const t = useT();
  const decoys =
    kind === 'time'
      ? BUILD_TIME_LIMITS_MINUTES.map((m) => formatTimeLimit(m * 60, t))
      : DECOYS[kind];
  const tone = `br-spin-card--${kind}`;
  return (
    <div
      className={`br-spin-card ${tone}`}
      data-testid={`reel-${kind}`}
      data-landed={landed ? 'true' : 'false'}
    >
      <p className="br-spin-card__label">{label}</p>
      <div className="relative h-20 overflow-hidden" aria-live="polite">
        {landed ? (
          <p className="br-reel-land br-spin-card__value">{value}</p>
        ) : (
          <div className="br-reel-strip blur-[1px]" aria-hidden="true">
            {[...decoys, ...decoys].map((d, i) => (
              <p key={i} className="br-spin-card__value br-spin-card__value--decoy">
                {d}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface SpinReelsProps {
  challenge: Challenge;
  /** Server epoch ms of the spin window. */
  startedAt: number;
  endsAt: number;
  serverNow: () => number;
  playerName: string;
  /** Above "SPIN" (default "{playerName}, your challenge is…"). */
  heading?: string;
}

export function SpinReels({
  challenge,
  startedAt,
  endsAt,
  serverNow,
  playerName,
  heading,
}: SpinReelsProps) {
  const t = useT();
  useTicker(80);
  const now = serverNow();
  const span = Math.max(1, endsAt - startedAt);
  const landed = (k: CardKind | 'time') => now >= startedAt + LANDS_AT[k] * span;
  const allLanded = landed('time');

  return (
    <div className="br-spin-overlay" data-testid="spin">
      <header className="br-spin-heading">
        <p>{heading ?? t.spin.heading(playerName)}</p>
        <h1>{t.spin.title}</h1>
      </header>
      <div className="br-spin-grid">
        {(['build', 'rule', 'style'] as const).map((k) => (
          <Reel key={k} kind={k} label={t.cards[k]} value={challenge[k].text} landed={landed(k)} />
        ))}
        <Reel
          kind="time"
          label={t.cards.timeLimit}
          value={formatTimeLimit(challenge.time_limit_seconds, t)}
          landed={allLanded}
        />
      </div>
      <p className="br-spin-ready" aria-live="polite">
        {allLanded ? t.spin.getReady : ''}
      </p>
    </div>
  );
}
