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
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

/** Codes only the service-role functions raise (capture/destroy workers). */
export const SERVICE_ERROR_CODES = [
  'build_not_found',
  'invalid_capture_status',
  'invalid_path',
  'job_not_found',
  'job_not_running',
  'not_capturable',
] as const;

export function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return typeof value === 'string' && (RPC_ERROR_CODES as readonly string[]).includes(value);
}

/** Every code `join_room` can raise (besides `not_authenticated`): the room page shows each. */
export const JOIN_ROOM_ERRORS = [
  'room_not_found',
  'room_closed',
  'kicked',
  'room_full',
  'invalid_display_name',
] as const satisfies readonly RpcErrorCode[];

export type JoinRoomError = (typeof JOIN_ROOM_ERRORS)[number];
