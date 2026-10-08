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
  battleRevealSlotSeconds,
  revealSlotSeconds,
} from './reveal';

export {
  DEFAULT_VOTING_SECONDS,
  RANKING_CATEGORY,
  REVEAL_VOTE_PHASE_REASONS,
  VOTE_CATEGORIES,
  VOTE_CATEGORY_SLUGS,
  VOTE_TIE_BREAKS,
  VOTING_MAX_SECONDS,
  VOTING_MIN_SECONDS,
  isVoteCategory,
} from './votes';
export type { RevealVotePhaseReason, VoteCategory, VoteTieBreak } from './votes';

export { estimateClockOffset, remainingMs } from './clock';
export type { ClockSample } from './clock';

export {
  ACTIVITY_RECENT_MS,
  AUTO_AWARDS,
  BATTLE_EVENT_TYPES,
  BATTLE_ROLES,
  BUILD_STATUSES,
  CAPTURE_STATUSES,
  HEARTBEAT_INTERVAL_MS,
  MEMBER_CHANGES,
  MEMBER_ROLES,
  MEMBER_STATES,
  PRESENCE_ACTIVITY_INTERVAL_MS,
  PRESENCE_LINES_STEP,
  PRESENCE_MAX_PER_WINDOW,
  PRESENCE_THROTTLE_MS,
  PRESENCE_WINDOW_MS,
  ROOM_CHANGES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EVENT_TYPES,
  ROOM_LIMITS,
  ROOM_STATUSES,
  activityMatters,
  battleTopic,
  isRoomCode,
  normalizeRoomCode,
  roomMaxPlayers,
  roomTopic,
} from './rooms';
export type {
  ActivityLike,
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

export {
  ADMIN_ERROR_CODES,
  CAST_VOTE_ERRORS,
  JOIN_ROOM_ERRORS,
  REPORT_BUILD_ERRORS,
  RPC_ERROR_CODES,
  SERVICE_ERROR_CODES,
  isRpcErrorCode,
} from './errors';
export type {
  AdminErrorCode,
  CastVoteError,
  JoinRoomError,
  ReportBuildError,
  RpcErrorCode,
} from './errors';

export {
  RATE_LIMITS,
  RATE_LIMIT_ACTIONS,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  isReportReason,
  retryAfterSeconds,
} from './moderation';
export type { RateLimitAction, ReportReason } from './moderation';
