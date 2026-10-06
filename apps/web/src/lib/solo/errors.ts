/**
 * The T-011 error contract on the client (supabase/README.md "RPCs", docs/05 §5.7): every
 * RPC guard raises a stable snake_case `message` with a human `details`. This module turns
 * whatever a call threw (a PostgREST error, a Storage error, a network failure) into a
 * `GameError` with one of these codes, and gives each code a player-facing sentence.
 */

/** Codes raised by the RPCs (SQL). */
export const RPC_ERROR_CODES = [
  'not_authenticated',
  'not_on_roster',
  'not_a_member',
  'battle_not_found',
  'invalid_time_limit',
  'invalid_display_name',
  'invalid_name',
  'invalid_stats',
  'stats_too_large',
  'invalid_version',
  'wrong_phase',
  'deadline_passed',
  'already_shipped',
  'files_missing',
  'battle_in_progress',
  'deck_empty',
  'not_implemented',
] as const;

/** Codes the client adds for failures outside the RPCs. */
export const CLIENT_ERROR_CODES = [
  /** Storage RLS refused a write (deadline passed, already shipped, wrong folder). */
  'upload_refused',
  /** Over the 5 MB bucket limit. */
  'file_too_large',
  /** The production build of the workspace failed. */
  'build_failed',
  /** No build has succeeded yet, so there is nothing to ship or autosave. */
  'nothing_built',
  /** The server could not be reached. */
  'network',
  'unknown',
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];
export type ErrorCode = RpcErrorCode | (typeof CLIENT_ERROR_CODES)[number];

export class GameError extends Error {
  readonly code: ErrorCode;
  /** The server's `details` (for `battle_in_progress`: the running battle's id). */
  readonly details: string | null;

  constructor(code: ErrorCode, details: string | null = null, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'GameError';
    this.code = code;
    this.details = details;
  }
}

function isRpcCode(s: unknown): s is RpcErrorCode {
  return typeof s === 'string' && (RPC_ERROR_CODES as readonly string[]).includes(s);
}

function field(e: unknown, key: string): unknown {
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;
}

/**
 * Normalizes an error from supabase-js (PostgrestError `{message, details, code}`,
 * StorageError `{message, statusCode}`, a fetch TypeError) into a GameError.
 */
export function toGameError(e: unknown): GameError {
  if (e instanceof GameError) return e;
  const message = field(e, 'message');
  const details = field(e, 'details');
  if (isRpcCode(message)) {
    return new GameError(message, typeof details === 'string' ? details : null, e);
  }
  const rawStatus = field(e, 'statusCode') ?? field(e, 'status');
  const status =
    typeof rawStatus === 'string' || typeof rawStatus === 'number' ? String(rawStatus) : '';
  const text = typeof message === 'string' ? message : String(e);
  if (status === '413' || /maximum allowed size|payload too large/i.test(text)) {
    return new GameError('file_too_large', text, e);
  }
  if (status === '403' || /row-level security/i.test(text)) {
    return new GameError('upload_refused', text, e);
  }
  if (
    (e instanceof TypeError && /fetch|network|load failed/i.test(text)) ||
    /failed to fetch|networkerror|network request failed/i.test(text)
  ) {
    return new GameError('network', text, e);
  }
  return new GameError('unknown', text, e);
}

const MESSAGES: Record<ErrorCode, string> = {
  not_authenticated: 'Your session has expired. Reload the page to sign in again.',
  not_on_roster: 'You are not a player in this battle.',
  not_a_member: 'You are not a member of this battle.',
  battle_not_found: 'This battle does not exist, or it is not yours.',
  invalid_time_limit: 'That time limit is not allowed.',
  invalid_display_name: 'Your name must be 1 to 24 characters.',
  invalid_name: 'The build name must be 1 to 48 characters.',
  invalid_stats: 'The server rejected the build stats. This is a bug; shipping without them.',
  stats_too_large: 'The server rejected the build stats. This is a bug; shipping without them.',
  invalid_version: 'The game got out of sync. Reload the page.',
  wrong_phase: 'Too late: the battle has already moved on.',
  deadline_passed: 'Time is up: the deadline and its grace period are over.',
  already_shipped: 'Already shipped. Ship is final.',
  files_missing: 'The upload did not finish. Try shipping again.',
  battle_in_progress: 'You already have a battle running.',
  deck_empty: 'No challenge cards are available right now. Try again in a moment.',
  not_implemented: 'That is not available yet.',
  upload_refused: 'The server refused the upload: the deadline may have passed.',
  file_too_large: 'Your build is over the 5 MB limit. Remove large files or images.',
  build_failed: 'Your code does not build. Fix the errors under Problems first.',
  nothing_built: 'Nothing has built successfully yet, so there is nothing to ship.',
  network: 'Cannot reach the server. Check your connection and try again.',
  unknown: 'Something went wrong. Try again.',
};

export function describeError(e: GameError | ErrorCode): string {
  return MESSAGES[typeof e === 'string' ? e : e.code];
}
