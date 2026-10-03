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
