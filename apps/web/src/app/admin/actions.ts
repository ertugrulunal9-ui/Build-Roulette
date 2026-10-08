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
 *
 * T-030 (runbooks): "Refresh public copies" expires a battle's cached pages by hand (after a
 * takedown made with SQL, or a revalidation that went missing; docs/runbooks/
 * cache-not-revalidating.md), and "Send a test error" checks the server's Sentry setup.
 */
import { revalidatePath, updateTag } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';
import { TAKEDOWN_REEXPIRE_MS, takedownPaths, takedownTags } from '../../lib/cache/policy';
import { TEST_ERROR_MESSAGE, serverReportingEnabled } from '../../lib/telemetry/config';
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

/**
 * Expires every cached copy that shows battle `battleId` (its page, its OG image, the history
 * pages that list it): the next visitor waits for a fresh render instead of getting the old
 * copy while it regenerates. The id comes from the RPC's answer, not from the form.
 *
 * A render that read the battle just before the takedown can store its copy just after
 * this, and that copy would look newer than the expiry. So the battle's page and OG image
 * are expired once more a little later, after the response (`after`: `waitUntil` on
 * Workers), by path: OpenNext writes a tag only once per request, and a path expiry also
 * reaches the cached data those two read. (A history's data is at most a minute old anyway.)
 */
function expirePublicCopies(battleId: unknown): void {
  const tags = takedownTags(battleId);
  if (tags.length === 0) return;
  for (const tag of tags) updateTag(tag);
  const paths = takedownPaths(battleId);
  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, TAKEDOWN_REEXPIRE_MS));
    for (const path of paths) revalidatePath(path);
  });
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
  // Also on a retry: cheap, and it repairs a revalidation that went missing.
  if (res.data) expirePublicCopies(res.data.battle_id);
  redirect(
    backTo(
      formData,
      res.error
        ? { error: res.error }
        : { done: res.data?.retried ? 'retried' : 'taken_down', build: buildId },
    ),
  );
}

/**
 * Expires the cached copies of one battle's public pages (page, OG image, the histories that
 * list it), like a takedown does. The battle id is checked through `admin_battle_log` (which
 * also logs the lookup), so only an existing battle is touched.
 */
export async function refreshPublicCopiesAction(formData: FormData): Promise<void> {
  const token = await adminToken();
  const battleId = field(formData, 'battle_id');
  const res = await adminRpc<{ battle: { id: string } }>(token, 'admin_battle_log', {
    p_battle_id: battleId,
  });
  if (!res.data) {
    redirect(
      `/admin?${new URLSearchParams({ error: res.error ?? 'battle_not_found' }).toString()}`,
    );
  }
  expirePublicCopies(res.data.battle.id);
  redirect(
    `/admin?${new URLSearchParams({ q: res.data.battle.id, done: 'refreshed' }).toString()}`,
  );
}

/**
 * The Health section's "Send a test error": with server error reporting on, it throws, so
 * the error takes the real path (Next's `onRequestError` → Sentry, on Node or on Workers)
 * and the admin sees the error screen with its digest, which is also the event's `digest`
 * tag in Sentry. With reporting off it says so instead.
 */
export async function sendTestErrorAction(): Promise<void> {
  await adminToken();
  if (!serverReportingEnabled()) redirect('/admin?done=test_error_off');
  throw new Error(TEST_ERROR_MESSAGE);
}
