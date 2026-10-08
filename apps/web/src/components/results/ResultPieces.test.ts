// @vitest-environment happy-dom
/**
 * The results pieces shared by room RESULTS, /battles/[id] and /u/[id]: the award chips,
 * the vote tally, and the T-028 rules for a build a moderator removed after RESULTS (it
 * keeps its rank and votes, loses the Winner highlight, its medal and its awards; nobody
 * inherits them).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { awardsOf, isWinner, rankMedal } from '../../lib/solo/format';
import type { Award } from '../../lib/solo/types';
import { AwardBadges, VoteTally } from './ResultPieces';

afterEach(cleanup);

const AWARDS: Award[] = [
  { build_id: 'top', award: 'speedrun', source: 'auto', votes: null },
  { build_id: 'top', award: 'overall', source: 'vote', votes: 3 },
  { build_id: 'top', award: 'rule', source: 'vote', votes: 2 },
  { build_id: 'second', award: 'style', source: 'vote', votes: 2 },
  { build_id: 'third', award: 'clutch_ship', source: 'auto', votes: null },
];

describe('T-028: removed builds in the results', () => {
  it('isWinner: rank 1, unless a moderator removed it', () => {
    expect(isWinner({ final_rank: 1 })).toBe(true);
    expect(isWinner({ final_rank: 1, taken_down: false })).toBe(true);
    expect(isWinner({ final_rank: 1, taken_down: true })).toBe(false);
    expect(isWinner({ final_rank: 2 })).toBe(false);
    expect(isWinner({ final_rank: null })).toBe(false);
  });

  it('awardsOf: a build its own awards, a removed build none, the others unchanged', () => {
    expect(awardsOf(AWARDS, { id: 'top' }).map((a) => a.award)).toEqual([
      'speedrun',
      'overall',
      'rule',
    ]);
    expect(awardsOf(AWARDS, { id: 'top', taken_down: true })).toEqual([]);
    expect(awardsOf(AWARDS, { id: 'second' }).map((a) => a.award)).toEqual(['style']);
    expect(awardsOf(AWARDS, { id: 'third', taken_down: false }).map((a) => a.award)).toEqual([
      'clutch_ship',
    ]);
    expect(awardsOf(AWARDS, { id: 'nobody' })).toEqual([]);
  });

  it('rankMedal: medals for ranks, a dot without a rank or for a removed build', () => {
    expect(rankMedal({ final_rank: 1 })).toBe('🥇');
    expect(rankMedal({ final_rank: 2 })).toBe('🥈');
    expect(rankMedal({ final_rank: 3 })).toBe('🥉');
    expect(rankMedal({ final_rank: 4 })).toBe('🏅');
    expect(rankMedal({ final_rank: null })).toBe('·');
    expect(rankMedal({ final_rank: 1, taken_down: true })).toBe('·');
    expect(rankMedal({ final_rank: 2, taken_down: true })).toBe('·');
  });
});

describe('AwardBadges', () => {
  it('vote awards first in category order (with their votes), then the auto-awards', () => {
    render(createElement(AwardBadges, { awards: awardsOf(AWARDS, { id: 'top' }) }));
    const chips = screen.getAllByTestId('award');
    expect(chips.map((c) => [c.dataset['award'], c.dataset['source']])).toEqual([
      ['overall', 'vote'],
      ['rule', 'vote'],
      ['speedrun', 'auto'],
    ]);
    expect(chips[0]?.textContent).toContain('Best Build');
    expect(chips[0]?.textContent).toContain('3 votes');
  });

  it('renders nothing for a removed build', () => {
    const { container } = render(
      createElement(AwardBadges, { awards: awardsOf(AWARDS, { id: 'top', taken_down: true }) }),
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByLabelText('Awards')).toBeNull();
  });
});

describe('VoteTally', () => {
  it('per category in display order, plus the total (kept for a removed build)', () => {
    render(
      createElement(VoteTally, {
        votes: { chaos: 0, overall: 3, style: 0, rule: 2 },
        total: 5,
      }),
    );
    expect(screen.getByTestId('vote-tally').dataset['total']).toBe('5');
    expect(
      screen.getAllByTestId('vote-count').map((c) => [c.dataset['category'], c.dataset['count']]),
    ).toEqual([
      ['overall', '3'],
      ['rule', '2'],
      ['style', '0'],
      ['chaos', '0'],
    ]);
  });

  it('nothing for a battle without votes', () => {
    const { container } = render(createElement(VoteTally, { votes: null, total: 0 }));
    expect(container.innerHTML).toBe('');
  });
});
