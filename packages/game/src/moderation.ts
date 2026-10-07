/**
 * Moderation constants (T-024, docs/02 R9): report reasons, the report details limit and
 * the per-user rate limits. The server enforces all of them; these mirror the SQL for the
 * UI and are checked against the migrations by schema-drift.test.ts.
 */

/** The `reports.reason` check constraint and `report_build`'s accepted reasons, in UI order. */
export const REPORT_REASONS = ['offensive', 'phishing', 'malware', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, { label: string; hint: string }> = {
  offensive: { label: 'Offensive', hint: 'Hateful, sexual or violent content, or a slur.' },
  phishing: { label: 'Phishing or scam', hint: 'Asks for passwords, payment or personal data.' },
  malware: {
    label: 'Malware or mining',
    hint: 'Freezes the browser, mines crypto, runs harmful code.',
  },
  spam: { label: 'Spam', hint: 'Ads, links or nothing to do with the challenge.' },
  other: { label: 'Something else', hint: 'Tell us in the details.' },
};

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/** `report_build` refuses longer details (`invalid_details`). */
export const REPORT_DETAILS_MAX = 500;

/** The actions of `private.rate_limits` (the per-user limits in Postgres). */
export const RATE_LIMIT_ACTIONS = [
  'create_room',
  'join_room_failed',
  'report_build',
  'start_solo_battle',
  'cast_vote',
] as const;
export type RateLimitAction = (typeof RATE_LIMIT_ACTIONS)[number];

/**
 * The default limits seeded into `private.rate_limits` (sliding windows, per user). An
 * operator may change them with SQL; this mirror is what the code ships with.
 */
export const RATE_LIMITS: Record<RateLimitAction, { max: number; windowSeconds: number }> = {
  /** Rooms created. */
  create_room: { max: 10, windowSeconds: 3600 },
  /** Wrong or closed room codes (code guessing); a right code is not counted. */
  join_room_failed: { max: 20, windowSeconds: 600 },
  /** Reports filed. */
  report_build: { max: 20, windowSeconds: 3600 },
  /** Solo battles started. */
  start_solo_battle: { max: 30, windowSeconds: 3600 },
  /** Votes cast, revotes included: against floods only. */
  cast_vote: { max: 120, windowSeconds: 60 },
};

/**
 * The seconds to wait from a `rate_limited` error's `hint` (`{"retry_after_s": n}`), or
 * null when the hint is missing or malformed.
 */
export function retryAfterSeconds(hint: unknown): number | null {
  if (typeof hint !== 'string' || hint === '') return null;
  try {
    const parsed = JSON.parse(hint) as unknown;
    const n =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['retry_after_s']
        : undefined;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  } catch {
    return null;
  }
}
