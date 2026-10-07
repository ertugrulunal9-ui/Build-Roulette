/**
 * The admin session (T-024), server side only: Supabase Auth email/password tokens kept in
 * httpOnly cookies scoped to /admin, and the admin RPCs called with the admin's own token.
 * There is no service key in the web app: every admin RPC checks `is_admin()` in Postgres,
 * so the cookie only ever carries a user's normal access token.
 *
 * Players never have these cookies (their anonymous session lives in localStorage), so for
 * them /admin is simply a 404. Plain fetch, so it runs the same on Node and on Workers.
 */
import { supabaseConfig, type SupabaseConfig } from '../supabase/config';

export const ACCESS_COOKIE = 'br_admin_at';
export const REFRESH_COOKIE = 'br_admin_rt';
/** The admin cookies live only under /admin. */
export const COOKIE_PATH = '/admin';
/** How long the refresh token cookie lasts (a moderator signs in again after a week). */
export const REFRESH_MAX_AGE_S = 7 * 24 * 3600;

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime, seconds. */
  expiresIn: number;
}

export interface RpcResult<T> {
  data: T | null;
  /** The stable error code (`message`), or null. */
  error: string | null;
  details: string | null;
  status: number;
}

function headers(config: SupabaseConfig, token?: string): Record<string, string> {
  const h: Record<string, string> = { apikey: config.anonKey, 'content-type': 'application/json' };
  if (token) h['authorization'] = `Bearer ${token}`;
  else if (config.anonKey.startsWith('eyJ')) h['authorization'] = `Bearer ${config.anonKey}`;
  return h;
}

async function authToken(
  grant: 'password' | 'refresh_token',
  body: Record<string, string>,
  config: SupabaseConfig,
): Promise<AdminTokens | null> {
  const res = await fetch(`${config.url}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) return null;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
  };
}

/** Email + password sign-in. Null for wrong credentials (or Auth refusing). */
export function passwordSignIn(
  email: string,
  password: string,
  config: SupabaseConfig = supabaseConfig,
): Promise<AdminTokens | null> {
  return authToken('password', { email, password }, config);
}

/** A fresh access token from the refresh token. Null when the session is gone. */
export function refreshSession(
  refreshToken: string,
  config: SupabaseConfig = supabaseConfig,
): Promise<AdminTokens | null> {
  return authToken('refresh_token', { refresh_token: refreshToken }, config);
}

/** Revokes the session (best effort). */
export async function signOutSession(
  accessToken: string,
  config: SupabaseConfig = supabaseConfig,
): Promise<void> {
  await fetch(`${config.url}/auth/v1/logout`, {
    method: 'POST',
    headers: headers(config, accessToken),
    cache: 'no-store',
  }).catch(() => undefined);
}

/** Calls an RPC as the signed-in admin. */
export async function adminRpc<T>(
  token: string,
  fn: string,
  args: Record<string, unknown> = {},
  config: SupabaseConfig = supabaseConfig,
): Promise<RpcResult<T>> {
  const res = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(config, token),
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.ok) return { data: body as T, error: null, details: null, status: res.status };
  const err = (body ?? {}) as { message?: string; details?: string };
  return {
    data: null,
    error: err.message ?? `http_${String(res.status)}`,
    details: err.details ?? null,
    status: res.status,
  };
}

/** True when the token belongs to an admin (`is_admin()` in Postgres). */
export async function isAdminToken(
  token: string,
  config: SupabaseConfig = supabaseConfig,
): Promise<boolean> {
  const res = await adminRpc<boolean>(token, 'is_admin', {}, config);
  return res.data === true;
}

/** Seconds until the JWT expires (negative when expired); null when it cannot be read. */
export function jwtSecondsLeft(token: string, now: number = Date.now()): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof json.exp === 'number' ? json.exp - Math.floor(now / 1000) : null;
  } catch {
    return null;
  }
}

/** Cookie options for the admin cookies. */
export function cookieOptions(maxAge: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: COOKIE_PATH,
    maxAge,
  };
}

/** Only same-site /admin paths are valid redirect targets. */
export function safeAdminPath(next: string | null | undefined): string {
  return typeof next === 'string' && /^\/admin(?:[/?#]|$)/.test(next) && !next.startsWith('//')
    ? next
    : '/admin';
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
