/**
 * The /admin pages' session check (server only). Anyone who is not a signed-in admin gets
 * the plain 404 page: no cookie, an expired session that cannot be refreshed, or a
 * non-admin account. The check is `is_admin()` in Postgres, with the token from the cookie.
 */
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  isAdminToken,
  jwtSecondsLeft,
} from '../../lib/admin/session';

/** The admin's access token for a page render, or a 404 (or a hop to refresh it). */
export async function requireAdminPage(path: string): Promise<string> {
  const jar = await cookies();
  const access = jar.get(ACCESS_COOKIE)?.value;
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!access && !refresh) notFound();
  if (!access || (jwtSecondsLeft(access) ?? -1) < 30) {
    // A page render cannot set cookies: refresh in the route handler, then come back.
    if (refresh) redirect(`/admin/session?next=${encodeURIComponent(path)}`);
    notFound();
  }
  if (!(await isAdminToken(access))) notFound();
  return access;
}
