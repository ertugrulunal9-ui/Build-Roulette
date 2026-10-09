/**
 * A battle's permanent results (`get_public_battle`, callable with the anon key). Read in the
 * browser by /battles/{id} (components/results/BattleView, T-037: the page is a static shell
 * and loads its data itself). Plain fetch with the public anon key, no session: the answer is
 * the same for every viewer, and nothing about the viewer is sent.
 *
 * No cache anywhere: every page load asks the database, so a takedown shows on the very next
 * load (T-026's ISR and tag revalidation are gone with the server).
 */
import { supabaseConfig, type SupabaseConfig } from '../supabase/config';
import type { PublicBattle } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` can be a battle id at all (anything else is "not found" without a request). */
export function isBattleId(id: string): boolean {
  return UUID.test(id.toLowerCase());
}

/**
 * The battle's public results, or null when it does not exist or is not public yet
 * (`battle_not_found` covers both) or `id` is not a battle id. Throws on other failures (the
 * server is down), so the page can tell "not found" from "could not load".
 *
 * Also called at the edge by T-038's link-preview Function (lib/hosting/preview-worker.ts),
 * with a `signal` that aborts a slow answer.
 */
export async function fetchPublicBattle(
  id: string,
  config: SupabaseConfig = supabaseConfig,
  { signal }: { signal?: AbortSignal } = {},
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
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (res.ok) return (await res.json()) as PublicBattle;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (body?.message === 'battle_not_found') return null;
  throw new Error(`get_public_battle failed: HTTP ${String(res.status)} ${body?.message ?? ''}`);
}
