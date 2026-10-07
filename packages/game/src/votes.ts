/**
 * VOTING constants (docs/04-state-machine.md §4.9), checked against the SQL migrations by
 * schema-drift.test.ts: the `vote_categories` seed, `private.reveal_vote_limits()` and the
 * `voting_s` default of `private.default_battle_settings()`.
 */
import { DEFAULT_PHASE_DURATIONS } from './durations';

/** The default vote categories, in display order (`public.vote_categories`). */
export const VOTE_CATEGORIES = [
  {
    slug: 'overall',
    label: 'Best Build',
    description: 'The build you would actually use.',
    sortOrder: 10,
  },
  {
    slug: 'rule',
    label: 'Best Use of the Rule',
    description: 'Who turned the RULE card into a feature.',
    sortOrder: 20,
  },
  {
    slug: 'style',
    label: 'Best Style',
    description: 'Who nailed the STYLE card.',
    sortOrder: 30,
  },
  {
    slug: 'chaos',
    label: 'Most Chaotic',
    description: 'Delightfully unhinged. Bugs may be features.',
    sortOrder: 40,
  },
] as const;

export type VoteCategory = (typeof VOTE_CATEGORIES)[number]['slug'];

export const VOTE_CATEGORY_SLUGS = VOTE_CATEGORIES.map((c) => c.slug) as readonly VoteCategory[];

export function isVoteCategory(value: unknown): value is VoteCategory {
  return typeof value === 'string' && (VOTE_CATEGORY_SLUGS as readonly string[]).includes(value);
}

/** Ranking uses the votes of this category first, then `VOTE_TIE_BREAKS`. */
export const RANKING_CATEGORY: VoteCategory = 'overall';

/**
 * What decides between builds with the same vote count (`private.finalize_votes`, T-022), in
 * order: more votes in all categories (`total_votes`), the earlier `shipped_at`, then the
 * lower build id (rare, but two auto-shipped builds share their `shipped_at`).
 *
 * - **Ranks** compare the `RANKING_CATEGORY` count first, then these: every final build gets
 *   a distinct rank 1…n.
 * - **Category awards** compare that category's count first, then these: a category has
 *   exactly one winner when anyone voted in it, and none when nobody did.
 *
 * Both use the same order, so the Best Build award always goes to the rank-1 build. Battles
 * that finished before T-022 keep their stored (possibly shared) awards and ranks.
 * schema-drift.test.ts checks the `order by` clauses of `private.finalize_votes`.
 */
export const VOTE_TIE_BREAKS = ['total_votes', 'shipped_at', 'build_id'] as const;
export type VoteTieBreak = (typeof VOTE_TIE_BREAKS)[number];

/** Range of the room setting `voting_s` (`update_room_settings`). */
export const VOTING_MIN_SECONDS = 30;
export const VOTING_MAX_SECONDS = 180;
/** VOTING lasts this long unless the room set `voting_s`. */
export const DEFAULT_VOTING_SECONDS = DEFAULT_PHASE_DURATIONS.voting;

/** `reason` of a `phase` event in the REVEAL / VOTING part of a battle. */
export const REVEAL_VOTE_PHASE_REASONS = [
  /** The host moved to the next build (`reveal_next`). */
  'host_next',
  /** The host skipped the rest of the reveal (`skip_to_vote`). */
  'host_skip',
  /**
   * VOTING ended early: every eligible voter who is present voted in every category (checked
   * after each vote, leave and kick, and by `sweep_deadlines` when a voter's presence lapses).
   */
  'all_voted',
  /** Fewer than 2 final builds: SHIPPING went straight to RESULTS. */
  'too_few_builds',
] as const;
export type RevealVotePhaseReason = (typeof REVEAL_VOTE_PHASE_REASONS)[number];
