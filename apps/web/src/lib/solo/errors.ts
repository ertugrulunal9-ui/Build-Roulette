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
import { en, type Messages } from '../i18n/messages/en';

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
  /** Nothing was imported yet, so there is nothing to ship. */
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

/**
 * The player-facing sentence of an error, in the page's language (T-050: the catalogs'
 * `errors`; English by default, e.g. for tests and logs). Every code has one in each language.
 */
export function describeError(e: GameError | ErrorCode, m: Messages = en): string {
  // The server's rate-limit details say how long to wait ("… Try again in 9 minutes.").
  if (
    typeof e !== 'string' &&
    e.code === 'rate_limited' &&
    e.details &&
    /try again in/i.test(e.details)
  ) {
    return m.rateLimitedDetails(e.details);
  }
  return m.errors[typeof e === 'string' ? e : e.code];
}

/**
 * What the VOTE stage says when `cast_vote` refuses (every code it can raise, typed against
 * `@br/game`'s list in the catalogs' `voteErrors`, so a new one cannot be forgotten). Other
 * failures (network…) use {@link describeError}.
 */
export function describeVoteError(e: GameError | ErrorCode, m: Messages = en): string {
  const code = typeof e === 'string' ? e : e.code;
  return (CAST_VOTE_ERRORS as readonly string[]).includes(code)
    ? m.voteErrors[code as CastVoteError]
    : describeError(code, m);
}
