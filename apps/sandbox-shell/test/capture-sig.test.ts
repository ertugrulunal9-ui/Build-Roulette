import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MAX_TTL_SECONDS,
  canonicalCaptureString,
  signCaptureParams,
  signCaptureUrl,
  verifyCaptureUrl,
} from '../src/capture-sig';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const BASE = 'https://b1.usercontent.example/v1/capture';
const SRC =
  'https://db.example.co/storage/v1/object/sign/ephemeral-builds/a/b/bundle.js?token=x.y.z';
const CSS = 'https://db.example.co/storage/v1/object/sign/ephemeral-builds/a/b/bundle.css?token=q';
const MAP = JSON.stringify({ imports: { react: 'https://pkg.example/react@19.3.0' } });
const NOW = 1_800_000_000;

const sign = (over: Partial<Parameters<typeof signCaptureUrl>[0]> = {}) =>
  signCaptureUrl({
    captureUrl: BASE,
    src: SRC,
    css: CSS,
    map: MAP,
    exp: NOW + 60,
    secret: SECRET,
    ...over,
  });

/** Replaces one raw query parameter, keeping everything else byte-identical. */
function withParam(url: string, name: string, value: string): string {
  const u = new URL(url);
  const parts = u.search
    .slice(1)
    .split('&')
    .map((p) => (p.startsWith(`${name}=`) ? `${name}=${value}` : p));
  u.search = `?${parts.join('&')}`;
  return u.toString();
}

describe('canonicalCaptureString', () => {
  it('sorts parameters, percent-encodes names and values, lowercases the host', () => {
    expect(
      canonicalCaptureString('B1.Usercontent.Example:8443', '/v1/capture', {
        src: 'https://x/a b?c=d&e',
        exp: '123',
        map: '{"imports":{}}',
      }),
    ).toBe(
      [
        'br-capture-v1',
        'b1.usercontent.example:8443',
        '/v1/capture',
        'exp=123&map=%7B%22imports%22%3A%7B%7D%7D&src=https%3A%2F%2Fx%2Fa%20b%3Fc%3Dd%26e',
      ].join('\n'),
    );
  });

  it('does not depend on the order the parameters were given in', () => {
    const a = canonicalCaptureString('h', '/p', { src: 's', exp: '1', css: 'c' });
    const b = canonicalCaptureString('h', '/p', { css: 'c', exp: '1', src: 's' });
    expect(a).toBe(b);
  });

  it('keeps & and = inside values from forging extra parameters', () => {
    const a = canonicalCaptureString('h', '/p', { src: 'https://x/?a=1&exp=2' });
    const b = canonicalCaptureString('h', '/p', { src: 'https://x/?a=1', exp: '2' });
    expect(a).not.toBe(b);
  });
});

describe('signCaptureParams', () => {
  it('is HMAC-SHA256 over the canonical string, base64url without padding', async () => {
    const params = { src: SRC, exp: String(NOW) };
    const expected = createHmac('sha256', SECRET)
      .update(canonicalCaptureString('h.example', '/v1/capture', params))
      .digest('base64url');
    expect(await signCaptureParams(SECRET, 'h.example', '/v1/capture', params)).toBe(expected);
  });

  it('refuses a short secret', async () => {
    await expect(signCaptureParams('short', 'h', '/p', { src: SRC })).rejects.toThrow(
      'at least 32',
    );
  });
});

describe('signCaptureUrl + verifyCaptureUrl', () => {
  it('round-trips and returns the decoded parameters', async () => {
    const url = await sign();
    expect(url.startsWith(`${BASE}?css=`)).toBe(true);
    const r = await verifyCaptureUrl(url, SECRET, NOW);
    expect(r).toEqual({ ok: true, params: { src: SRC, css: CSS, map: MAP, exp: NOW + 60 } });
  });

  it('css and map are optional', async () => {
    const url = await signCaptureUrl({ captureUrl: BASE, src: SRC, exp: NOW + 1, secret: SECRET });
    expect(await verifyCaptureUrl(url, SECRET, NOW)).toEqual({
      ok: true,
      params: { src: SRC, exp: NOW + 1 },
    });
  });

  it('accepts an equivalent percent-encoding of the same values (canonical form is decoded)', async () => {
    const url = await sign();
    const u = new URL(url);
    // `+` for a space is not used by the signer, but %3A vs ':' etc. must not matter.
    const reencoded = url.replace(/%3A/g, ':').replace(/%2F/g, '/');
    expect(reencoded).not.toBe(url);
    expect((await verifyCaptureUrl(reencoded, SECRET, NOW)).ok).toBe(true);
    expect(u.host).toBe('b1.usercontent.example');
  });

  it('expiry: valid until exp inclusive, refused after', async () => {
    const url = await sign({ exp: NOW + 30 });
    expect((await verifyCaptureUrl(url, SECRET, NOW + 30)).ok).toBe(true);
    expect(await verifyCaptureUrl(url, SECRET, NOW + 31)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an exp too far in the future even when signed', async () => {
    const url = await sign({ exp: NOW + CAPTURE_MAX_TTL_SECONDS + 1 });
    expect(await verifyCaptureUrl(url, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'ttl-too-long',
    });
    const ok = await sign({ exp: NOW + CAPTURE_MAX_TTL_SECONDS });
    expect((await verifyCaptureUrl(ok, SECRET, NOW)).ok).toBe(true);
  });

  it('refuses a changed value of any signed parameter', async () => {
    const url = await sign();
    for (const [name, value] of [
      ['src', encodeURIComponent('https://evil.example/x.js')],
      ['css', encodeURIComponent('https://evil.example/x.css')],
      ['map', encodeURIComponent('{"imports":{}}')],
      ['exp', String(NOW + 61)],
    ] as const) {
      expect(await verifyCaptureUrl(withParam(url, name, value), SECRET, NOW), name).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    }
  });

  it('refuses a removed optional parameter (it is part of the signature)', async () => {
    const url = new URL(await sign());
    url.searchParams.delete('css');
    expect(await verifyCaptureUrl(url, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('binds the URL to its host and path', async () => {
    const url = await sign();
    const otherBuild = url.replace('b1.usercontent.example', 'b2.usercontent.example');
    expect(await verifyCaptureUrl(otherBuild, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const otherPath = url.replace('/v1/capture', '/v1/capturex');
    expect(await verifyCaptureUrl(otherPath, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses another secret, a truncated or a garbage signature', async () => {
    const url = await sign();
    expect(await verifyCaptureUrl(url, `${SECRET}x`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const sig = new URL(url).searchParams.get('sig') ?? '';
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const bad of [sig.slice(0, -1), `${sig}A`, '!'.repeat(43), '']) {
      expect(await verifyCaptureUrl(withParam(url, 'sig', bad), SECRET, NOW), bad).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    }
  });

  it('refuses unknown, repeated and missing parameters', async () => {
    const url = await sign();
    expect(await verifyCaptureUrl(`${url}&mode=live`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'unknown-param',
    });
    expect(await verifyCaptureUrl(`${url}&src=https://evil.example/x.js`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'duplicate-param',
    });
    expect(await verifyCaptureUrl(`${url}&sig=x`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'duplicate-param',
    });
    for (const name of ['src', 'exp', 'sig']) {
      const u = new URL(url);
      u.searchParams.delete(name);
      expect(await verifyCaptureUrl(u, SECRET, NOW), name).toEqual({
        ok: false,
        reason: 'missing-param',
      });
    }
    expect(await verifyCaptureUrl(BASE, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'missing-param',
    });
  });

  it('refuses non-http(s) bundle URLs and malformed exp before checking the MAC', async () => {
    const url = await sign();
    expect(
      await verifyCaptureUrl(
        withParam(url, 'src', encodeURIComponent('javascript:alert(1)')),
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'bad-url' });
    expect(
      await verifyCaptureUrl(
        withParam(url, 'css', encodeURIComponent('data:text/css,x')),
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'bad-url' });
    for (const exp of ['-1', '0', '1.5', '1e9', ' 123', '0123']) {
      expect(
        await verifyCaptureUrl(withParam(url, 'exp', encodeURIComponent(exp)), SECRET, NOW),
        exp,
      ).toEqual({
        ok: false,
        reason: 'bad-exp',
      });
    }
  });

  it('refuses an oversized query and a malformed URL', async () => {
    const url = await sign();
    expect(await verifyCaptureUrl(`${url}&x=${'a'.repeat(20_000)}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyCaptureUrl('not a url', SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('the signer validates its input', async () => {
    await expect(sign({ captureUrl: `${BASE}?x=1` })).rejects.toThrow('query');
    await expect(sign({ src: 'file:///etc/passwd' })).rejects.toThrow('src');
    await expect(sign({ css: 'ftp://x/y.css' })).rejects.toThrow('css');
    await expect(sign({ exp: 1.5 })).rejects.toThrow('exp');
    await expect(sign({ secret: 'short' })).rejects.toThrow('at least 32');
  });
});
