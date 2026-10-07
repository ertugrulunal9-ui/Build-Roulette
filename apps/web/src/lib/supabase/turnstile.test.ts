// @vitest-environment happy-dom
/**
 * Turnstile wiring (T-024): no key → no token and no widget; with a key → one widget,
 * the token goes to signInAnonymously, the widget is removed; failures reject.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { ensureSignedIn } from './browser';
import { getCaptchaToken, type TurnstileApi } from './turnstile';

function fakeTurnstile(outcome: { token?: string; error?: string; never?: boolean }) {
  const removed: string[] = [];
  const rendered: { sitekey: string; appearance?: string }[] = [];
  const api: TurnstileApi = {
    render(container, options) {
      expect(container.isConnected).toBe(true);
      rendered.push({ sitekey: options.sitekey, appearance: options.appearance });
      if (outcome.never) return 'w1';
      setTimeout(() => {
        if (outcome.token) options.callback(outcome.token);
        else options['error-callback']?.(outcome.error);
      }, 1);
      return 'w1';
    },
    remove(id) {
      removed.push(id);
    },
  };
  return { api, removed, rendered };
}

describe('getCaptchaToken', () => {
  it('without a site key: no token, nothing loaded or rendered', async () => {
    const load = vi.fn();
    expect(await getCaptchaToken({ siteKey: null, load })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="turnstile"]')).toBeNull();
  });

  it('with a site key: an interaction-only widget yields the token, then goes away', async () => {
    const t = fakeTurnstile({ token: 'tok-123' });
    const token = await getCaptchaToken({
      siteKey: 'site-key',
      load: () => Promise.resolve(t.api),
    });
    expect(token).toBe('tok-123');
    expect(t.rendered).toEqual([{ sitekey: 'site-key', appearance: 'interaction-only' }]);
    expect(t.removed).toEqual(['w1']);
    expect(document.querySelector('[data-testid="turnstile"]')).toBeNull();
  });

  it('a widget error rejects (and cleans up)', async () => {
    const t = fakeTurnstile({ error: '110200' });
    await expect(
      getCaptchaToken({ siteKey: 'k', load: () => Promise.resolve(t.api) }),
    ).rejects.toThrow('Turnstile error 110200');
    expect(t.removed).toEqual(['w1']);
    expect(document.querySelector('[data-testid="turnstile"]')).toBeNull();
  });

  it('a widget that never answers times out', async () => {
    const t = fakeTurnstile({ never: true });
    await expect(
      getCaptchaToken({ siteKey: 'k', load: () => Promise.resolve(t.api), timeoutMs: 5 }),
    ).rejects.toThrow('timed out');
  });
});

describe('ensureSignedIn', () => {
  function fakeClient(session: { user: { id: string } } | null) {
    const signInAnonymously = vi.fn((_opts?: unknown) =>
      Promise.resolve({ data: { user: { id: 'new-user' } }, error: null }),
    );
    const client = {
      auth: { getSession: () => Promise.resolve({ data: { session } }), signInAnonymously },
    } as unknown as SupabaseClient;
    return { client, signInAnonymously };
  }

  it('passes the Turnstile token to the anonymous sign-up', async () => {
    const { client, signInAnonymously } = fakeClient(null);
    expect(await ensureSignedIn(client, () => Promise.resolve('tok'))).toBe('new-user');
    expect(signInAnonymously).toHaveBeenCalledWith({ options: { captchaToken: 'tok' } });
  });

  it('sends no options locally (no key, no token)', async () => {
    const { client, signInAnonymously } = fakeClient(null);
    await ensureSignedIn(client, () => Promise.resolve(undefined));
    expect(signInAnonymously).toHaveBeenCalledWith(undefined);
  });

  it('an existing session needs no token', async () => {
    const { client, signInAnonymously } = fakeClient({ user: { id: 'me' } });
    const captcha = vi.fn(() => Promise.resolve('tok'));
    expect(await ensureSignedIn(client, captcha)).toBe('me');
    expect(captcha).not.toHaveBeenCalled();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });
});
