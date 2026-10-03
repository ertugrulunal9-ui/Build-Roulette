/**
 * Battle phases, in lifecycle order. Mirrors the Postgres enum `battle_phase`
 * (docs/05-database.md §5.2) exactly. The transition rules live only in SQL; this list is
 * read-side metadata for the UI.
 */
export const BATTLE_PHASES = [
  'spinning',
  'building',
  'shipping',
  'reveal',
  'voting',
  'results',
  'destroyed',
  'abandoned',
] as const;

export type BattlePhase = (typeof BATTLE_PHASES)[number];

/** Phases a battle never leaves (docs/04-state-machine.md §4.3). */
export const TERMINAL_PHASES = ['destroyed', 'abandoned'] as const satisfies readonly BattlePhase[];

export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

/** Narrows an unknown value (e.g. a string from the database or a broadcast) to a phase. */
export function isBattlePhase(value: unknown): value is BattlePhase {
  return typeof value === 'string' && (BATTLE_PHASES as readonly string[]).includes(value);
}

/** True for `destroyed` and `abandoned`, the phases with no outgoing transitions. */
export function isTerminalPhase(phase: BattlePhase): phase is TerminalPhase {
  return (TERMINAL_PHASES as readonly BattlePhase[]).includes(phase);
}

/** The phases a battle passes through when it runs to completion (no abandonment). */
export const HAPPY_PATH_PHASES = [
  'spinning',
  'building',
  'shipping',
  'reveal',
  'voting',
  'results',
  'destroyed',
] as const satisfies readonly BattlePhase[];

/** Short player-facing names, as used in the "SPIN → BUILD → … → DESTROY BUILD" flow. */
export const PHASE_LABELS = {
  spinning: 'SPIN',
  building: 'BUILD',
  shipping: 'SHIP',
  reveal: 'REVEAL',
  voting: 'VOTE',
  results: 'RESULTS',
  destroyed: 'DESTROY BUILD',
  abandoned: 'ABANDONED',
} as const satisfies Record<BattlePhase, string>;
