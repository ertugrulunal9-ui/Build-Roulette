export {
  BATTLE_PHASES,
  HAPPY_PATH_PHASES,
  PHASE_LABELS,
  TERMINAL_PHASES,
  isBattlePhase,
  isTerminalPhase,
} from './phases';
export type { BattlePhase, TerminalPhase } from './phases';

export {
  BUILD_TIME_LIMITS_MINUTES,
  DEFAULT_PHASE_DURATIONS,
  isBuildTimeLimitMinutes,
} from './durations';
export type { BuildTimeLimitMinutes } from './durations';

export {
  REVEAL_SLOT_MAX_SECONDS,
  REVEAL_SLOT_MIN_SECONDS,
  REVEAL_TOTAL_SECONDS,
  revealSlotSeconds,
} from './reveal';

export { estimateClockOffset, remainingMs } from './clock';
export type { ClockSample } from './clock';

export {
  AUTO_AWARDS,
  BATTLE_EVENT_TYPES,
  BATTLE_ROLES,
  BUILD_STATUSES,
  CAPTURE_STATUSES,
  HEARTBEAT_INTERVAL_MS,
  MEMBER_CHANGES,
  MEMBER_ROLES,
  MEMBER_STATES,
  PRESENCE_THROTTLE_MS,
  ROOM_CHANGES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EVENT_TYPES,
  ROOM_LIMITS,
  ROOM_STATUSES,
  battleTopic,
  isRoomCode,
  normalizeRoomCode,
  roomMaxPlayers,
  roomTopic,
} from './rooms';
export type {
  AutoAward,
  BattleEventType,
  BattleRole,
  BuildStatus,
  CaptureStatus,
  MemberChange,
  MemberRole,
  MemberState,
  RoomChange,
  RoomEventType,
  RoomLimits,
  RoomStatus,
} from './rooms';

export { JOIN_ROOM_ERRORS, RPC_ERROR_CODES, SERVICE_ERROR_CODES, isRpcErrorCode } from './errors';
export type { RpcErrorCode } from './errors';
