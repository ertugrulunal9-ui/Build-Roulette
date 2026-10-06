import type { BattlePhase } from '@br/game';
import { describe, expect, it } from 'vitest';
import {
  STALE_WORKSPACE_MS,
  pruneBattleWorkspaces,
  type StoredBattleWorkspace,
  type WorkspaceCleanupDeps,
} from './workspace-cleanup';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function deps(
  stored: StoredBattleWorkspace[],
  phases: Record<string, BattlePhase> | Error,
): WorkspaceCleanupDeps & { asked: string[][]; deleted: string[] } {
  const asked: string[][] = [];
  const deleted: string[] = [];
  return {
    asked,
    deleted,
    list: () => Promise.resolve(stored),
    delete: (wid) => {
      deleted.push(wid);
      return Promise.resolve();
    },
    battlePhases: (ids) => {
      asked.push(ids);
      return phases instanceof Error ? Promise.reject(phases) : Promise.resolve(phases);
    },
    now: () => NOW,
  };
}

const ws = (n: number, ageMs = 60_000): StoredBattleWorkspace => ({
  id: `battle:${id(n)}`,
  updatedAt: NOW - ageMs,
});

describe('pruneBattleWorkspaces', () => {
  it('deletes battles that are over on the server and keeps running ones', async () => {
    const d = deps([ws(1), ws(2), ws(3), ws(4), ws(5)], {
      [id(1)]: 'building', // another tab is playing it
      [id(2)]: 'results',
      [id(3)]: 'destroyed',
      [id(4)]: 'abandoned',
      [id(5)]: 'shipping',
    });
    const out = await pruneBattleWorkspaces(d, null);
    expect(out.sort()).toEqual([2, 3, 4].map((n) => `battle:${id(n)}`).sort());
  });

  it('never touches the battle being opened', async () => {
    const d = deps([ws(1), ws(2)], { [id(1)]: 'destroyed', [id(2)]: 'destroyed' });
    expect(await pruneBattleWorkspaces(d, `battle:${id(1)}`)).toEqual([`battle:${id(2)}`]);
    expect(d.asked).toEqual([[id(2)]]);
  });

  it('keeps what the server does not answer for, until 24 h without a save', async () => {
    const d = deps([ws(1), ws(2, STALE_WORKSPACE_MS + 1), ws(3, STALE_WORKSPACE_MS - 1)], {});
    expect(await pruneBattleWorkspaces(d, null)).toEqual([`battle:${id(2)}`]);
    // The old one is not even asked about.
    expect(d.asked).toEqual([[id(1), id(3)]]);
  });

  it('a server error keeps everything recent', async () => {
    const d = deps([ws(1), ws(2, STALE_WORKSPACE_MS * 2)], new Error('offline'));
    expect(await pruneBattleWorkspaces(d, null)).toEqual([`battle:${id(2)}`]);
  });

  it('drops keys that are not battle ids, ignores other workspaces, and never throws', async () => {
    const d = deps(
      [{ id: 'battle:not-a-uuid', updatedAt: NOW }, { id: 'playground', updatedAt: 0 }, ws(1)],
      { [id(1)]: 'destroyed' },
    );
    d.delete = (wid) =>
      wid === `battle:${id(1)}` ? Promise.reject(new Error('blocked')) : Promise.resolve();
    expect(await pruneBattleWorkspaces(d, null)).toEqual(['battle:not-a-uuid']);
    expect(d.asked).toEqual([[id(1)]]);
    const failing = deps([], {});
    failing.list = () => Promise.reject(new Error('no IndexedDB'));
    expect(await pruneBattleWorkspaces(failing, null)).toEqual([]);
  });
});
