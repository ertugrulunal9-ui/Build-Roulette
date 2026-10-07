/**
 * GET /admin/session?next=/admin… : refreshes the admin session (a page render cannot set
 * cookies) and goes back to `next`. Without a usable refresh token the cookies are cleared
 * and the visitor lands on /admin, which is then a 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE_S,
  cookieOptions,
  refreshSession,
  safeAdminPath,
} from '../../../lib/admin/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const next = safeAdminPath(request.nextUrl.searchParams.get('next'));
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const tokens = refresh ? await refreshSession(refresh) : null;
  const res = NextResponse.redirect(new URL(tokens ? next : '/admin', request.url), 303);
  const secure = request.nextUrl.protocol === 'https:';
  if (tokens) {
    res.cookies.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.expiresIn, secure));
    res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE_S, secure));
  } else {
    res.cookies.set(ACCESS_COOKIE, '', cookieOptions(0, secure));
    res.cookies.set(REFRESH_COOKIE, '', cookieOptions(0, secure));
  }
  res.headers.set('cache-control', 'no-store');
  return res;
}
