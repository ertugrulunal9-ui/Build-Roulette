'use client';

/**
 * SPIN: three reels (BUILD, RULE, STYLE) plus the time limit, landing one after another on
 * the cards the server already drew. Purely cosmetic: the challenge is in the snapshot from
 * the start of SPINNING, and the landing times are fractions of the server's spin window
 * (`phase_started_at` → `phase_ends_at`), so a late or refreshed client lands at the same
 * moments, or shows the landed cards at once.
 */
import { formatTimeLimit } from '../../lib/solo/format';
import type { Challenge } from '../../lib/solo/types';
import { useTicker } from '../../lib/solo/use-ticker';
import { CARD_LABEL, cardClass, type CardKind } from '../results/ResultPieces';

/** Decoys that scroll past while a reel spins (not the real deck). */
const DECOYS: Record<CardKind | 'time', readonly string[]> = {
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
  time: ['3 min', '5 min', '10 min', '15 min', '20 min', '30 min'],
};

/** When each reel lands, as a fraction of the spin window. */
const LANDS_AT: Record<CardKind | 'time', number> = {
  build: 0.35,
  rule: 0.55,
  style: 0.75,
  time: 0.88,
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
  const decoys = DECOYS[kind];
  const tone =
    kind === 'time'
      ? 'border-emerald-400 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/60 dark:text-emerald-50'
      : cardClass(kind);
  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl border-4 p-4 shadow-lg ${tone}`}
      data-testid={`reel-${kind}`}
      data-landed={landed ? 'true' : 'false'}
    >
      <p className="text-xs font-black tracking-[0.3em] opacity-70">{label}</p>
      <div className="relative h-20 overflow-hidden" aria-live="polite">
        {landed ? (
          <p className="br-reel-land flex h-20 items-center justify-center text-center text-xl font-black sm:text-2xl">
            {value}
          </p>
        ) : (
          <div className="br-reel-strip blur-[1px]" aria-hidden="true">
            {[...decoys, ...decoys].map((d, i) => (
              <p
                key={i}
                className="flex h-20 items-center justify-center text-center text-xl font-black opacity-60 sm:text-2xl"
              >
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
}

export function SpinReels({ challenge, startedAt, endsAt, serverNow, playerName }: SpinReelsProps) {
  useTicker(80);
  const now = serverNow();
  const span = Math.max(1, endsAt - startedAt);
  const landed = (k: CardKind | 'time') => now >= startedAt + LANDS_AT[k] * span;
  const allLanded = landed('time');

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-8 overflow-auto bg-zinc-950/95 px-4 py-10 text-white backdrop-blur"
      data-testid="spin"
    >
      <header className="text-center">
        <p className="text-sm font-semibold tracking-widest text-zinc-400 uppercase">
          {playerName}, your challenge is…
        </p>
        <h1 className="mt-2 text-5xl font-black tracking-tight sm:text-6xl">SPIN</h1>
      </header>
      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(['build', 'rule', 'style'] as const).map((k) => (
          <Reel
            key={k}
            kind={k}
            label={CARD_LABEL[k]}
            value={challenge[k].text}
            landed={landed(k)}
          />
        ))}
        <Reel
          kind="time"
          label="TIME LIMIT"
          value={formatTimeLimit(challenge.time_limit_seconds)}
          landed={allLanded}
        />
      </div>
      <p className="h-6 text-lg font-bold text-zinc-300" aria-live="polite">
        {allLanded ? 'Get ready to build…' : ''}
      </p>
    </div>
  );
}
