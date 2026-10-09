/**
 * T-038's link-preview Function, per case (preview-handler.ts), with its I/O stubbed: Pages'
 * assets, `get_public_battle` and the head injection (HTMLRewriter exists only in workerd; the
 * e2e runs the real one under `wrangler pages dev`).
 *
 * - a public battle: 200 and the battle's head; unknown / not public: 404 and the "not found"
 *   head; malformed: 404 without asking Supabase;
 * - fail open: an error, a timeout or an unexpected answer gives the shell unchanged with 200;
 * - every answer has the `_headers` security headers and no ETag; other paths and methods
 *   are passed to the assets untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PublicBattle } from '../solo/types';
import { handlePreview, SHELL_PATH, type PreviewDeps } from './preview-handler';

const ID = 'b0380000-0000-4000-8000-000000000002';
const SHELL =
  '<html><head><title>Battle results · Build Roulette</title></head><body></body></html>';
const SECURITY = { 'Content-Security-Policy': "default-src 'self'", 'X-Frame-Options': 'DENY' };

const BATTLE: PublicBattle = {
  battle: {
    id: ID,
    mode: 'solo',
    phase: 'destroyed',
    is_complete: true,
    building_started_at: null,
    building_ends_at: null,
    finished_at: null,
    destroyed_at: '2026-10-09T12:04:00Z',
    created_at: '2026-10-09T11:54:00Z',
  },
  challenge: {
    build: { text: 'A kanban board', hint: null },
    rule: { text: 'No mouse', hint: null },
    style: { text: 'Vaporwave', hint: null },
    time_limit_seconds: 600,
  },
  players: ['Ana'],
  builds: [
    {
      id: 'b1',
      builder_name: 'Ana',
      name: 'Board Games',
      status: 'shipped',
      shipped_at: null,
      completion_ms: 1,
      final_rank: 1,
      total_votes: 0,
      stats: {},
      capture_status: 'captured',
      screenshot_path: `${ID}/b1.png`,
    },
  ],
  awards: [],
};

function setup(loadBattle: PreviewDeps['loadBattle'] = () => Promise.resolve(BATTLE)) {
  const assets = vi.fn((request: Request) => {
    const path = new URL(request.url).pathname;
    if (path !== SHELL_PATH) return Promise.resolve(new Response('asset', { status: 299 }));
    return Promise.resolve(
      new Response(SHELL, {
        headers: { 'content-type': 'text/html', etag: '"shell"', 'cache-control': 'max-age=0' },
      }),
    );
  });
  const load = vi.fn(loadBattle);
  const warn = vi.fn();
  const deps: PreviewDeps = {
    assets,
    loadBattle: load,
    // The real one is HTMLRewriter: here the head replaces the shell's.
    inject: (_shell, html) => new Response(`<html><head>${html}</head></html>`),
    headers: SECURITY,
    siteUrl: null,
    timeoutMs: 50,
    warn,
  };
  const run = (path: string, init?: RequestInit) =>
    handlePreview(new Request(`https://br.example${path}`, init), deps);
  return { run, assets, load, warn, deps };
}

describe('the link-preview Function, per case', () => {
  it('a public battle: 200 with its head, the security headers, no ETag', async () => {
    const { run, load, assets } = setup();
    const res = await run(`/battles/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-br-preview')).toBe('battle');
    const html = await res.text();
    expect(html).toContain('<title>Board Games by Ana · Build Roulette</title>');
    expect(html).toContain(`<meta property="og:url" content="https://br.example/battles/${ID}"/>`);
    expect(html).toContain(
      `content="http://127.0.0.1:54321/storage/v1/object/public/screenshots/${ID}/b1.png"`,
    );
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('cache-control')).toBe('max-age=0');
    expect(res.headers.get('etag')).toBeNull();
    expect(load).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    // The shell is asked for with a plain GET (no conditional headers from the client).
    const shellRequest = assets.mock.calls[0]?.[0];
    expect(shellRequest?.url).toBe('https://br.example/battles');
    expect(shellRequest?.headers.get('if-none-match')).toBeNull();
  });

  it('the canonical origin is the configured site URL when there is one', async () => {
    const { deps } = setup();
    const res = await handlePreview(new Request(`https://x.pages.dev/battles/${ID}`), {
      ...deps,
      siteUrl: 'https://buildroulette.example',
    });
    expect(await res.text()).toContain(`href="https://buildroulette.example/battles/${ID}"`);
  });

  it('an unknown or not-yet-public battle: 404 with the "not found" head', async () => {
    const { run } = setup(() => Promise.resolve(null));
    const res = await run(`/battles/${ID}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-br-preview')).toBe('not-found');
    const html = await res.text();
    expect(html).toContain('<title>Battle not found · Build Roulette</title>');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  it('a malformed id: 404 without calling Supabase', async () => {
    const { run, load } = setup();
    for (const path of ['/battles/not-a-uuid', '/battles/%22%3E%3Cscript%3E']) {
      const res = await run(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('x-br-preview')).toBe('malformed');
      expect(await res.text()).toContain('Battle not found');
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('fail open: Supabase errors → the shell unchanged, 200', async () => {
    const { run, warn } = setup(() => Promise.reject(new Error('HTTP 503')));
    const res = await run(`/battles/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-br-preview')).toBe('fail-open; reason=error');
    expect(await res.text()).toBe(SHELL);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fail open: Supabase slower than the timeout → the shell unchanged, 200, on time', async () => {
    const { run } = setup(() => new Promise<never>(() => undefined)); // never answers
    const started = performance.now();
    const res = await run(`/battles/${ID}`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-br-preview')).toBe('fail-open; reason=timeout');
    expect(await res.text()).toBe(SHELL);
  });

  it('the timeout aborts the request it gave up on', async () => {
    let seen: AbortSignal | null = null;
    const { run } = setup(
      (_id, signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    await run(`/battles/${ID}`);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it('fail open: an answer that is not get_public_battle’s shape', async () => {
    for (const odd of [{}, { builds: [null], challenge: BATTLE.challenge }, 'text', []]) {
      const { run } = setup(() => Promise.resolve(odd as unknown as PublicBattle));
      const res = await run(`/battles/${ID}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-br-preview')).toBe('fail-open; reason=shape');
      expect(await res.text()).toBe(SHELL);
    }
  });

  it('HEAD: the same status and headers, no body', async () => {
    const { run } = setup(() => Promise.resolve(null));
    const res = await run(`/battles/${ID}`, { method: 'HEAD' });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-br-preview')).toBe('not-found');
    expect(res.body).toBeNull();
  });

  it('other paths and methods go to the static assets untouched', async () => {
    const { run, load, assets } = setup();
    for (const [path, method] of [
      ['/battles', 'GET'],
      [`/battles/${ID}/extra`, 'GET'],
      [`/battles/${ID}`, 'POST'],
    ] as const) {
      const res = await run(path, { method });
      // The very response the assets gave (the client's own request, not the shell's).
      expect(res, `${method} ${path}`).toBe(await assets.mock.results.at(-1)?.value);
      expect(res.headers.get('x-br-preview')).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
    expect(assets.mock.calls.map(([r]) => new URL(r.url).pathname)).toEqual([
      '/battles',
      `/battles/${ID}/extra`,
      `/battles/${ID}`,
    ]);
  });

  it('a shell that is not there is passed on as it is', async () => {
    const { deps } = setup();
    const res = await handlePreview(new Request(`https://br.example/battles/${ID}`), {
      ...deps,
      assets: () => Promise.resolve(new Response('gone', { status: 404 })),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('gone');
  });
});
