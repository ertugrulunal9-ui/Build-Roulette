/**
 * REVEAL timing (docs/04-state-machine.md §4.3). Mirrors `private.reveal_vote_limits()` and
 * `private.reveal_slot_seconds(n)` in the SQL migrations (schema-drift.test.ts).
 */

/** Total reveal budget that is split across builds before clamping. */
export const REVEAL_TOTAL_SECONDS = 300;
export const REVEAL_SLOT_MIN_SECONDS = 30;
export const REVEAL_SLOT_MAX_SECONDS = 60;

/**
 * Seconds each build is spotlighted during REVEAL when the room did not set `reveal_slot_s`:
 * `round(clamp(300 / n, 30, 60))`, where `n` is the number of revealed builds (the length
 * of `reveal_order`: shipped and auto-shipped builds, not DNF or disqualified ones).
 *
 * The result is rounded to whole seconds (half up), exactly like the SQL, so the client's
 * countdown and the server's `phase_ends_at` agree: 7 builds → 43 s, 8 → 38 s, 9 → 33 s.
 *
 * - `buildCount <= 0` returns the maximum slot (60 s). That is the limit of the formula as
 *   n approaches 0, and it means a degenerate count can never yield a zero, negative or
 *   infinite slot.
 * - A non-integer count (including `NaN` and `±Infinity`) is a programming error and
 *   throws a `RangeError`.
 */
export function revealSlotSeconds(buildCount: number): number {
  if (!Number.isInteger(buildCount)) {
    throw new RangeError(`buildCount must be an integer, got ${String(buildCount)}`);
  }
  if (buildCount <= 0) {
    return REVEAL_SLOT_MAX_SECONDS;
  }
  return Math.round(
    Math.min(
      REVEAL_SLOT_MAX_SECONDS,
      Math.max(REVEAL_SLOT_MIN_SECONDS, REVEAL_TOTAL_SECONDS / buildCount),
    ),
  );
}

/**
 * The slot length of a battle: the room's `reveal_slot_s` (snapshotted into the battle's
 * settings) when set, otherwise {@link revealSlotSeconds}. Same rule as
 * `private.battle_reveal_slot(settings, n)`.
 */
export function battleRevealSlotSeconds(
  settings: { reveal_slot_s?: unknown } | null | undefined,
  buildCount: number,
): number {
  const fixed = settings?.reveal_slot_s;
  if (typeof fixed === 'number' && Number.isInteger(fixed)) return fixed;
  return revealSlotSeconds(buildCount);
}
