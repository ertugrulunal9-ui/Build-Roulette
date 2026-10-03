import { describe, expect, it } from 'vitest';

import {
  BATTLE_PHASES,
  HAPPY_PATH_PHASES,
  PHASE_LABELS,
  TERMINAL_PHASES,
  isBattlePhase,
  isTerminalPhase,
} from './phases';

describe('BATTLE_PHASES', () => {
  it('matches the battle_phase enum in docs/05-database.md §5.2, in order', () => {
    expect(BATTLE_PHASES).toEqual([
      'spinning',
      'building',
      'shipping',
      'reveal',
      'voting',
      'results',
      'destroyed',
      'abandoned',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(BATTLE_PHASES).size).toBe(BATTLE_PHASES.length);
  });
});

describe('isTerminalPhase', () => {
  it('is true only for destroyed and abandoned', () => {
    const terminal = BATTLE_PHASES.filter((phase) => isTerminalPhase(phase));
    expect(terminal).toEqual(['destroyed', 'abandoned']);
    expect([...TERMINAL_PHASES].sort()).toEqual([...terminal].sort());
  });

  it.each(['spinning', 'building', 'shipping', 'reveal', 'voting', 'results'] as const)(
    '%s is not terminal',
    (phase) => {
      expect(isTerminalPhase(phase)).toBe(false);
    },
  );
});

describe('isBattlePhase', () => {
  it.each(BATTLE_PHASES)('accepts %s', (phase) => {
    expect(isBattlePhase(phase)).toBe(true);
  });

  it.each(['SPINNING', 'spin', ' building', '', 'toString', null, undefined, 0, {}, ['spinning']])(
    'rejects %j',
    (value) => {
      expect(isBattlePhase(value)).toBe(false);
    },
  );
});

describe('HAPPY_PATH_PHASES and PHASE_LABELS', () => {
  it('happy path is every phase except abandoned, in enum order', () => {
    expect(HAPPY_PATH_PHASES).toEqual(BATTLE_PHASES.filter((phase) => phase !== 'abandoned'));
  });

  it('spells out the game flow from the README', () => {
    expect(HAPPY_PATH_PHASES.map((phase) => PHASE_LABELS[phase]).join(' → ')).toBe(
      'SPIN → BUILD → SHIP → REVEAL → VOTE → RESULTS → DESTROY BUILD',
    );
  });

  it('labels every phase', () => {
    expect(Object.keys(PHASE_LABELS).sort()).toEqual([...BATTLE_PHASES].sort());
  });
});
