import { describe, expect, it } from 'vitest';

import {
  RATE_LIMITS,
  RATE_LIMIT_ACTIONS,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  isReportReason,
  retryAfterSeconds,
} from './moderation';

describe('moderation constants', () => {
  it('every reason has a label and every action a limit', () => {
    expect(Object.keys(REPORT_REASON_LABELS).sort()).toEqual([...REPORT_REASONS].sort());
    expect(Object.keys(RATE_LIMITS).sort()).toEqual([...RATE_LIMIT_ACTIONS].sort());
    for (const { max, windowSeconds } of Object.values(RATE_LIMITS)) {
      expect(max).toBeGreaterThan(0);
      expect(windowSeconds).toBeGreaterThan(0);
    }
  });

  it('isReportReason', () => {
    expect(isReportReason('phishing')).toBe(true);
    expect(isReportReason('boring')).toBe(false);
    expect(isReportReason(undefined)).toBe(false);
  });
});

describe('retryAfterSeconds', () => {
  it('reads the hint of a rate_limited error', () => {
    expect(retryAfterSeconds('{"retry_after_s": 500}')).toBe(500);
    expect(retryAfterSeconds('{"retry_after_s": 1.2}')).toBe(2);
  });

  it('is null for anything else', () => {
    for (const hint of [null, undefined, '', 'soon', '{}', '{"retry_after_s": -1}', '[1]', 42]) {
      expect(retryAfterSeconds(hint), String(hint)).toBeNull();
    }
  });
});
