/**
 * Server-side read of a battle's permanent results (`get_public_battle`, callable with the
 * anon key). Used by /battles/[id] (page and metadata). Plain fetch, so it runs the same on
 * Node and on Cloudflare Workers.
 *
 * Cached (T-026): `loadPublicBattle` is a `'use cache'` function whose lifetime depends on
 * the answer (lib/cache/policy.ts: seconds while the battle can still change, an hour once
 * it is settled) and is tagged `battle:{id}`, which a takedown revalidates. The ISR pages
 * that read it inherit both.
 */
import { cacheLife, cacheTag } from 'next/cache';
import { cache } from 'react';
import { battleLifetime, battleTags } from '../cache/policy';
import { supabaseConfig, type SupabaseConfig } from '../supabase/config';
import type { PublicBattle } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The battle's public results, or null when it does not exist or is not public yet
 * (`battle_not_found` covers both). Throws on other failures (the server is down).
 */
export async function fetchPublicBattle(
  id: string,
  config: SupabaseConfig = supabaseConfig,
): Promise<PublicBattle | null> {
  const battleId = id.toLowerCase();
  if (!UUID.test(battleId)) return null;
  const headers: Record<string, string> = {
    apikey: config.anonKey,
    'content-type': 'application/json',
  };
  // A legacy anon key is a JWT and also goes in Authorization; a publishable key does not.
  if (config.anonKey.startsWith('eyJ')) headers['authorization'] = `Bearer ${config.anonKey}`;
  const res = await fetch(`${config.url}/rest/v1/rpc/get_public_battle`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_battle_id: battleId }),
    // The data cache stays out of it: loadPublicBattle caches the parsed answer instead.
    cache: 'no-store',
  });
  if (res.ok) return (await res.json()) as PublicBattle;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (body?.message === 'battle_not_found') return null;
  throw new Error(`get_public_battle failed: HTTP ${String(res.status)} ${body?.message ?? ''}`);
}

/**
 * `fetchPublicBattle`, cached across requests (see the top of this file). A failed read
 * throws and is not cached: an ISR page then keeps serving its last good copy.
 */
export async function loadPublicBattle(id: string): Promise<PublicBattle | null> {
  'use cache';
  cacheTag(...battleTags(id));
  const data = await fetchPublicBattle(id);
  cacheLife(battleLifetime(id, data));
  return data;
}

/** Deduplicated per request (generateMetadata and the page both read it). */
export const getPublicBattle = cache((id: string) => loadPublicBattle(id.toLowerCase()));
