import { describe, expect, it } from 'vitest';

import { DEFAULT_PHASE_DURATIONS } from './durations';
import {
  DEFAULT_VOTING_SECONDS,
  RANKING_CATEGORY,
  VOTE_CATEGORIES,
  VOTE_CATEGORY_SLUGS,
  VOTE_TIE_BREAKS,
  VOTING_MAX_SECONDS,
  VOTING_MIN_SECONDS,
  isVoteCategory,
} from './votes';

describe('vote categories', () => {
  it('are the four docs/04 §4.9 categories in display order', () => {
    expect(VOTE_CATEGORY_SLUGS).toEqual(['overall', 'rule', 'style', 'chaos']);
    const orders = VOTE_CATEGORIES.map((c) => c.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('rank by the overall category', () => {
    expect(RANKING_CATEGORY).toBe('overall');
  });

  it('break ties by total votes, then the earlier ship, then the build id (one winner)', () => {
    expect(VOTE_TIE_BREAKS).toEqual(['total_votes', 'shipped_at', 'build_id']);
  });

  it('isVoteCategory accepts the slugs only', () => {
    expect(isVoteCategory('chaos')).toBe(true);
    expect(isVoteCategory('Chaos')).toBe(false);
    expect(isVoteCategory('winner')).toBe(false);
    expect(isVoteCategory(null)).toBe(false);
  });
});

describe('voting duration', () => {
  it('defaults to 60 s, inside the 30–180 s room setting range', () => {
    expect(DEFAULT_VOTING_SECONDS).toBe(DEFAULT_PHASE_DURATIONS.voting);
    expect(DEFAULT_VOTING_SECONDS).toBeGreaterThanOrEqual(VOTING_MIN_SECONDS);
    expect(DEFAULT_VOTING_SECONDS).toBeLessThanOrEqual(VOTING_MAX_SECONDS);
  });
});
