/**
 * The browser's Supabase client: one per tab, session in localStorage, anonymous sign-in on
 * demand ("no accounts required", docs/01 §1.5). Realtime is not used in M2 (the solo game
 * polls), so no socket is opened.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './config';
import { getCaptchaToken } from './turnstile';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  client ??= createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'br-auth',
    },
  });
  return client;
}

/**
 * Makes sure the tab has a session, signing in anonymously if needed. Returns the user id.
 * A refresh keeps the same anonymous user (the session is stored), which is what lets a
 * player resume a running battle. With `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, a Turnstile
 * token goes with the sign-up (turnstile.ts); without it (local, tests) none is sent.
 */
export async function ensureSignedIn(
  supabase: SupabaseClient = getSupabase(),
  captcha: () => Promise<string | undefined> = getCaptchaToken,
): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const captchaToken = await captcha();
  const { data: signedIn, error } = await supabase.auth.signInAnonymously(
    captchaToken ? { options: { captchaToken } } : undefined,
  );
  if (error) throw error;
  const id = signedIn.user?.id;
  if (!id) throw new Error('anonymous sign-in returned no user');
  return id;
}
