/**
 * Stale battle sites in IndexedDB (docs/09 §9.5): each battle keeps its latest imported site
 * pack under `battle:{id}` (local-sites.ts) until DESTROY deletes it. Copies that a closed
 * tab never got to delete are cleaned up when a battle opens, but only when they are really
 * stale, because another tab of the same browser may be in the middle of its own battle (a
 * solo battle while a room battle opens, two rooms…):
 *
 * - the server says the battle is over: RESULTS (the build is final; the last look reads
 *   the shipped files from storage), DESTROYED or ABANDONED;
 * - or nobody saved it for 24 h (the battles' hard TTL), whatever the server says.
 *
 * A battle the server does not answer for (no access, network error) is kept until then.
 */
import type { BattlePhase } from '@br/game';

/** Untouched this long, a battle site is stale even without asking the server. */
export const STALE_SITE_MS = 24 * 60 * 60 * 1000;

export const BATTLE_SITE_PREFIX = 'battle:';

const OVER: readonly BattlePhase[] = ['results', 'destroyed', 'abandoned'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredBattleSite {
  /** `battle:{id}` */
  id: string;
  /** Last local save (epoch ms). */
  updatedAt: number;
}

export interface SiteCleanupDeps {
  list(): Promise<StoredBattleSite[]>;
  delete(key: string): Promise<void>;
  /** The phases of the battles the user may see (others are left out). */
  battlePhases(battleIds: string[]): Promise<Record<string, BattlePhase>>;
  now(): number;
}

/**
 * Deletes the stale battle sites except `keepId` (the battle being opened). Returns the
 * deleted keys. Never throws.
 */
export async function pruneBattleSites(
  deps: SiteCleanupDeps,
  keepId: string | null,
): Promise<string[]> {
  let all: StoredBattleSite[];
  try {
    all = await deps.list();
  } catch {
    return [];
  }
  const candidates = all.filter((w) => w.id.startsWith(BATTLE_SITE_PREFIX) && w.id !== keepId);
  const cutoff = deps.now() - STALE_SITE_MS;
  const battleId = (w: StoredBattleSite) => w.id.slice(BATTLE_SITE_PREFIX.length);
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
