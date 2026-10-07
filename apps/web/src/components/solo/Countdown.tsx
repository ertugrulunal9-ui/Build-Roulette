'use client';

import { formatCountdown } from '../../lib/solo/format';
import { useTicker } from '../../lib/solo/use-ticker';

/** At or below this, the countdown turns amber and warns once. */
export const LOW_TIME_MS = 60_000;
/** At or below this, it pulses red. */
export const CRITICAL_TIME_MS = 10_000;

export type TimeLevel = 'normal' | 'low' | 'critical' | 'up';

export function timeLevel(remaining: number | null, lowMs = LOW_TIME_MS): TimeLevel {
  if (remaining === null) return 'normal';
  if (remaining <= 0) return 'up';
  if (remaining <= CRITICAL_TIME_MS) return 'critical';
  if (remaining <= lowMs) return 'low';
  return 'normal';
}

const LEVEL_CLASS: Record<TimeLevel, string> = {
  normal: 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900',
  low: 'bg-amber-500 text-amber-950',
  critical: 'br-pulse-red text-white',
  up: 'bg-red-700 text-white',
};

/**
 * The BUILD countdown, from server time (docs/04 §4.5). It re-renders itself four times a
 * second; the rest of the page ticks once a second.
 */
export function Countdown({
  getRemaining,
  label,
  lowMs = LOW_TIME_MS,
}: {
  getRemaining: () => number | null;
  label: string;
  /** Amber from this much time left (short phases such as a reveal slot use less). */
  lowMs?: number;
}) {
  useTicker(250);
  const remaining = getRemaining();
  const level = timeLevel(remaining, lowMs);
  return (
    <div
      className={`flex items-baseline gap-2 rounded-lg px-3 py-1.5 font-mono tabular-nums ${LEVEL_CLASS[level]}`}
      data-testid="countdown"
      data-level={level}
      role="timer"
      aria-label={label}
    >
      <span className="text-[10px] font-bold tracking-widest uppercase opacity-80">{label}</span>
      <span className="text-2xl font-black">
        {remaining === null ? '–:––' : formatCountdown(remaining)}
      </span>
    </div>
  );
}
