/**
 * Server-side read of a player's history (`get_player_history`, callable with the anon key;
 * supabase/README.md "Player history"). Used by /u/[id]. Plain fetch, like the results
 * page, so it runs the same on Node and on Cloudflare Workers.
 *
 * Cached (T-026): `loadPlayerHistory` is a `'use cache'` function (lib/cache/policy.ts: at
 * most a minute old; 5 s while the page is empty or lists a battle that is not settled)
 * tagged with the player and with every battle on the page, so a takedown in any of them
 * revalidates it at once.
 */
import { cacheLife, cacheTag } from 'next/cache';
import { cache } from 'react';
import { historyLifetime, historyTags } from '../cache/policy';
import type { AwardKind, BuildStatus, CaptureStatus, VoteCounts } from '../solo/types';
import { supabaseConfig, type SupabaseConfig } from '../supabase/config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Battles per page of /u/[id]. */
export const HISTORY_PAGE_SIZE = 10;

/** One battle of the history: permanent data of the player's own build only. */
export interface HistoryBattle {
  battle_id: string;
  mode: string;
  phase: 'results' | 'destroyed';
  finished_at: string;
  destroyed_at: string | null;
  /** The player's display name in this battle. */
  display_name: string;
  challenge: {
    build: { text: string };
    rule: { text: string };
    style: { text: string };
    time_limit_seconds: number;
  };
  /** N in "rank k of N". */
  players_count: number;
  build: {
    id: string;
    name: string | null;
    status: BuildStatus;
    completion_ms: number | null;
    final_rank: number | null;
    total_votes: number;
    votes: VoteCounts | null;
    capture_status: CaptureStatus;
    screenshot_path: string | null;
    /** T-024: removed by moderators (no name, no screenshot; rank and votes kept). */
    taken_down?: boolean;
  };
  awards: { award: AwardKind; source: 'vote' | 'auto'; votes: number | null }[];
}

/** The cursor of the next (older) page. */
export interface HistoryCursor {
  before: string;
  before_battle: string;
}

export interface PlayerHistory {
  /** null: no such player, or no public battle yet (the same answer on purpose). */
  player: { display_name: string } | null;
  battles: HistoryBattle[];
  next: HistoryCursor | null;
}

/**
 * The cursor from the page's query string (`?before=…&before_battle=…`), or null when it is
 * missing or malformed (a malformed one shows the first page rather than an error).
 */
export function parseCursor(params: {
  before?: string | string[];
  before_battle?: string | string[];
}): HistoryCursor | null {
  const before = typeof params.before === 'string' ? params.before : null;
  const battle =
    typeof params.before_battle === 'string' ? params.before_battle.toLowerCase() : null;
  if (!before || !battle || !UUID.test(battle) || Number.isNaN(Date.parse(before))) return null;
  return { before, before_battle: battle };
}

/** `/u/{id}?before=…&before_battle=…` for the page after `cursor`. */
export function historyHref(userId: string, cursor: HistoryCursor | null): string {
  if (!cursor) return `/u/${userId}`;
  const q = new URLSearchParams({ before: cursor.before, before_battle: cursor.before_battle });
  return `/u/${userId}?${q.toString()}`;
}

/** Whether `id` can be a user id at all (anything else is a 404 without a request). */
export function isUserId(id: string): boolean {
  return UUID.test(id.toLowerCase());
}

/**
 * One page of the player's history, or null when `id` is not a uuid. Throws when the
 * server fails (the page then shows Next's error page, not "no battles").
 */
export async function fetchPlayerHistory(
  id: string,
  cursor: HistoryCursor | null,
  limit = HISTORY_PAGE_SIZE,
  config: SupabaseConfig = supabaseConfig,
): Promise<PlayerHistory | null> {
  const userId = id.toLowerCase();
  if (!UUID.test(userId)) return null;
  const headers: Record<string, string> = {
    apikey: config.anonKey,
    'content-type': 'application/json',
  };
  // A legacy anon key is a JWT and also goes in Authorization; a publishable key does not.
  if (config.anonKey.startsWith('eyJ')) headers['authorization'] = `Bearer ${config.anonKey}`;
  const res = await fetch(`${config.url}/rest/v1/rpc/get_player_history`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      p_user_id: userId,
      p_before: cursor?.before ?? null,
      p_before_battle: cursor?.before_battle ?? null,
      p_limit: limit,
    }),
    // The data cache stays out of it: loadPlayerHistory caches the parsed answer instead.
    cache: 'no-store',
  });
  if (res.ok) return (await res.json()) as PlayerHistory;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  throw new Error(`get_player_history failed: HTTP ${String(res.status)} ${body?.message ?? ''}`);
}

/**
 * `fetchPlayerHistory`, cached across requests (see the top of this file). A failed read
 * throws and is not cached.
 */
export async function loadPlayerHistory(
  id: string,
  before: string | null,
  beforeBattle: string | null,
): Promise<PlayerHistory | null> {
  'use cache';
  const data = await fetchPlayerHistory(
    id,
    before && beforeBattle ? { before, before_battle: beforeBattle } : null,
  );
  cacheLife(historyLifetime(data));
  cacheTag(...historyTags(id, data));
  return data;
}

/** Deduplicated per request (generateMetadata and the page both read it). */
export const getPlayerHistory = cache(
  (id: string, before: string | null, beforeBattle: string | null) =>
    loadPlayerHistory(id.toLowerCase(), before, beforeBattle?.toLowerCase() ?? null),
);
