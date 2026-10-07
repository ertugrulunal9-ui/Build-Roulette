/**
 * The error contract of the RPCs (docs/05 §5.7, supabase/README.md): every guard raises a
 * stable snake_case `message`. These lists mirror the codes in the SQL migrations
 * (schema-drift.test.ts checks that together they are exactly the codes the migrations
 * raise).
 */

/** Codes a player's client can receive from a client RPC. */
export const RPC_ERROR_CODES = [
  // Auth and membership
  'not_authenticated',
  'not_on_roster',
  'not_a_member',
  'not_a_player',
  'not_host',
  'kicked',
  // Not found
  'battle_not_found',
  'room_not_found',
  'member_not_found',
  // Bad input
  'invalid_time_limit',
  'invalid_display_name',
  'invalid_name',
  'invalid_stats',
  'stats_too_large',
  'invalid_version',
  'invalid_ready',
  'invalid_settings',
  // Guards
  'wrong_phase',
  'wrong_room_state',
  'deadline_passed',
  'already_shipped',
  'disqualified',
  'files_missing',
  'battle_in_progress',
  'deck_empty',
  'room_closed',
  'room_full',
  'room_busy',
  'too_many_rooms',
  'not_enough_players',
  'cannot_kick_self',
  'not_implemented',
  // REVEAL and VOTING (M4: `cast_vote`, `reveal_next`, `skip_to_vote`, `get_reveal_builds`,
  // `get_my_votes`)
  'not_a_voter',
  'build_not_found',
  'invalid_category',
  'self_vote',
  'not_votable',
  // Moderation (T-024): the name filter, rate limits and `report_build`
  'name_not_allowed',
  'rate_limited',
  'invalid_reason',
  'invalid_details',
  'own_build',
  'already_reported',
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

/**
 * Codes only the service-role functions raise (capture/destroy workers). `complete_capture`
 * also raises `build_not_found`, which is listed in {@link RPC_ERROR_CODES} since
 * `cast_vote` raises it too.
 */
export const SERVICE_ERROR_CODES = [
  'invalid_capture_status',
  'invalid_path',
  'job_not_found',
  'job_not_running',
  'not_capturable',
  'not_taken_down',
] as const;

/**
 * Codes only the admin RPCs raise (T-024: `admin_*`, gated on `is_admin()`). They also
 * raise `build_not_found`, `battle_not_found`, `room_not_found` and `invalid_details` (a
 * note over 500 characters), listed in {@link RPC_ERROR_CODES}.
 */
export const ADMIN_ERROR_CODES = ['not_admin', 'already_taken_down'] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

export function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return typeof value === 'string' && (RPC_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Every code `join_room` can answer with (besides `not_authenticated`): the room page shows
 * each. `room_not_found` and `room_closed` come back as an HTTP 404/400 error body rather
 * than a raised exception (the failed attempt must be counted, T-024); clients see the same
 * `error.message` either way.
 */
export const JOIN_ROOM_ERRORS = [
  'room_not_found',
  'room_closed',
  'kicked',
  'room_full',
  'invalid_display_name',
  'name_not_allowed',
  'rate_limited',
] as const satisfies readonly RpcErrorCode[];

export type JoinRoomError = (typeof JOIN_ROOM_ERRORS)[number];

/**
 * Every code `cast_vote` can raise (besides `not_authenticated`): the VOTE stage explains
 * each one. Checked against `public.cast_vote` by the drift test.
 */
export const CAST_VOTE_ERRORS = [
  'battle_not_found',
  'not_on_roster',
  'kicked',
  'not_a_member',
  'not_a_voter',
  'wrong_phase',
  'deadline_passed',
  'invalid_category',
  'build_not_found',
  'self_vote',
  'not_votable',
] as const satisfies readonly RpcErrorCode[];

export type CastVoteError = (typeof CAST_VOTE_ERRORS)[number];

/**
 * Every code `report_build` can raise (besides `not_authenticated`): the report dialog
 * explains each. Checked against `public.report_build` by the drift test (`rate_limited`
 * comes from the shared rate-limit helper).
 */
export const REPORT_BUILD_ERRORS = [
  'rate_limited',
  'invalid_reason',
  'invalid_details',
  'build_not_found',
  'own_build',
  'already_reported',
] as const satisfies readonly RpcErrorCode[];

export type ReportBuildError = (typeof REPORT_BUILD_ERRORS)[number];
