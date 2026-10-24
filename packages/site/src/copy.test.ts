import { describe, expect, it } from 'vitest';
import { copySite, type CopyOptions, type CopyResult } from './copy';
import { unpackSite } from './pack';
import {
  PLAIN_SITE,
  PLAIN_SITE_FILES,
  VITE_SITE,
  VITE_SITE_FILES,
  fakeHost,
  type FixtureSite,
} from './test-sites';

const APP = 'https://my-app.lovable.app';
const dec = new TextDecoder();

function files(r: CopyResult): string[] {
  if (!r.ok) throw new Error(`copy failed: ${r.error.code} ${r.error.detail ?? ''}`);
  return [...unpackSite(r.site.pack).keys()].sort();
}

function text(r: CopyResult, path: string): string {
  if (!r.ok) throw new Error(r.error.code);
  const f = unpackSite(r.site.pack).get(path);
  if (!f) throw new Error(`no ${path}`);
  return dec.decode(f.bytes);
}

function error(r: CopyResult): string {
  return r.ok
    ? 'ok'
    : `${r.error.code}${r.error.detail === undefined ? '' : `: ${r.error.detail}`}`;
}

async function copy(
  sites: Record<string, FixtureSite>,
  url: string,
  opts: Partial<CopyOptions> & { spa?: boolean } = {},
) {
  const host = fakeHost(sites, { spa: opts.spa ?? false });
  const result = await copySite(url, { fetch: host.fetch, ...opts });
  return { result, host };
}

describe('copySite: a Vite build', () => {
  it('copies the entry, its modules (static, dynamic, __vite__mapDeps), CSS assets and icons', async () => {
    const { result, host } = await copy({ [APP]: VITE_SITE }, `${APP}/`);
    expect(files(result)).toEqual(VITE_SITE_FILES);
    expect(result.ok && result.site.root).toBe(`${APP}/`);
    expect(result.ok && result.site.files).toBe(VITE_SITE_FILES.length);
    expect(result.ok && result.site.skipped).toBe(0);
    expect(text(result, 'index.html')).toContain('/assets/index-abc.js');
    // Content types by extension, like a dropped folder.
    if (!result.ok) throw new Error(result.error.code);
    const pack = unpackSite(result.site.pack);
    expect(pack.get('assets/index-abc.js')?.type).toBe('text/javascript; charset=utf-8');
    expect(pack.get('icon-192.png')?.type).toBe('image/png');
    // Other origins are left alone: the sandbox loads them itself.
    expect(host.calls.every((c) => c.startsWith(`${APP}/`))).toBe(true);
    // Every path at most once.
    const paths = host.calls.map((c) => new URL(c).pathname);
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.site.bytes).toBe([...pack.values()].reduce((n, f) => n + f.bytes.byteLength, 0));
  });

  it('skips guesses a single-page-app host answers with its page', async () => {
    const { result, host } = await copy({ [APP]: VITE_SITE }, `${APP}/`, { spa: true });
    expect(files(result)).toEqual(VITE_SITE_FILES);
    expect(result.ok && result.site.skipped).toBe(0);
    expect(host.calls).toContain(`${APP}/assets/hero-missing.webp`);
  });

  it('counts a missing file the page needs as skipped, and copies the rest', async () => {
    const site = { ...VITE_SITE };
    delete site['/favicon.svg'];
    const { result } = await copy({ [APP]: site }, `${APP}/`);
    expect(files(result)).toEqual(VITE_SITE_FILES.filter((f) => f !== 'favicon.svg'));
    expect(result.ok && result.site.skipped).toBe(1);
    // The same on an SPA host, which answers the missing icon with its page.
    const spa = await copy({ [APP]: site }, `${APP}/`, { spa: true });
    expect(spa.result.ok && spa.result.site.skipped).toBe(1);
    expect(files(spa.result)).not.toContain('favicon.svg');
  });

  it('fails when a file the page needs answers with a server error', async () => {
    const { result } = await copy(
      { [APP]: { ...VITE_SITE, '/assets/vendor-def.js': { status: 502 } } },
      `${APP}/`,
    );
    expect(error(result)).toBe('url-unreachable: 502 assets/vendor-def.js');
  });

  it('copies at most 4 files at a time', async () => {
    const host = fakeHost({ [APP]: VITE_SITE }, { delayMs: 5 });
    const result = await copySite(`${APP}/`, { fetch: host.fetch });
    expect(files(result)).toEqual(VITE_SITE_FILES);
    expect(host.maxActive).toBe(4);
    const one = fakeHost({ [APP]: VITE_SITE }, { delayMs: 2 });
    await copySite(`${APP}/`, { fetch: one.fetch, limits: { concurrency: 1 } });
    expect(one.maxActive).toBe(1);
  });
});

describe('copySite: a plain HTML site', () => {
  const GH = 'https://someone.github.io';

  it('follows the redirect to the folder, links between pages, srcset, and drops query strings', async () => {
    const { result, host } = await copy({ [GH]: PLAIN_SITE }, `${GH}/portfolio`);
    expect(files(result)).toEqual(PLAIN_SITE_FILES);
    expect(result.ok && result.site.root).toBe(`${GH}/portfolio/`);
    // /other-repo/ is outside the site root; gone.html is a broken link.
    expect(result.ok && result.site.skipped).toBe(2);
    // app.js?v=3 and ../app.js?v=4 are one file, fetched once (with the first query).
    expect(host.calls.filter((c) => c.includes('app.js'))).toEqual([`${GH}/portfolio/app.js?v=3`]);
    expect(host.calls.some((c) => c.includes('twitter.com'))).toBe(false);
    expect(host.calls.some((c) => c.includes('other-repo'))).toBe(false);
  });

  it('stores a page that is not the folder index as index.html', async () => {
    const { result, host } = await copy(
      { [GH]: PLAIN_SITE },
      `${GH}/portfolio/about.html?ref=x#top`,
    );
    // The query goes to the host, the fragment does not.
    expect(host.calls[0]).toBe(`${GH}/portfolio/about.html?ref=x`);
    expect(text(result, 'index.html')).toContain('./img/about.png');
    expect(files(result)).toContain('img/about.png');
    // index.html (the folder page) is the same path as the entry: not fetched again.
    expect(text(result, 'index.html')).not.toContain('Projects');
  });

  it('fetches against <base href>, and stores where the sandbox (which ignores it) asks', async () => {
    const { result, host } = await copy(
      {
        [GH]: {
          '/': `<html><head><base href="/static/"><link rel="stylesheet" href="a.css">
<script type="module" src="/static/main.js"></script></head></html>`,
          '/static/a.css': 'body{background:url(img/bg.png)}',
          '/static/img/bg.png': 'png',
          '/static/main.js': 'import("./chunk.js")',
          '/static/chunk.js': 'chunk',
        },
      },
      `${GH}/`,
    );
    expect(host.calls).toContain(`${GH}/static/a.css`);
    expect(host.calls).toContain(`${GH}/static/img/bg.png`);
    // The sandbox asks for /a.css, and then for img/bg.png next to it; a root-relative
    // reference (and what it imports) is the same path either way.
    expect(files(result)).toEqual([
      'a.css',
      'img/bg.png',
      'index.html',
      'static/chunk.js',
      'static/main.js',
    ]);
    expect(text(result, 'a.css')).toBe('body{background:url(img/bg.png)}');
    expect(result.ok && result.site.skipped).toBe(0);
  });

  it('copies a deep link of a single-page app with <base href="/"> from the host root', async () => {
    // Angular's default: relative script paths and <base href="/">, so a page at
    // /admin/users loads /main.js on the host, and main.js next to the page in the sandbox.
    const { result, host } = await copy(
      {
        [GH]: {
          '/': '<html><head><base href="/"><script type="module" src="main.js"></script></head></html>',
          '/main.js': 'app',
        },
      },
      `${GH}/admin/users`,
      { spa: true },
    );
    expect(result.ok && result.site.root).toBe(`${GH}/admin/`);
    expect(files(result)).toEqual(['index.html', 'main.js']);
    expect(text(result, 'main.js')).toBe('app');
    expect(host.calls).toContain(`${GH}/main.js`);
  });

  it('decodes stored paths the way the site worker looks them up', async () => {
    const { result } = await copy(
      {
        [GH]: {
          '/': '<img src="my%20photo.png"><img src="caf%C3%A9.png">',
          '/my%20photo.png': 'p',
          '/caf%C3%A9.png': 'c',
        },
      },
      `${GH}/`,
    );
    expect(files(result)).toEqual(['café.png', 'index.html', 'my photo.png']);
  });
});

describe('copySite: redirects', () => {
  it('follows up to 3 redirects on allowed hosts, re-checking every hop', async () => {
    const { result } = await copy(
      {
        'https://a.netlify.app': {
          '/': { status: 301, headers: { location: 'https://b.netlify.app/x' } },
        },
        'https://b.netlify.app': {
          '/x': { status: 302, headers: { location: '/y/' } },
          '/y/': { status: 307, headers: { location: 'https://c.vercel.app/' } },
        },
        'https://c.vercel.app': {
          '/': '<html><link rel="icon" href="/i.png"></html>',
          '/i.png': 'png',
        },
      },
      'https://a.netlify.app/',
    );
    expect(files(result)).toEqual(['i.png', 'index.html']);
    expect(result.ok && result.site.root).toBe('https://c.vercel.app/');
  });

  it('refuses a fourth redirect', async () => {
    const loop = {
      '/': { status: 302, headers: { location: '/a' } },
      '/a': { status: 302, headers: { location: '/b' } },
      '/b': { status: 302, headers: { location: '/c' } },
      '/c': { status: 302, headers: { location: '/d' } },
      '/d': { body: '<html></html>', headers: { 'content-type': 'text/html' } },
    };
    expect(error((await copy({ [APP]: loop }, `${APP}/`)).result)).toBe(
      'url-unreachable: too many redirects',
    );
    expect(error((await copy({ [APP]: loop }, `${APP}/a`)).result)).toBe('ok');
  });

  it('refuses a redirect to a host that is not allowed, before fetching it', async () => {
    const evil = fakeHost({
      [APP]: { '/': { status: 302, headers: { location: 'http://169.254.169.254/latest/' } } },
    });
    const r = await copySite(`${APP}/`, { fetch: evil.fetch });
    expect(error(r)).toBe('url-invalid: https only');
    expect(evil.calls).toEqual([`${APP}/`]);
    const other = await copy(
      { [APP]: { '/': { status: 301, headers: { location: 'https://evil.example.com/' } } } },
      `${APP}/`,
    );
    expect(error(other.result)).toBe('url-host-not-allowed: evil.example.com');
    expect(other.host.calls).toEqual([`${APP}/`]);
    const ip = await copy(
      { [APP]: { '/': { status: 308, headers: { location: 'https://10.0.0.1/' } } } },
      `${APP}/`,
    );
    expect(error(ip.result)).toBe('url-host-not-allowed: 10.0.0.1');
  });

  it('calls a redirect to a login page private', async () => {
    const { result } = await copy(
      {
        'https://x.vercel.app': {
          '/': { status: 307, headers: { location: 'https://vercel.com/login?next=%2F' } },
        },
      },
      'https://x.vercel.app/',
    );
    expect(error(result)).toBe('url-private: vercel.com');
  });

  it('skips a file redirected to another origin', async () => {
    const { result, host } = await copy(
      {
        [APP]: {
          '/': '<html><img src="/a.png"><img src="/b.png"></html>',
          '/a.png': { status: 302, headers: { location: 'https://cdn.example.com/a.png' } },
          '/b.png': { status: 302, headers: { location: '/real-b.png' } },
          '/real-b.png': 'b',
        },
      },
      `${APP}/`,
    );
    expect(files(result)).toEqual(['b.png', 'index.html']);
    expect(text(result, 'b.png')).toBe('b');
    expect(result.ok && result.site.skipped).toBe(1);
    expect(host.calls.some((c) => c.includes('cdn.example.com'))).toBe(false);
  });

  it('stores what a redirected file references next to where the file is stored', async () => {
    const { result, host } = await copy(
      {
        [APP]: {
          '/': '<html><link rel="stylesheet" href="/b.css"></html>',
          '/b.css': { status: 302, headers: { location: '/real/b.css' } },
          '/real/b.css': 'a{background:url(x.png)}',
          '/real/x.png': 'x',
        },
      },
      `${APP}/`,
    );
    // The sandbox serves b.css at /b.css, so it asks for /x.png.
    expect(files(result)).toEqual(['b.css', 'index.html', 'x.png']);
    expect(text(result, 'x.png')).toBe('x');
    expect(host.calls).toContain(`${APP}/real/x.png`);
  });
});

describe('copySite: what cannot be copied', () => {
  it('a link that is not allowed, without any request', async () => {
    const host = fakeHost({});
    expect(error(await copySite('https://example.com/', { fetch: host.fetch }))).toBe(
      'url-host-not-allowed: example.com',
    );
    expect(error(await copySite('not a link', { fetch: host.fetch }))).toBe('url-invalid');
    expect(host.calls).toEqual([]);
  });

  it('an entry that is not found, or a server error', async () => {
    expect(error((await copy({ [APP]: {} }, `${APP}/`)).result)).toBe('url-unreachable: 404');
    expect(error((await copy({ [APP]: { '/': { status: 503 } } }, `${APP}/`)).result)).toBe(
      'url-unreachable: 503',
    );
    expect(error((await copy({ [APP]: { '/': { fail: true } } }, `${APP}/`)).result)).toBe(
      'url-unreachable: no connection',
    );
    expect(error((await copy({}, `${APP}/`)).result)).toBe('url-unreachable: no connection');
  });

  it('an entry that is not a web page', async () => {
    expect(
      error(
        (
          await copy(
            { [APP]: { '/': { body: '{}', headers: { 'content-type': 'application/json' } } } },
            `${APP}/`,
          )
        ).result,
      ),
    ).toBe('url-not-html: application/json');
    expect(error((await copy({ [APP]: { '/logo.png': 'png' } }, `${APP}/logo.png`)).result)).toBe(
      'url-not-html: image/png',
    );
    // No content type: sniffed.
    const noType = new Response('<!DOCTYPE html><title>x</title>', { status: 200 });
    noType.headers.delete('content-type');
    const sniffed = await copySite(`${APP}/`, { fetch: () => Promise.resolve(noType) });
    expect(error(sniffed)).toBe('ok');
    const binary = new Response(new Uint8Array([0, 1, 2]), { status: 200 });
    expect(error(await copySite(`${APP}/`, { fetch: () => Promise.resolve(binary) }))).toBe(
      'url-not-html',
    );
  });

  it('a login wall (401, 403)', async () => {
    expect(
      error((await copy({ [APP]: { '/': { status: 401, body: 'login' } } }, `${APP}/`)).result),
    ).toBe('url-private: 401');
    expect(error((await copy({ [APP]: { '/': { status: 403 } } }, `${APP}/`)).result)).toBe(
      'url-private: 403',
    );
  });
});

describe('copySite: limits', () => {
  it('stops at the file limit', async () => {
    const { result, host } = await copy({ [APP]: VITE_SITE }, `${APP}/`, {
      limits: { maxFiles: 5 },
    });
    expect(error(result)).toBe('too-many-files: more than 5');
    expect(host.calls.length).toBeLessThan(VITE_SITE_FILES.length);
  });

  it('stops at the byte limit, from Content-Length or while reading', async () => {
    const big = 'x'.repeat(4000);
    const site = { '/': '<img src="/a.png"><img src="/b.png">', '/a.png': big, '/b.png': big };
    expect(
      error((await copy({ [APP]: site }, `${APP}/`, { limits: { maxBytes: 5000 } })).result),
    ).toBe('too-large');
    expect(
      error((await copy({ [APP]: site }, `${APP}/`, { limits: { maxBytes: 9000 } })).result),
    ).toBe('ok');
    const declared = {
      ...site,
      '/a.png': {
        body: 'x',
        headers: { 'content-length': '99999999', 'content-type': 'image/png' },
      },
    };
    expect(
      error((await copy({ [APP]: declared }, `${APP}/`, { limits: { maxBytes: 9000 } })).result),
    ).toBe('too-large');
    // An endless body is cut off at the limit.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const r = await copySite(`${APP}/`, {
      fetch: () =>
        Promise.resolve(new Response(endless, { headers: { 'content-type': 'text/html' } })),
      limits: { maxBytes: 10_000 },
    });
    expect(error(r)).toBe('too-large');
    expect(pulled).toBeLessThan(20);
  });

  it('a pack that would not fit with its header is too large', async () => {
    const site = {
      '/': `<img src="/a.png">${'x'.repeat(100)}`,
      '/a.png': 'x'.repeat(5 * 1024 * 1024 - 200),
    };
    expect(error((await copy({ [APP]: site }, `${APP}/`)).result)).toMatch(/^too-large/);
  });
});

describe('copySite: time', () => {
  it('gives up on an entry that does not answer (per-request timeout)', async () => {
    const t0 = Date.now();
    const { result } = await copy({ [APP]: { '/': { hang: true } } }, `${APP}/`, {
      limits: { requestTimeoutMs: 50 },
    });
    expect(error(result)).toBe('url-timeout: /');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('gives up when the whole copy takes too long (total timeout)', async () => {
    const site: FixtureSite = {
      '/': Array.from({ length: 40 }, (_, i) => `<img src="/i${String(i)}.png">`).join(''),
    };
    for (let i = 0; i < 40; i++) site[`/i${String(i)}.png`] = { body: 'p', delayMs: 30 };
    const t0 = Date.now();
    const { result } = await copy({ [APP]: site }, `${APP}/`, { limits: { totalTimeoutMs: 150 } });
    expect(error(result)).toBe('url-timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('uses `now` for the deadline', async () => {
    let clock = 0;
    const host = fakeHost({
      [APP]: { '/': '<img src="/a.png"><img src="/b.png">', '/a.png': 'p', '/b.png': 'p' },
    });
    const r = await copySite(`${APP}/`, {
      fetch: (u, i) => {
        clock += 30_000;
        return host.fetch(u, i);
      },
      now: () => clock,
      limits: { concurrency: 1 },
    });
    expect(error(r)).toBe('url-timeout');
  });

  it('skips a guess that hangs, and a slow file the page needs fails the copy', async () => {
    const guess = await copy(
      {
        [APP]: {
          '/': '<script type="module" src="/a.js"></script>',
          '/a.js': 'const img="/assets/slow.png"',
          '/assets/slow.png': { hang: true },
        },
      },
      `${APP}/`,
      { limits: { requestTimeoutMs: 50 } },
    );
    expect(files(guess.result)).toEqual(['a.js', 'index.html']);
    const sure = await copy(
      { [APP]: { '/': '<img src="/slow.png">', '/slow.png': { hang: true } } },
      `${APP}/`,
      { limits: { requestTimeoutMs: 50 } },
    );
    expect(error(sure.result)).toBe('url-timeout: /slow.png');
  });

  it('stops when the caller goes away', async () => {
    const ac = new AbortController();
    const host = fakeHost({ [APP]: { '/': { hang: true } } });
    const p = copySite(`${APP}/`, { fetch: host.fetch, signal: ac.signal });
    setTimeout(() => {
      ac.abort();
    }, 20);
    expect(error(await p)).toBe('url-unreachable: cancelled');
  });
});
