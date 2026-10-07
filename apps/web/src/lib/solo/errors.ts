/**
 * The T-011 error contract on the client (supabase/README.md "RPCs", docs/05 §5.7): every
 * RPC guard raises a stable snake_case `message` with a human `details`. This module turns
 * whatever a call threw (a PostgREST error, a Storage error, a network failure) into a
 * `GameError` with one of these codes, and gives each code a player-facing sentence.
 *
 * The RPC codes live in `@br/game` (`RPC_ERROR_CODES`), whose drift test checks them
 * against every code the SQL migrations raise.
 */
import {
  CAST_VOTE_ERRORS,
  RPC_ERROR_CODES as GAME_RPC_ERROR_CODES,
  isRpcErrorCode,
  type CastVoteError,
  type RpcErrorCode,
} from '@br/game';

/** Codes raised by the client RPCs (SQL, solo and rooms). */
export const RPC_ERROR_CODES = GAME_RPC_ERROR_CODES;

/**
 * Codes the client adds for failures outside the RPCs. (`rate_limited` is an RPC code since
 * T-024; any other HTTP 429, e.g. too many anonymous sign-ups from one address, maps to it
 * too.)
 */
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

export type { RpcErrorCode };
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
  if (isRpcErrorCode(message)) {
    return new GameError(message, typeof details === 'string' ? details : null, e);
  }
  const rawStatus = field(e, 'statusCode') ?? field(e, 'status');
  const status =
    typeof rawStatus === 'string' || typeof rawStatus === 'number' ? String(rawStatus) : '';
  const text = typeof message === 'string' ? message : String(e);
  if (status === '429' || /rate limit/i.test(text)) {
    return new GameError('rate_limited', text, e);
  }
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
  not_a_member: 'You are not in this room anymore. Join it again first.',
  not_a_player: 'Spectators cannot do that. Wait for a free player slot.',
  not_host: 'Only the host can do that.',
  kicked: 'The host removed you from this room. You cannot rejoin it.',
  battle_not_found: 'This battle does not exist, or it is not yours.',
  room_not_found: 'No room has this code. Check it, or create a new room.',
  member_not_found: 'That player is no longer in the room.',
  invalid_time_limit: 'That time limit is not allowed.',
  invalid_display_name: 'Your name must be 1 to 24 characters.',
  invalid_name: 'The build name must be 1 to 48 characters.',
  invalid_stats: 'The server rejected the build stats. This is a bug; shipping without them.',
  stats_too_large: 'The server rejected the build stats. This is a bug; shipping without them.',
  invalid_version: 'The game got out of sync. Reload the page.',
  invalid_ready: 'Ready must be on or off.',
  invalid_settings: 'Those room settings are not allowed.',
  wrong_phase: 'Too late: the battle has already moved on.',
  wrong_room_state: 'Not now: a battle is running in this room.',
  deadline_passed: 'Time is up: the deadline and its grace period are over.',
  already_shipped: 'Already shipped. Ship is final.',
  disqualified: 'Your build was disqualified.',
  files_missing: 'The upload did not finish. Try shipping again.',
  battle_in_progress: 'You already have a battle running.',
  deck_empty: 'No challenge cards are available right now. Try again in a moment.',
  room_closed: 'This room is closed. Create a new one to play again.',
  room_full: 'This room is full: every player and spectator slot is taken.',
  room_busy: 'The room is busy right now. Try again in a moment.',
  too_many_rooms: 'You already host 3 open rooms. Leave one of them first.',
  not_enough_players: 'At least 2 players must be ready (and online) to start.',
  cannot_kick_self: 'You cannot kick yourself. Leave the room instead.',
  not_implemented: 'That is not available yet.',
  not_a_voter: 'You cannot vote in this battle.',
  build_not_found: 'That build is not part of this battle.',
  invalid_category: 'That vote category does not exist.',
  self_vote: 'You cannot vote for your own build.',
  not_votable: 'That build cannot get votes: it was not shipped.',
  name_not_allowed: 'That name is not allowed here. Pick another one.',
  invalid_reason: 'Pick a reason for the report.',
  invalid_details: 'The details are too long (500 characters at most).',
  own_build: 'You cannot report your own build.',
  already_reported: 'You already reported this build. Thanks, a moderator will look at it.',
  upload_refused: 'The server refused the upload: the deadline may have passed.',
  file_too_large: 'Your build is over the 5 MB limit. Remove large files or images.',
  build_failed: 'Your code does not build. Fix the errors under Problems first.',
  nothing_built: 'Nothing has built successfully yet, so there is nothing to ship.',
  network: 'Cannot reach the server. Check your connection and try again.',
  rate_limited: 'Too many requests right now. Wait a few minutes and try again.',
  unknown: 'Something went wrong. Try again.',
};

export function describeError(e: GameError | ErrorCode): string {
  // The server's rate-limit details say how long to wait ("… Try again in 9 minutes.").
  if (
    typeof e !== 'string' &&
    e.code === 'rate_limited' &&
    e.details &&
    /try again in/i.test(e.details)
  ) {
    return e.details;
  }
  return MESSAGES[typeof e === 'string' ? e : e.code];
}

/**
 * What the VOTE stage says when `cast_vote` refuses (every code it can raise, typed against
 * `@br/game`'s list so a new one cannot be forgotten). Other failures (network…) use
 * {@link describeError}.
 */
const VOTE_MESSAGES: Record<CastVoteError, string> = {
  battle_not_found: 'This battle is gone. Reload the page.',
  not_on_roster: 'Only the players of this battle vote. Spectators watch the results.',
  kicked: 'The host removed you from this room, so you cannot vote.',
  not_a_member: 'You left the room. Join it again to vote before the time is up.',
  not_a_voter: 'You cannot vote in this battle.',
  wrong_phase: 'Voting is over: the results are in.',
  deadline_passed: 'Too late: voting just closed.',
  invalid_category: 'That vote category does not exist any more. Reload the page.',
  build_not_found: 'That build is not part of this battle.',
  self_vote: 'Nice try: you cannot vote for your own build.',
  not_votable: 'That build cannot get votes: it was not shipped.',
};

export function describeVoteError(e: GameError | ErrorCode): string {
  const code = typeof e === 'string' ? e : e.code;
  return (CAST_VOTE_ERRORS as readonly string[]).includes(code)
    ? VOTE_MESSAGES[code as CastVoteError]
    : describeError(code);
}
