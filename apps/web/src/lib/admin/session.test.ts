import { describe, expect, it } from 'vitest';
import { cookieOptions, jwtSecondsLeft, parseLookup, safeAdminPath } from './session';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

describe('admin session helpers', () => {
  it('jwtSecondsLeft reads exp (base64url), null when unreadable', () => {
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    expect(jwtSecondsLeft(jwt({ exp: now / 1000 + 90 }), now)).toBe(90);
    expect(jwtSecondsLeft(jwt({ exp: now / 1000 - 5 }), now)).toBe(-5);
    // A payload whose base64url form uses - and _.
    expect(jwtSecondsLeft(jwt({ exp: now / 1000 + 1, x: '>>>???' }), now)).toBe(1);
    expect(jwtSecondsLeft(jwt({}), now)).toBeNull();
    expect(jwtSecondsLeft('nope', now)).toBeNull();
    expect(jwtSecondsLeft('a.%%%.c', now)).toBeNull();
  });

  it('safeAdminPath only allows /admin paths', () => {
    expect(safeAdminPath('/admin?q=K7QXM')).toBe('/admin?q=K7QXM');
    expect(safeAdminPath('/admin')).toBe('/admin');
    expect(safeAdminPath('/admin/sign-in')).toBe('/admin/sign-in');
    for (const bad of [
      '/administrator',
      '//evil.test/admin',
      'https://evil.test',
      '/',
      null,
      undefined,
    ]) {
      expect(safeAdminPath(bad)).toBe('/admin');
    }
  });

  it('parseLookup tells battle ids from room codes', () => {
    expect(parseLookup(' 2F2EBEFD-6BED-4182-9778-74BEDD95C656 ')).toEqual({
      kind: 'battle',
      id: '2f2ebefd-6bed-4182-9778-74bedd95c656',
    });
    expect(parseLookup('k7qxm')).toEqual({ kind: 'room', code: 'K7QXM' });
    expect(parseLookup('K7QX0')).toEqual({ kind: 'none' }); // no 0 in room codes
    expect(parseLookup('')).toEqual({ kind: 'none' });
    expect(parseLookup(undefined)).toEqual({ kind: 'none' });
  });

  it('the cookies are httpOnly, SameSite=Strict and scoped to /admin', () => {
    expect(cookieOptions(60, true)).toEqual({
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      path: '/admin',
      maxAge: 60,
    });
  });
});
