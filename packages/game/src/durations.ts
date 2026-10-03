/**
 * Default phase durations in **seconds** (docs/04-state-machine.md §4.3). Rooms can
 * override these; the server's `phase_ends_at` is always the authority.
 *
 * `building` is not listed because it comes from the TIME LIMIT card or a room setting (see
 * {@link BUILD_TIME_LIMITS_MINUTES}), and `reveal` is per build (see `revealSlotSeconds`).
 */
export const DEFAULT_PHASE_DURATIONS = {
  /** Spin animation before BUILD starts. */
  spinning: 6,
  /** Grace window after the build deadline for in-flight ships. */
  shipping: 15,
  voting: 60,
  /** "Last look" window on the results before the builds are destroyed. */
  results: 60,
} as const;

/** Allowed build time limits in minutes (docs/04-state-machine.md §4.3). */
export const BUILD_TIME_LIMITS_MINUTES = [3, 5, 10, 15, 20, 30] as const;

export type BuildTimeLimitMinutes = (typeof BUILD_TIME_LIMITS_MINUTES)[number];

export function isBuildTimeLimitMinutes(value: unknown): value is BuildTimeLimitMinutes {
  return (
    typeof value === 'number' && (BUILD_TIME_LIMITS_MINUTES as readonly number[]).includes(value)
  );
}
