import { describe, expect, it } from 'vitest';

import {
  BUILD_TIME_LIMITS_MINUTES,
  DEFAULT_PHASE_DURATIONS,
  isBuildTimeLimitMinutes,
} from './durations';

describe('DEFAULT_PHASE_DURATIONS', () => {
  it('matches docs/04-state-machine.md §4.3 (seconds)', () => {
    expect(DEFAULT_PHASE_DURATIONS).toEqual({
      spinning: 6,
      shipping: 15,
      voting: 60,
      results: 60,
    });
  });
});

describe('BUILD_TIME_LIMITS_MINUTES', () => {
  it('lists the allowed limits in ascending order', () => {
    expect(BUILD_TIME_LIMITS_MINUTES).toEqual([3, 5, 10, 15, 20, 30]);
  });

  it('fits the time_limit_seconds check constraint (60..3600) in docs/05-database.md', () => {
    for (const minutes of BUILD_TIME_LIMITS_MINUTES) {
      expect(minutes * 60).toBeGreaterThanOrEqual(60);
      expect(minutes * 60).toBeLessThanOrEqual(3600);
    }
  });
});

describe('isBuildTimeLimitMinutes', () => {
  it.each(BUILD_TIME_LIMITS_MINUTES)('accepts %d', (minutes) => {
    expect(isBuildTimeLimitMinutes(minutes)).toBe(true);
  });

  it.each([0, 1, 4, 7.5, 60, -5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined])(
    'rejects %j',
    (value) => {
      expect(isBuildTimeLimitMinutes(value)).toBe(false);
    },
  );
});
