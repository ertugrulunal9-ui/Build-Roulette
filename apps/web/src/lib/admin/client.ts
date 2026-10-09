/**
 * The moderators' session (T-024, client-side since T-037): a Supabase Auth email/password
 * session in the browser, kept apart from the player's anonymous one. The admin RPCs are
 * called with that session's own access token, and Postgres decides (`is_admin()` in every
 * admin RPC): the web app has no service key and no server.
 *
 * Kept apart how (apps/web/README.md "Moderation" has the trade-offs against T-024's httpOnly
 * cookies):
 *
 * - **A client of its own.** The player's client (lib/supabase/browser.ts) keeps its anonymous
 *   session in localStorage under `br-auth`. Signing a moderator in through it would replace
 *   that session (the player would lose their battles in this browser) and send every player
 *   RPC with the moderator's token. This client has its own key, `br-admin-auth`, and nothing
 *   else in the app uses it.
 * - **This tab only, and gone with it.** The session is held in memory by supabase-js
 *   (`persistSession: false`) and saved to this tab's `sessionStorage` so a reload or a link
 *   inside `/admin` keeps it. Not localStorage: it would outlive the tab and the browser
 *   session, and reach every tab of the origin. Not supabase-js's own persistence either: it
 *   also announces every sign-in and token refresh, session included, on a `BroadcastChannel`
 *   that any page of the origin can listen to, so a player tab would hear the moderator's
 *   tokens. A new tab signs in again; closing the tab ends the session in this browser.
 * - **Sign-out** revokes the session at Supabase Auth (its refresh token stops working) and
 *   removes it from memory and from sessionStorage.
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig, type SupabaseConfig } from '../supabase/config';
import { getCaptchaToken } from '../supabase/turnstile';

/** The sessionStorage key of the moderator's session (and supabase-js's lock name). */
export const ADMIN_STORAGE_KEY = 'br-admin-auth';

export interface RpcResult<T> {
  data: T | null;
  /** The stable error code (PostgREST's `message`, e.g. `not_admin`), or null. */
  error: string | null;
  details: string | null;
  status: number;
}

interface SavedSession {
  access_token: string;
  refresh_token: string;
}

function readSaved(store: Storage | null): SavedSession | null {
  try {
    const raw = store?.getItem(ADMIN_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedSession>;
    return typeof v.access_token === 'string' && typeof v.refresh_token === 'string'
      ? { access_token: v.access_token, refresh_token: v.refresh_token }
      : null;
  } catch {
    return null;
  }
}

function save(store: Storage | null, session: Session): void {
  try {
    store?.setItem(
      ADMIN_STORAGE_KEY,
      JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }),
    );
  } catch {
    // Storage blocked: the session lasts as long as the page.
  }
}

function forget(store: Storage | null): void {
  try {
    store?.removeItem(ADMIN_STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

/** This tab's sessionStorage, or null where there is none (blocked, or not a browser). */
export function tabStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface AdminClient {
  supabase: SupabaseClient;
  store: Storage | null;
}

/**
 * A moderator client: supabase-js with its session in memory only (no localStorage, no
 * BroadcastChannel), mirrored into `store` (this tab's sessionStorage) on every sign-in and
 * token refresh, and removed from it on sign-out.
 */
export function createAdminClient(
  config: SupabaseConfig = supabaseConfig,
  store: Storage | null = tabStorage(),
  fetchImpl?: typeof fetch,
): AdminClient {
  const supabase = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: ADMIN_STORAGE_KEY,
    },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') forget(store);
    else if (
      session &&
      (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED')
    ) {
      save(store, session);
    }
  });
  return { supabase, store };
}

let shared: AdminClient | null = null;

/** The page's moderator client (one per page). */
export function getAdminClient(): AdminClient {
  shared ??= createAdminClient();
  return shared;
}

/** Calls an RPC as the signed-in moderator (with no session: as anon, which every admin RPC refuses). */
export async function adminRpc<T>(
  { supabase }: AdminClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<RpcResult<T>> {
  const res = await supabase.rpc(fn, args);
  const { error, status } = res;
  if (!error) return { data: res.data as T, error: null, details: null, status };
  return {
    data: null,
    error: error.message || `http_${String(status)}`,
    details: error.details || null,
    status,
  };
}

/**
 * Restores this tab's saved session (refreshing it when it has expired). Then asks Postgres
 * whether it is an admin's: `admin` or `none`; `none` also drops a session that is no longer
 * an admin's (revoked, or the account lost the role). `error` when the server could not be
 * asked (the session is kept, for a retry).
 */
export async function checkAdmin(client: AdminClient): Promise<'admin' | 'none' | 'error'> {
  const { supabase, store } = client;
  const current = await supabase.auth.getSession();
  if (!current.data.session) {
    const saved = readSaved(store);
    if (!saved) return 'none';
    const { data, error } = await supabase.auth.setSession(saved);
    if (error || !data.session) {
      // A network failure keeps the saved session for the next try; Auth refusing it ends it.
      if (error && (error.status === undefined || error.status === 0)) return 'error';
      forget(store);
      return 'none';
    }
  }
  const res = await adminRpc<boolean>(client, 'is_admin');
  if (res.data === true) return 'admin';
  if (res.data === false || res.status === 401 || res.status === 403) {
    await signOutAdmin(client);
    return 'none';
  }
  return 'error';
}

/**
 * Email + password. Only an account that `is_admin()` accepts keeps a session: any other
 * (wrong details, or a real account without the role) gets `denied` and no session, the same
 * answer for both. With `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, a Turnstile token goes along
 * (Supabase Auth's CAPTCHA protection also covers password sign-ins).
 */
export async function signInAdmin(
  client: AdminClient,
  email: string,
  password: string,
  captcha: () => Promise<string | undefined> = getCaptchaToken,
): Promise<'ok' | 'denied'> {
  if (!email || !password) return 'denied';
  const captchaToken = await captcha();
  const { error } = await client.supabase.auth.signInWithPassword({
    email,
    password,
    ...(captchaToken ? { options: { captchaToken } } : {}),
  });
  if (error) return 'denied';
  const admin = await adminRpc<boolean>(client, 'is_admin');
  if (admin.data !== true) {
    await signOutAdmin(client);
    return 'denied';
  }
  return 'ok';
}

/** Revokes the session at Supabase Auth and removes it from this tab. Never throws. */
export async function signOutAdmin(client: AdminClient): Promise<void> {
  try {
    await client.supabase.auth.signOut();
  } catch {
    // Offline: the local copy goes anyway (below).
  }
  await client.supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  forget(client.store);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{5}$/i;

/** What the lookup box was given: a battle id, a room code, or nothing usable. */
export function parseLookup(
  q: string | null | undefined,
): { kind: 'battle'; id: string } | { kind: 'room'; code: string } | { kind: 'none' } {
  const v = (q ?? '').trim();
  if (UUID.test(v)) return { kind: 'battle', id: v.toLowerCase() };
  if (ROOM_CODE.test(v)) return { kind: 'room', code: v.toUpperCase() };
  return { kind: 'none' };
}
