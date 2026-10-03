/** Total reveal budget that is split across builds before clamping. */
export const REVEAL_TOTAL_SECONDS = 300;
export const REVEAL_SLOT_MIN_SECONDS = 30;
export const REVEAL_SLOT_MAX_SECONDS = 60;

/**
 * Seconds each build is spotlighted during REVEAL: `clamp(300 / n, 30, 60)`
 * (docs/04-state-machine.md §4.3). The result is not rounded, e.g. 7 players → 42.857… s.
 *
 * - `playerCount <= 0` returns the maximum slot (60 s). That is the limit of the formula
 *   as n approaches 0, and it means a degenerate count can never yield a zero, negative or
 *   infinite slot.
 * - A non-integer count (including `NaN` and `±Infinity`) is a programming error and
 *   throws a `RangeError`.
 */
export function revealSlotSeconds(playerCount: number): number {
  if (!Number.isInteger(playerCount)) {
    throw new RangeError(`playerCount must be an integer, got ${String(playerCount)}`);
  }
  if (playerCount <= 0) {
    return REVEAL_SLOT_MAX_SECONDS;
  }
  return Math.min(
    REVEAL_SLOT_MAX_SECONDS,
    Math.max(REVEAL_SLOT_MIN_SECONDS, REVEAL_TOTAL_SECONDS / playerCount),
  );
}
