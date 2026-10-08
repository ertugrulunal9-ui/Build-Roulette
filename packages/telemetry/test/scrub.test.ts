import type { Event } from '@sentry/core';
import { describe, expect, it } from 'vitest';
import { hashUserId } from '../src/hash';
import { routeTemplate, scrubSentryEvent, scrubText, scrubUrl } from '../src/scrub';

const BATTLE = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';
const USER = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';

describe('routeTemplate', () => {
  it('turns the dynamic segments of the app routes into their names', () => {
    expect(routeTemplate('/r/K7QXM')).toBe('/r/[code]');
    expect(routeTemplate(`/u/${USER}`)).toBe('/u/[id]');
    expect(routeTemplate(`/battles/${BATTLE}`)).toBe('/battles/[id]');
    expect(routeTemplate(`/battles/${BATTLE}/opengraph-image`)).toBe(
      '/battles/[id]/opengraph-image',
    );
    expect(routeTemplate('/play')).toBe('/play');
    expect(routeTemplate('/')).toBe('/');
    expect(routeTemplate('/r/')).toBe('/r/');
  });

  it('masks any other UUID and very long segments', () => {
    expect(routeTemplate(`/admin/x/${BATTLE}`)).toBe('/admin/x/[id]');
    expect(routeTemplate(`/a/${'x'.repeat(80)}`)).toBe('/a/[…]');
  });
});

describe('scrubUrl', () => {
  it('drops the query string and the fragment, and templates the path', () => {
    expect(scrubUrl(`https://app.example/play?battle=${BATTLE}#top`)).toBe(
      'https://app.example/play',
    );
    expect(scrubUrl('http://localhost:3000/r/K7QXM?name=Ana')).toBe(
      'http://localhost:3000/r/[code]',
    );
    expect(scrubUrl(`/battles/${BATTLE}?x=1`)).toBe('/battles/[id]');
  });

  it('drops credentials in the authority', () => {
    expect(scrubUrl('https://user:secret@host.example/a?b=c')).toBe('https://host.example/a');
  });

  it('never keeps blob: or data: URLs', () => {
    expect(scrubUrl('blob:http://localhost/abc')).toBe('<blob-url>');
    expect(scrubUrl('data:text/javascript,alert(1)')).toBe('<data-url>');
  });
});

describe('scrubText', () => {
  it('scrubs URLs, UUIDs, emails and tokens in free text', () => {
    const text =
      `fetch failed: GET http://127.0.0.1:54321/storage/v1/object/sign/ephemeral-builds/${BATTLE}/${USER}/bundle.js?token=abc.def ` +
      `for mod@example.com with Bearer abcdefghijklmnop and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ` +
      `key sb_secret_N7UND0UgjKTVK and phc_abcdefghijkl`;
    const out = scrubText(text);
    expect(out).not.toContain(BATTLE);
    expect(out).not.toContain(USER);
    expect(out).not.toContain('token=');
    expect(out).not.toContain('mod@example.com');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('sb_secret');
    expect(out).not.toContain('phc_');
    expect(out).toContain(
      'http://127.0.0.1:54321/storage/v1/object/sign/ephemeral-builds/[id]/[id]/bundle.js',
    );
    expect(out).toContain('<email>');
    expect(out).toContain('Bearer <token>');
  });

  it('keeps trailing punctuation outside the URL', () => {
    expect(scrubText('see https://a.example/x?y=1.')).toBe('see https://a.example/x.');
  });

  it('cuts long text', () => {
    const out = scrubText('x '.repeat(1000));
    expect(out.length).toBe(500);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves ordinary error text alone', () => {
    expect(scrubText("Cannot read properties of undefined (reading 'phase')")).toBe(
      "Cannot read properties of undefined (reading 'phase')",
    );
  });
});

describe('scrubSentryEvent', () => {
  const hash = '0123456789abcdef0123456789abcdef';
  const event: Event = {
    event_id: 'e1',
    level: 'error',
    release: 'build-roulette@abc',
    environment: 'production',
    message: `room ${BATTLE} failed`,
    server_name: 'my-laptop.local',
    exception: {
      values: [
        {
          type: 'TypeError',
          value: `boom at https://app.example/r/K7QXM?invite=1 for ${USER}`,
          mechanism: { type: 'onerror', handled: false, data: { secret: 'x' } },
          stacktrace: {
            frames: [
              {
                filename: 'https://app.example/_next/static/chunks/main.js?dpl=abc',
                abs_path: 'https://app.example/_next/static/chunks/main.js?dpl=abc',
                function: 'onClick',
                lineno: 1,
                colno: 2,
                in_app: true,
                vars: { password: 'hunter2' },
                context_line: 'const secret = 1',
                pre_context: ['x'],
              },
            ],
          },
        },
      ],
    },
    request: {
      url: 'https://app.example/u/' + USER + '?page=2',
      method: 'GET',
      query_string: 'page=2',
      data: { name: 'Ana' },
      cookies: { br_admin_at: 'token' },
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://app.example/r/K7QXM', Cookie: 'x' },
    },
    user: { id: hash, email: 'ana@example.com', ip_address: '1.2.3.4', username: 'Ana' },
    tags: {
      phase: 'building',
      battle_id: BATTLE,
      room_id: 'K7QXM',
      display_name: 'Ana',
      route: '/r/[code]',
    },
    extra: { workspace: 'export default function App() {}' },
    breadcrumbs: [{ message: 'typed in editor' }],
    contexts: {
      runtime: { name: 'node', version: 'v22' },
      culture: { locale: 'tr-TR', timezone: 'Europe/Istanbul' },
      br: { name: 'Ana' },
    },
    modules: { react: '19' },
  };

  it('keeps only what may leave', () => {
    const out = scrubSentryEvent(event);
    expect(out).not.toBeNull();
    const json = JSON.stringify(out);
    for (const secret of [
      USER,
      'K7QXM',
      'invite=1',
      'page=2',
      'ana@example.com',
      '1.2.3.4',
      'Ana',
      'hunter2',
      'const secret',
      'export default',
      'typed in editor',
      'my-laptop',
      'dpl=abc',
      'token',
      'Europe/Istanbul',
      'Referer',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(out?.user).toEqual({ id: hash });
    expect(out?.tags).toEqual({ phase: 'building', battle_id: BATTLE, route: '/r/[code]' });
    expect(out?.request).toEqual({
      url: 'https://app.example/u/[id]',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    expect(out?.message).toBe('room <id> failed');
    expect(out?.release).toBe('build-roulette@abc');
    expect(out?.contexts).toEqual({ runtime: { name: 'node', version: 'v22' } });
    expect(out?.breadcrumbs).toBeUndefined();
    expect(out?.extra).toBeUndefined();
    const frame = out?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame).toEqual({
      filename: 'https://app.example/_next/static/chunks/main.js',
      abs_path: 'https://app.example/_next/static/chunks/main.js',
      function: 'onClick',
      lineno: 1,
      colno: 2,
      in_app: true,
    });
    expect(out?.exception?.values?.[0]?.mechanism).toEqual({ type: 'onerror', handled: false });
  });

  it('drops a user id that is not a hash (a raw user id, an email)', () => {
    expect(scrubSentryEvent({ user: { id: USER } })?.user).toBeUndefined();
    expect(scrubSentryEvent({ user: { id: 'ana@example.com' } })?.user).toBeUndefined();
  });

  it('drops events whose stack runs through a blob: or data: URL (build code)', () => {
    const fromBlob: Event = {
      exception: {
        values: [
          { type: 'Error', value: 'x', stacktrace: { frames: [{ filename: 'blob:https://a/b' }] } },
        ],
      },
    };
    expect(scrubSentryEvent(fromBlob)).toBeNull();
  });
});

describe('hashUserId', () => {
  it('is a stable 32-hex pseudonym that does not contain the id', async () => {
    const a = await hashUserId(USER);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashUserId(USER.toUpperCase())).toBe(a);
    expect(a).not.toContain(USER.slice(0, 8));
    expect(await hashUserId(BATTLE)).not.toBe(a);
  });

  it('is null for anything but a UUID', async () => {
    expect(await hashUserId('ana@example.com')).toBeNull();
    expect(await hashUserId('')).toBeNull();
  });
});
