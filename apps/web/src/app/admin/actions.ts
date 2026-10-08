'use server';

/**
 * The admin server actions (T-024): sign in, sign out, dismiss reports, take a build down.
 * Every action re-reads the session cookie and calls the RPC with the admin's own token, so
 * Postgres (`is_admin()`) decides, not this code. Next.js checks the Origin of server action
 * posts, and the cookies are SameSite=Strict, httpOnly and scoped to /admin.
 *
 * Of these, only a takedown changes public pages (T-026): it expires the cached copies of
 * the battle's page, its OG image and the history pages that list it. Dismissing reports
 * changes nothing public (reports are never shown).
 */
import { updateTag } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { takedownTags } from '../../lib/cache/policy';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE_S,
  adminRpc,
  cookieOptions,
  isAdminToken,
  jwtSecondsLeft,
  passwordSignIn,
  refreshSession,
  signOutSession,
  type AdminTokens,
} from '../../lib/admin/session';

/** A text field of the form ('' when missing or a file). */
function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v : '';
}

async function secureCookies(): Promise<boolean> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? h.get('origin')?.split(':')[0] ?? 'http';
  return proto === 'https';
}

async function storeTokens(tokens: AdminTokens): Promise<void> {
  const jar = await cookies();
  const secure = await secureCookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.expiresIn, secure));
  jar.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE_S, secure));
}

async function clearTokens(): Promise<void> {
  const jar = await cookies();
  const secure = await secureCookies();
  jar.set(ACCESS_COOKIE, '', cookieOptions(0, secure));
  jar.set(REFRESH_COOKIE, '', cookieOptions(0, secure));
}

/** The admin's token for an action (refreshed when needed), or a 404. */
async function adminToken(): Promise<string> {
  const jar = await cookies();
  let access = jar.get(ACCESS_COOKIE)?.value;
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if ((!access || (jwtSecondsLeft(access) ?? -1) < 30) && refresh) {
    const tokens = await refreshSession(refresh);
    if (tokens) {
      await storeTokens(tokens);
      access = tokens.accessToken;
    }
  }
  if (!access || !(await isAdminToken(access))) notFound();
  return access;
}

/** Email + password. Only an admin account gets a session here. */
export async function signInAction(formData: FormData): Promise<void> {
  const email = field(formData, 'email').trim();
  const password = field(formData, 'password');
  const tokens = email && password ? await passwordSignIn(email, password) : null;
  if (!tokens) redirect('/admin/sign-in?error=credentials');
  if (!(await isAdminToken(tokens.accessToken))) {
    // A real account without the role: end that session at once, same answer as a typo.
    await signOutSession(tokens.accessToken);
    redirect('/admin/sign-in?error=credentials');
  }
  await storeTokens(tokens);
  redirect('/admin');
}

export async function signOutAction(): Promise<void> {
  const access = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (access) await signOutSession(access);
  await clearTokens();
  redirect('/');
}

function backTo(formData: FormData, params: Record<string, string>): string {
  const view = field(formData, 'view');
  const q = new URLSearchParams(params);
  if (view === 'resolved') q.set('view', 'resolved');
  return `/admin?${q.toString()}`;
}

export async function dismissReportsAction(formData: FormData): Promise<void> {
  const token = await adminToken();
  const buildId = field(formData, 'build_id');
  const note = field(formData, 'note');
  const res = await adminRpc<{ dismissed: number }>(token, 'admin_dismiss_reports', {
    p_build_id: buildId,
    p_note: note || null,
  });
  redirect(
    backTo(
      formData,
      res.error
        ? { error: res.error }
        : { done: 'dismissed', build: buildId, n: String(res.data?.dismissed ?? 0) },
    ),
  );
}

export async function takeDownAction(formData: FormData): Promise<void> {
  const token = await adminToken();
  const buildId = field(formData, 'build_id');
  const note = field(formData, 'note');
  const res = await adminRpc<{ retried: boolean; battle_id?: unknown }>(
    token,
    'admin_take_down_build',
    { p_build_id: buildId, p_note: note || null },
  );
  // The battle id comes from the server's answer, not from the form. `updateTag` expires the
  // copies at once: the next visitor waits for a fresh render instead of getting the cached
  // one while it regenerates. Also on a retry (cheap, and it repairs a missed revalidation).
  if (res.data) for (const tag of takedownTags(res.data.battle_id)) updateTag(tag);
  redirect(
    backTo(
      formData,
      res.error
        ? { error: res.error }
        : { done: res.data?.retried ? 'retried' : 'taken_down', build: buildId },
    ),
  );
}
