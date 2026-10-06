/**
 * Server-side read of a battle's permanent results (`get_public_battle`, callable with the
 * anon key). Used by /battles/[id] and its OG image. Plain fetch, so it runs the same on
 * Node and on Cloudflare Workers.
 */
import { cache } from 'react';
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
    // Results change while a capture is pending; ISR on the R2 cache is a follow-up.
    cache: 'no-store',
  });
  if (res.ok) return (await res.json()) as PublicBattle;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (body?.message === 'battle_not_found') return null;
  throw new Error(`get_public_battle failed: HTTP ${String(res.status)} ${body?.message ?? ''}`);
}

/** Deduplicated per request (generateMetadata and the page both read it). */
export const getPublicBattle = cache((id: string) => fetchPublicBattle(id));
