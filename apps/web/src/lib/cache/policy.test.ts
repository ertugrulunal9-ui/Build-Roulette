/**
 * The caching rules of the permanent pages (T-026): which battle states are cached for long,
 * and the tags of each page.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryBattle, PlayerHistory } from '../history/player-history';
import type { PublicBattle } from '../solo/types';
import {
  LIVE_HISTORY,
  LIVE_BATTLE,
  MALFORMED_ID,
  MISSING_BATTLE,
  PLAYER_HISTORY,
  SETTLED_BATTLE,
  TAKEDOWN_REEXPIRE_MS,
  battleLifetime,
  battleTag,
  battleTags,
  historyLifetime,
  historyTags,
  isSettled,
  playerTag,
  takedownPaths,
  takedownTags,
  type CacheLifetime,
} from './policy';

const ID = 'b0260000-0000-4000-8000-000000000001';

function battle(patch: Partial<PublicBattle['battle']>): PublicBattle {
  return {
    battle: {
      id: ID,
      mode: 'solo',
      phase: 'results',
      is_complete: true,
      building_started_at: '2026-10-08T11:50:00Z',
      building_ends_at: '2026-10-08T11:55:00Z',
      finished_at: '2026-10-08T11:56:00Z',
      destroyed_at: null,
      created_at: '2026-10-08T11:49:00Z',
      ...patch,
    },
    challenge: {
      build: { text: 'A cache probe', hint: null },
      rule: { text: 'No rules', hint: null },
      style: { text: 'Plain', hint: null },
      time_limit_seconds: 300,
    },
    players: ['Iris'],
    builds: [],
    awards: [],
  };
}

describe('battleLifetime', () => {
  it('caches a battle for long only once it is DESTROYED with destroyed_at set', () => {
    expect(
      battleLifetime(ID, battle({ phase: 'destroyed', destroyed_at: '2026-10-08T12:10:00Z' })),
    ).toBe(SETTLED_BATTLE);
    expect(
      isSettled(battle({ phase: 'destroyed', destroyed_at: '2026-10-08T12:10:00Z' }).battle),
    ).toBe(true);
  });

  it('keeps a battle that can still change fresh within seconds', () => {
    // RESULTS: the screenshots land, then destroyed_at. is_complete is already true then.
    expect(battleLifetime(ID, battle({ phase: 'results', is_complete: true }))).toBe(LIVE_BATTLE);
    // DESTROYED while the destroy job has not stamped destroyed_at yet.
    expect(battleLifetime(ID, battle({ phase: 'destroyed', destroyed_at: null }))).toBe(
      LIVE_BATTLE,
    );
    expect(isSettled(battle({ phase: 'results' }).battle)).toBe(false);
  });

  it('caches "no such public battle" for seconds, a malformed id for long', () => {
    expect(battleLifetime(ID, null)).toBe(MISSING_BATTLE);
    expect(battleLifetime(ID.toUpperCase(), null)).toBe(MISSING_BATTLE);
    expect(battleLifetime('not-a-battle', null)).toBe(MALFORMED_ID);
    expect(MALFORMED_ID.revalidate).toBeGreaterThanOrEqual(SETTLED_BATTLE.revalidate);
  });

  it('uses lifetimes an ISR page can take', () => {
    const all: CacheLifetime[] = [
      SETTLED_BATTLE,
      LIVE_BATTLE,
      MISSING_BATTLE,
      PLAYER_HISTORY,
      LIVE_HISTORY,
    ];
    for (const life of all) {
      // 0 would make an ISR page dynamic at runtime ("Page changed from static to dynamic").
      expect(life.revalidate).toBeGreaterThan(0);
      expect(life.expire).toBeGreaterThanOrEqual(life.revalidate);
      expect(life.stale).toBeGreaterThanOrEqual(30);
    }
    expect(LIVE_BATTLE.revalidate).toBeLessThanOrEqual(5);
    expect(MISSING_BATTLE.revalidate).toBeLessThanOrEqual(5);
    expect(SETTLED_BATTLE.revalidate).toBe(3600);
    // A history is at most a minute old (no stale copy past `expire`).
    expect(PLAYER_HISTORY.expire).toBeLessThanOrEqual(60);
  });
});

describe('historyLifetime', () => {
  const settled = {
    battle_id: ID,
    phase: 'destroyed',
    destroyed_at: '2026-10-08T12:10:00Z',
  } as HistoryBattle;
  const inResults = {
    battle_id: 'b0260000-0000-4000-8000-000000000002',
    phase: 'results',
    destroyed_at: null,
  } as HistoryBattle;

  it('keeps a history of settled battles for up to a minute', () => {
    const page: PlayerHistory = {
      player: { display_name: 'Iris' },
      battles: [settled],
      next: null,
    };
    expect(historyLifetime(page)).toBe(PLAYER_HISTORY);
  });

  it('keeps one with a battle that can still change for seconds', () => {
    const page: PlayerHistory = {
      player: { display_name: 'Iris' },
      battles: [inResults, settled],
      next: null,
    };
    expect(historyLifetime(page)).toBe(LIVE_HISTORY);
    expect(
      historyLifetime({
        ...page,
        battles: [{ ...settled, destroyed_at: null }],
      }),
    ).toBe(LIVE_HISTORY);
  });

  it('never serves "no battles yet" for more than 5 s: the first battle may end right after', () => {
    expect(historyLifetime({ player: null, battles: [], next: null })).toBe(LIVE_HISTORY);
    expect(historyLifetime(null)).toBe(LIVE_HISTORY);
    expect(LIVE_HISTORY.revalidate).toBeLessThanOrEqual(5);
    expect(LIVE_HISTORY.expire).toBe(LIVE_HISTORY.revalidate);
  });
});

describe('tags', () => {
  it('tags a battle page with the battle', () => {
    expect(battleTags(ID)).toEqual([`battle:${ID}`]);
    expect(battleTags(ID.toUpperCase())).toEqual([`battle:${ID}`]);
    expect(battleTag(ID)).toBe(`battle:${ID}`);
  });

  it('tags a history page with the player and every battle it lists', () => {
    const user = 'a0260000-0000-4000-8000-00000000000A';
    const other = 'b0260000-0000-4000-8000-000000000002';
    const page: PlayerHistory = {
      player: { display_name: 'Iris' },
      battles: [{ battle_id: ID } as HistoryBattle, { battle_id: other } as HistoryBattle],
      next: null,
    };
    expect(historyTags(user, page)).toEqual([playerTag(user), `battle:${ID}`, `battle:${other}`]);
    expect(playerTag(user)).toBe(`player:${user.toLowerCase()}`);
    expect(historyTags(user, { player: null, battles: [], next: null })).toEqual([playerTag(user)]);
    expect(historyTags(user, null)).toEqual([playerTag(user)]);
  });

  it('a takedown revalidates the tag every page of its battle shares', () => {
    expect(takedownTags(ID)).toEqual([`battle:${ID}`]);
    expect(takedownTags(ID.toUpperCase())).toEqual([`battle:${ID}`]);
    // Whatever the RPC answer lacks, nothing is revalidated (and nothing throws).
    expect(takedownTags(undefined)).toEqual([]);
    expect(takedownTags(null)).toEqual([]);
    expect(takedownTags(42)).toEqual([]);
    expect(takedownTags('battle')).toEqual([]);
    // The history pages that list the battle carry the same tag.
    expect(
      historyTags('a0260000-0000-4000-8000-00000000000a', {
        player: { display_name: 'Iris' },
        battles: [{ battle_id: ID } as HistoryBattle],
        next: null,
      }),
    ).toContain(takedownTags(ID)[0]);
  });

  it('expires the page once more a little later', () => {
    expect(takedownPaths(ID.toUpperCase())).toEqual([`/battles/${ID}`]);
    expect(takedownPaths(undefined)).toEqual([]);
    expect(takedownPaths('../admin')).toEqual([]);
  });

  it('expires a takedown once more within the time Workers keep a request alive', () => {
    expect(TAKEDOWN_REEXPIRE_MS).toBeGreaterThanOrEqual(5_000);
    expect(TAKEDOWN_REEXPIRE_MS).toBeLessThan(30_000);
  });
});
