/**
 * How long the permanent pages are cached, and under which tags (T-026). Pure functions, so
 * the rules are unit-tested without Next; the `'use cache'` loaders apply them
 * (lib/solo/public-battle.ts, lib/history/player-history.ts) and the admin actions revalidate
 * the tags (app/admin/actions.ts).
 *
 * Lifetimes are `cacheLife()` values in seconds:
 * - `revalidate`: after this, the next request still gets the cached copy and regenerates it
 *   in the background (stale-while-revalidate);
 * - `expire`: after this, a request waits for a fresh copy (honoured by `next start` and by
 *   every `'use cache'` read; the OpenNext cache interceptor only looks at `revalidate`);
 * - `stale`: how long the browser's router may reuse the payload without asking. 30 s
 *   everywhere: short, so a takedown does not hide behind a router cache for long, and the
 *   least Next still treats as prefetchable.
 *
 * A `'use cache'` result lowers the lifetime of the ISR page that reads it, so the page of a
 * battle lives exactly as long as its data.
 */
import type { PlayerHistory } from '../history/player-history';
import type { PublicBattle } from '../solo/types';

export interface CacheLifetime {
  stale: number;
  revalidate: number;
  expire: number;
}

/**
 * A battle whose public data can no longer change by itself: DESTROYED with `destroyed_at`
 * set (the screenshots are in, the sources are gone). From then on only a takedown changes
 * it, and the takedown revalidates its tag. The hour is a safety net (a takedown made with
 * SQL, or a tag write that failed), not something the page needs.
 */
export const SETTLED_BATTLE: CacheLifetime = { stale: 30, revalidate: 3600, expire: 86_400 };

/**
 * A battle in RESULTS, or DESTROYED while its destroy job has not finished: the screenshots
 * land, then `destroyed_at`. Fresh within seconds.
 */
export const LIVE_BATTLE: CacheLifetime = { stale: 30, revalidate: 5, expire: 60 };

/**
 * No public battle with this id (unknown, or not in RESULTS yet): `get_public_battle`'s
 * `battle_not_found`. Short, so a battle that reaches RESULTS gets its page within seconds
 * instead of a 404 cached for good. A malformed id never becomes valid, so its 404 may stay.
 */
export const MISSING_BATTLE: CacheLifetime = { stale: 30, revalidate: 5, expire: 60 };
export const MALFORMED_ID: CacheLifetime = SETTLED_BATTLE;

/**
 * A player's history page: a new battle lands whenever the player finishes one (in the
 * database, not through this app), so a short lifetime; a takedown revalidates it at once
 * through the tags of the battles it lists.
 */
export const PLAYER_HISTORY: CacheLifetime = { stale: 30, revalidate: 30, expire: 60 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The tag of everything that shows a battle: `/battles/{id}`, its OG image, and every history
 * page that lists it (`/u/{builder}` included). Revalidated by a takedown in that battle.
 */
export function battleTag(battleId: string): string {
  return `battle:${battleId.toLowerCase()}`;
}

/** The tag of every page of one player's history. */
export function playerTag(userId: string): string {
  return `player:${userId.toLowerCase()}`;
}

/** Whether a battle's public data can still change without a takedown (see SETTLED_BATTLE). */
export function isSettled(battle: PublicBattle['battle']): boolean {
  return battle.phase === 'destroyed' && battle.destroyed_at !== null;
}

/** The lifetime of `get_public_battle`'s answer for `id` (and of the pages that show it). */
export function battleLifetime(id: string, data: PublicBattle | null): CacheLifetime {
  if (!UUID.test(id.toLowerCase())) return MALFORMED_ID;
  if (!data) return MISSING_BATTLE;
  return isSettled(data.battle) ? SETTLED_BATTLE : LIVE_BATTLE;
}

/** The tags of one battle's page and OG image. */
export function battleTags(id: string): string[] {
  return [battleTag(id)];
}

/**
 * The tags a takedown in battle `battleId` revalidates (`admin_take_down_build` returns the
 * battle id): its page, its OG image and every history page that lists it, the builder's
 * included. Nothing for an answer without a valid id.
 */
export function takedownTags(battleId: unknown): string[] {
  return typeof battleId === 'string' && UUID.test(battleId.toLowerCase())
    ? [battleTag(battleId)]
    : [];
}

/**
 * The paths a takedown in battle `battleId` expires a second time, TAKEDOWN_REEXPIRE_MS
 * later (app/admin/actions.ts): the battle's page and its OG image.
 */
export function takedownPaths(battleId: unknown): string[] {
  if (takedownTags(battleId).length === 0) return [];
  const id = String(battleId).toLowerCase();
  return [`/battles/${id}`, `/battles/${id}/opengraph-image`];
}

/**
 * How long after a takedown its pages are expired a second time: longer than any render of
 * them takes, so a copy rendered from data read just before the takedown, and stored just
 * after it, is thrown away too. Well within the 30 s Workers keep `waitUntil` work alive
 * after the response.
 */
export const TAKEDOWN_REEXPIRE_MS = 10_000;

/**
 * The tags of one page of a player's history: the player's, plus one per battle listed (a
 * takedown in any of them changes this page).
 */
export function historyTags(userId: string, data: PlayerHistory | null): string[] {
  return [playerTag(userId), ...(data?.battles ?? []).map((b) => battleTag(b.battle_id))];
}
