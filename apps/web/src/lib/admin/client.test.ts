// @vitest-environment happy-dom
/**
 * The moderator's session in the browser (T-037, lib/admin/client.ts): its own client and
 * storage key, this tab's sessionStorage only (never localStorage, never the player's
 * `br-auth`), the admin RPCs with the moderator's token, `is_admin()` deciding who keeps a
 * session, and a sign-out that revokes and forgets it. Supabase Auth and PostgREST are a fake
 * `fetch` here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_STORAGE_KEY,
  adminRpc,
  checkAdmin,
  createAdminClient,
  parseLookup,
  signInAdmin,
  signOutAdmin,
} from './client';

const CONFIG = { url: 'https://db.example', anonKey: 'anon-key' };

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const USER = {
  id: 'ad000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'mod@example.test',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-10-09T00:00:00Z',
};

function tokenAnswer(access: string, refresh: string) {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: USER,
  };
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: string;
}

/** A fake Supabase: Auth (password, refresh, user, logout) and the `is_admin` RPC. */
function fakeSupabase(opts: { admin: boolean; password?: string }) {
  const seen: Seen[] = [];
  const access = jwt({
    sub: USER.id,
    exp: Math.floor(Date.now() / 1000) + 3600,
    role: 'authenticated',
  });
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      auth: headers.get('authorization'),
      body,
    });
    const json = (status: number, value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      const b = JSON.parse(body) as { password?: string };
      if (grant === 'password' && b.password !== (opts.password ?? 'right')) {
        return json(400, {
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
        });
      }
      return json(200, tokenAnswer(access, `refresh-${String(seen.length)}`));
    }
    if (url.pathname === '/auth/v1/user') return json(200, USER);
    if (url.pathname === '/auth/v1/logout')
      return Promise.resolve(new Response(null, { status: 204 }));
    if (url.pathname === '/rest/v1/rpc/is_admin') return json(200, opts.admin);
    if (url.pathname === '/rest/v1/rpc/admin_report_queue') {
      return headers.get('authorization') === `Bearer ${access}`
        ? json(200, { builds: [] })
        : json(403, { message: 'not_admin', details: null });
    }
    return json(404, { message: 'unexpected' });
  });
  return { fetchImpl, seen, access };
}

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('the moderator client', () => {
  it('an admin signs in: the session goes to this tab’s sessionStorage under its own key, never localStorage', async () => {
    const fake = fakeSupabase({ admin: true });
    window.localStorage.setItem('br-auth', 'the player session');
    const client = createAdminClient(CONFIG, window.sessionStorage, fake.fetchImpl);
    expect(
      await signInAdmin(client, 'mod@example.test', 'right', () => Promise.resolve(undefined)),
    ).toBe('ok');

    const saved = JSON.parse(window.sessionStorage.getItem(ADMIN_STORAGE_KEY) ?? '{}') as {
      access_token?: string;
    };
    expect(saved.access_token).toBe(fake.access);
    // localStorage holds only the player's session, untouched.
    expect(Object.keys(window.localStorage)).toEqual(['br-auth']);
    expect(window.localStorage.getItem('br-auth')).toBe('the player session');

    // The admin RPCs carry the moderator's own token.
    const res = await adminRpc<{ builds: unknown[] }>(client, 'admin_report_queue', {});
    expect(res).toEqual({ data: { builds: [] }, error: null, details: null, status: 200 });
    expect(fake.seen.at(-1)?.auth).toBe(`Bearer ${fake.access}`);
  });

  it('a Turnstile token goes with the password sign-in when one is configured', async () => {
    const fake = fakeSupabase({ admin: true });
    const client = createAdminClient(CONFIG, window.sessionStorage, fake.fetchImpl);
    await signInAdmin(client, 'mod@example.test', 'right', () =>
      Promise.resolve('turnstile-token'),
    );
    const signIn = fake.seen.find((s) => s.path.startsWith('/auth/v1/token'));
    expect(JSON.parse(signIn?.body ?? '{}')).toMatchObject({
      gotrue_meta_security: { captcha_token: 'turnstile-token' },
    });
  });

  it('wrong details, or a real account that is not an admin: denied, and no session is left', async () => {
    const wrong = fakeSupabase({ admin: true });
    const a = createAdminClient(CONFIG, window.sessionStorage, wrong.fetchImpl);
    expect(await signInAdmin(a, 'mod@example.test', 'nope', () => Promise.resolve(undefined))).toBe(
      'denied',
    );
    expect(window.sessionStorage.getItem(ADMIN_STORAGE_KEY)).toBeNull();

    const player = fakeSupabase({ admin: false });
    const b = createAdminClient(CONFIG, window.sessionStorage, player.fetchImpl);
    expect(
      await signInAdmin(b, 'someone@example.test', 'right', () => Promise.resolve(undefined)),
    ).toBe('denied');
    expect(window.sessionStorage.getItem(ADMIN_STORAGE_KEY)).toBeNull();
    // The account's session was ended at once (revoked at Supabase Auth).
    expect(player.seen.some((s) => s.path.startsWith('/auth/v1/logout'))).toBe(true);
    expect((await b.supabase.auth.getSession()).data.session).toBeNull();
  });

  it('a reload restores the tab’s session and asks is_admin(); no session means no request', async () => {
    const fake = fakeSupabase({ admin: true });
    const first = createAdminClient(CONFIG, window.sessionStorage, fake.fetchImpl);
    await signInAdmin(first, 'mod@example.test', 'right', () => Promise.resolve(undefined));

    const reloaded = createAdminClient(CONFIG, window.sessionStorage, fake.fetchImpl);
    expect(await checkAdmin(reloaded)).toBe('admin');

    window.sessionStorage.clear();
    const stranger = fakeSupabase({ admin: true });
    const empty = createAdminClient(CONFIG, window.sessionStorage, stranger.fetchImpl);
    expect(await checkAdmin(empty)).toBe('none');
    expect(stranger.seen).toEqual([]);
  });

  it('a stored session that is no longer an admin’s is dropped', async () => {
    const fake = fakeSupabase({ admin: false });
    window.sessionStorage.setItem(
      ADMIN_STORAGE_KEY,
      JSON.stringify({ access_token: fake.access, refresh_token: 'r' }),
    );
    const client = createAdminClient(CONFIG, window.sessionStorage, fake.fetchImpl);
    expect(await checkAdmin(client)).toBe('none');
    expect(window.sessionStorage.getItem(ADMIN_STORAGE_KEY)).toBeNull();
  });

  it('sign-out revokes the session and removes it from memory and from sessionStorage', async () => {
    const fake = fakeSupabase({ admin: true });
    const client = createAdminClient(CONFIG, window.sessionStorage, fake.fetchImpl);
    await signInAdmin(client, 'mod@example.test', 'right', () => Promise.resolve(undefined));
    expect(window.sessionStorage.getItem(ADMIN_STORAGE_KEY)).not.toBeNull();
    await signOutAdmin(client);
    const logout = fake.seen.find((s) => s.path.startsWith('/auth/v1/logout'));
    expect(logout?.auth).toBe(`Bearer ${fake.access}`);
    // This session only: the account's other sessions (another tab, browser) stay.
    expect(logout?.path).toBe('/auth/v1/logout?scope=local');
    expect(window.sessionStorage.getItem(ADMIN_STORAGE_KEY)).toBeNull();
    expect((await client.supabase.auth.getSession()).data.session).toBeNull();
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
});
