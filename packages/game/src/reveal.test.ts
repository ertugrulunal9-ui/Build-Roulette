import { describe, expect, it } from 'vitest';

import { battleRevealSlotSeconds, revealSlotSeconds } from './reveal';

describe('revealSlotSeconds', () => {
  it.each([
    [1, 60],
    [2, 60],
    [5, 60], // 300 / 5 = 60, exactly the upper bound
    [6, 50],
    [10, 30], // 300 / 10 = 30, exactly the lower bound
    [11, 30],
    [50, 30],
    [1000, 30],
  ])('%d builds → %d s', (players, seconds) => {
    expect(revealSlotSeconds(players)).toBe(seconds);
  });

  it('rounds to whole seconds between the bounds (half up, like SQL round())', () => {
    expect(revealSlotSeconds(7)).toBe(43); // 42.857…
    expect(revealSlotSeconds(8)).toBe(38); // 37.5
    expect(revealSlotSeconds(9)).toBe(33); // 33.333…
    for (let n = 1; n <= 50; n++) expect(Number.isInteger(revealSlotSeconds(n))).toBe(true);
  });

  it('always stays within [30, 60] for realistic counts', () => {
    for (let n = 1; n <= 200; n++) {
      const slot = revealSlotSeconds(n);
      expect(slot).toBeGreaterThanOrEqual(30);
      expect(slot).toBeLessThanOrEqual(60);
    }
  });

  it('is non-increasing as players are added', () => {
    for (let n = 1; n < 50; n++) {
      expect(revealSlotSeconds(n + 1)).toBeLessThanOrEqual(revealSlotSeconds(n));
    }
  });

  it.each([0, -1, -100])('returns the 60 s maximum for a count of %d', (players) => {
    expect(revealSlotSeconds(players)).toBe(60);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws a RangeError for %d',
    (players) => {
      expect(() => revealSlotSeconds(players)).toThrow(RangeError);
    },
  );
});

describe('battleRevealSlotSeconds', () => {
  it('uses the room setting when the battle has one', () => {
    expect(battleRevealSlotSeconds({ reveal_slot_s: 45 }, 8)).toBe(45);
  });

  it('falls back to the build-count rule', () => {
    expect(battleRevealSlotSeconds({}, 8)).toBe(38);
    expect(battleRevealSlotSeconds(null, 3)).toBe(60);
    expect(battleRevealSlotSeconds({ reveal_slot_s: '45' }, 10)).toBe(30);
  });
});
