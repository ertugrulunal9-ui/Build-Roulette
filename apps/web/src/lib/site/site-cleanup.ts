/**
 * Stale battle workspaces in IndexedDB (docs/03 §3.6): each battle keeps its working files
 * under `battle:{id}` until DESTROY deletes them. Copies that a closed tab never got to
 * delete are cleaned up when a battle opens, but only when they are really stale, because
 * another tab of the same browser may be in the middle of its own battle (a solo battle
 * while a room battle opens, two rooms…):
 *
 * - the server says the battle is over: RESULTS (the build is final; the last look reads
 *   the shipped files from storage), DESTROYED or ABANDONED;
 * - or nobody saved it for 24 h (the battles' hard TTL), whatever the server says.
 *
 * A battle the server does not answer for (no access, network error) is kept until then.
 */
import type { BattlePhase } from '@br/game';

/** Untouched this long, a battle workspace is stale even without asking the server. */
export const STALE_WORKSPACE_MS = 24 * 60 * 60 * 1000;

export const BATTLE_WORKSPACE_PREFIX = 'battle:';

const OVER: readonly BattlePhase[] = ['results', 'destroyed', 'abandoned'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredBattleWorkspace {
  /** `battle:{id}` */
  id: string;
  /** Last local save (epoch ms). */
  updatedAt: number;
}

export interface WorkspaceCleanupDeps {
  list(): Promise<StoredBattleWorkspace[]>;
  delete(workspaceId: string): Promise<void>;
  /** The phases of the battles the user may see (others are left out). */
  battlePhases(battleIds: string[]): Promise<Record<string, BattlePhase>>;
  now(): number;
}

/**
 * Deletes the stale battle workspaces except `keepId` (the battle being opened). Returns
 * the deleted workspace ids. Never throws.
 */
export async function pruneBattleWorkspaces(
  deps: WorkspaceCleanupDeps,
  keepId: string | null,
): Promise<string[]> {
  let all: StoredBattleWorkspace[];
  try {
    all = await deps.list();
  } catch {
    return [];
  }
  const candidates = all.filter((w) => w.id.startsWith(BATTLE_WORKSPACE_PREFIX) && w.id !== keepId);
  const cutoff = deps.now() - STALE_WORKSPACE_MS;
  const battleId = (w: StoredBattleWorkspace) => w.id.slice(BATTLE_WORKSPACE_PREFIX.length);
  // Too old, or not a battle id at all (no server could know it).
  const stale = new Set(
    candidates.filter((w) => w.updatedAt < cutoff || !UUID.test(battleId(w))).map((w) => w.id),
  );

  const ask = candidates.filter((w) => !stale.has(w.id));
  if (ask.length > 0) {
    try {
      const phases = await deps.battlePhases(ask.map(battleId));
      for (const w of ask) {
        const phase = phases[battleId(w)];
        if (phase !== undefined && OVER.includes(phase)) stale.add(w.id);
      }
    } catch {
      // The server cannot tell now: keep them (the next battle that opens asks again).
    }
  }

  const deleted: string[] = [];
  for (const id of stale) {
    try {
      await deps.delete(id);
      deleted.push(id);
    } catch {
      // Blocked storage: try again next time.
    }
  }
  return deleted;
}
