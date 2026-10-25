// @vitest-environment happy-dom
/**
 * The link import (docs/10, T-052): the form's states (an invalid link fails at once without a
 * request, copying can be cancelled, a good copy takes the folder's path), the call to the
 * `import-url` function, every error code worded in English and Turkish, the session asked
 * for only when a link is imported (`/try`), the remembered link, and the analytics event
 * without the link.
 */
import { IMPORT_URL_HOSTS, packSite, type ImportResult } from '@br/site';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../lib/i18n/messages/en';
import { tr } from '../../lib/i18n/messages/tr';
import { parseTestOrigins } from '../../lib/site/link-config';
import {
  LINK_ERROR_CODES,
  copyFromLink,
  isLinkRoot,
  linkHost,
  supabaseLinkCopier,
  type LinkCopier,
  type LinkResult,
} from '../../lib/site/link-import';
import { LINK_KEY_PREFIX, linkScope, recallLink, rememberLink } from '../../lib/site/link-memory';
import { useSiteImport, type ImportState, type LinkImport } from '../../lib/site/use-site-import';
import { sanitizeProps } from '../../lib/telemetry/analytics';
import { fakeSite } from '../../lib/solo/test-support';
import { DropZone, importErrorText } from './DropZone';
import { ImportBar } from './ImportBar';

const BATTLE = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';
const LINK = 'https://my-app.lovable.app/';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

function copiedSite(label = 'Copied'): LinkResult {
  return { ok: true, site: { ...fakeSite(label), root: LINK, skipped: 0 } };
}

function linkHook(copy: LinkCopier, opts: { battleId?: string | null; extra?: string[] } = {}) {
  const onImported = vi.fn();
  const track = vi.fn();
  const files = vi.fn((): Promise<ImportResult> =>
    Promise.resolve({ ok: true, site: fakeSite('Folder') }),
  );
  const link: LinkImport = { copy, extraOrigins: opts.extra ?? [] };
  const { result } = renderHook(() =>
    useSiteImport({
      onImported,
      battleId: opts.battleId === undefined ? BATTLE : opts.battleId,
      link,
      readers: { drop: () => files(), files },
      track,
    }),
  );
  return { result, onImported, track, files };
}

describe('useSiteImport: links', () => {
  it('an invalid link fails at once, without a request; the event has the code only', () => {
    const copy = vi.fn<LinkCopier>();
    const { result, track } = linkHook(copy);
    act(() => {
      result.current.fromLink('not a link');
    });
    expect(copy).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      status: 'error',
      error: { code: 'url-invalid' },
      via: 'link',
    });
    act(() => {
      result.current.fromLink('https://example.com/secret-path');
    });
    expect(copy).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      status: 'error',
      error: { code: 'url-host-not-allowed' },
      via: 'link',
    });
    expect(track).toHaveBeenLastCalledWith('site_import', {
      battle_id: BATTLE,
      source: 'link',
      outcome: 'error',
      error: 'url_host_not_allowed',
    });
    // Never the link or its host.
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/example|secret/);
  });

  it('copying: the state says so, Cancel aborts it and a late answer is ignored', async () => {
    let answer: (r: LinkResult) => void = () => undefined;
    let signal: AbortSignal | null = null;
    const copy = vi.fn<LinkCopier>(
      (_url, s) =>
        new Promise((resolve) => {
          signal = s;
          answer = resolve;
        }),
    );
    const { result, onImported, track } = linkHook(copy);
    act(() => {
      result.current.fromLink(`  ${LINK}  `);
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]?.[0].href).toBe(LINK);
    expect(result.current.state).toEqual({ status: 'reading', via: 'link' });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(track).toHaveBeenLastCalledWith('site_import', {
      battle_id: BATTLE,
      source: 'link',
      outcome: 'cancelled',
      error: null,
    });
    await act(async () => {
      answer(copiedSite());
      await Promise.resolve();
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(recallLink(linkScope(BATTLE))).toBeNull();
  });

  it('a good copy takes the folder path (onImported), is remembered, and the event has no link', async () => {
    const site = copiedSite();
    const { result, onImported, track } = linkHook(() => Promise.resolve(site));
    expect(result.current.linkEnabled).toBe(true);
    expect(result.current.lastLink).toBeNull();
    await act(async () => {
      result.current.fromLink(LINK);
      await Promise.resolve();
    });
    expect(onImported).toHaveBeenCalledWith(site.ok ? site.site : null, 'link');
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastLink).toBe(LINK);
    expect(recallLink(linkScope(BATTLE))).toBe(LINK);
    expect(track).toHaveBeenCalledWith('site_import', {
      battle_id: BATTLE,
      source: 'link',
      outcome: 'ok',
      error: null,
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('lovable');
    // What would be sent: only enums and the battle's UUID.
    expect(sanitizeProps(track.mock.calls[0]?.[1] as object)).toEqual({
      battle_id: BATTLE,
      source: 'link',
      outcome: 'ok',
      error: null,
    });
  });

  it('a refused copy: the link error state and its code in the event', async () => {
    const { result, onImported, track } = linkHook(() =>
      Promise.resolve({ ok: false, error: { code: 'url-private', detail: 'my-app.lovable.app' } }),
    );
    await act(async () => {
      result.current.fromLink(LINK);
      await Promise.resolve();
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      status: 'error',
      error: { code: 'url-private', detail: 'my-app.lovable.app' },
      via: 'link',
    });
    expect(track).toHaveBeenCalledWith(
      'site_import',
      expect.objectContaining({ source: 'link', outcome: 'error', error: 'url_private' }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain('lovable');
  });

  it('a folder picked while a link is copied wins and stops the copy', async () => {
    let signal: AbortSignal | null = null;
    const copy: LinkCopier = (_u, s) => {
      signal = s;
      return new Promise(() => undefined);
    };
    const { result, onImported } = linkHook(copy);
    act(() => {
      result.current.fromLink(LINK);
    });
    await act(async () => {
      result.current.fromFiles([new File(['x'], 'index.html')], 'folder');
      await Promise.resolve();
    });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0]?.[1]).toBe('folder');
  });

  it('test-only origins pass the check only when the build lists them', () => {
    const copy = vi.fn<LinkCopier>(() => new Promise(() => undefined));
    const local = 'http://host.docker.internal:4330/';
    const without = linkHook(copy);
    act(() => {
      without.result.current.fromLink(local);
    });
    expect(copy).not.toHaveBeenCalled();
    cleanup();
    const listed = linkHook(copy, { extra: parseTestOrigins('http://host.docker.internal:4330') });
    act(() => {
      listed.result.current.fromLink(local);
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(parseTestOrigins(' http://a.test:1/x, nope, ftp://b.test ')).toEqual([
      'http://a.test:1',
    ]);
  });

  it('no link import on the page: fromLink is ignored', () => {
    const { result } = renderHook(() =>
      useSiteImport({ onImported: vi.fn(), battleId: null, track: vi.fn() }),
    );
    expect(result.current.linkEnabled).toBe(false);
    act(() => {
      result.current.fromLink(LINK);
    });
    expect(result.current.state).toEqual({ status: 'idle' });
  });
});

describe('/try: the session only for a link', () => {
  it('a folder import never loads the session; a link signs in once, then calls the function', async () => {
    const accessToken = vi.fn(() => Promise.resolve('token-1'));
    const load = vi.fn(() => Promise.resolve({ accessToken }));
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const copy = supabaseLinkCopier('http://127.0.0.1:54321/', load);
      const { result } = linkHook(copy, { battleId: null });
      await act(async () => {
        result.current.fromFiles([new File(['x'], 'index.html')], 'zip');
        await Promise.resolve();
      });
      expect(load).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      await act(async () => {
        result.current.fromLink(LINK);
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(load).toHaveBeenCalledTimes(1);
      expect(accessToken).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:54321/functions/v1/import-url');
      expect(result.current.state).toMatchObject({ status: 'error', error: { code: 'internal' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a failed sign-in is the generic server error', async () => {
    const copy = supabaseLinkCopier('http://127.0.0.1:54321', () =>
      Promise.resolve({ accessToken: () => Promise.reject(new Error('captcha')) }),
    );
    expect(await copy(new URL(LINK), new AbortController().signal)).toEqual({
      ok: false,
      error: { code: 'network', detail: 'session' },
    });
  });
});

describe('copyFromLink', () => {
  const endpoint = 'http://127.0.0.1:54321/functions/v1/import-url';
  const pack = packSite([
    { path: 'index.html', type: 'text/html', bytes: new TextEncoder().encode('<h1>x</h1>') },
    { path: 'a.js', type: 'text/javascript', bytes: new TextEncoder().encode('1') },
  ]);
  const call = (res: Response | Error) => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      res instanceof Error ? Promise.reject(res) : Promise.resolve(res),
    );
    const result = copyFromLink(new URL(LINK), new AbortController().signal, {
      endpoint,
      accessToken: () => Promise.resolve('tok'),
      fetch: fetchSpy,
    });
    return { result, fetchSpy };
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('the pack: counted and checked here; the root is the copied address', async () => {
    const { result, fetchSpy } = call(
      new Response(pack, {
        status: 200,
        headers: { 'x-site-root': 'https://my-app.lovable.app/home/', 'x-site-skipped': '3' },
      }),
    );
    const r = await result;
    expect(r.ok && { ...r.site, pack: null }).toEqual({
      pack: null,
      root: 'https://my-app.lovable.app/home/',
      files: 2,
      bytes: 11,
      skipped: 3,
    });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
    });
    expect(init?.body).toBe(JSON.stringify({ url: LINK }));
  });

  it('without the headers (a gateway that hides them) the link is the root', async () => {
    const r = await call(new Response(pack, { status: 200 })).result;
    expect(r.ok && [r.site.root, r.site.skipped]).toEqual([LINK, 0]);
  });

  it('error answers become link errors; rate-limited carries the wait', async () => {
    expect(await call(json(422, { code: 'url-private' })).result).toEqual({
      ok: false,
      error: { code: 'url-private' },
    });
    expect(await call(json(422, { code: 'url-unreachable', detail: '404' })).result).toEqual({
      ok: false,
      error: { code: 'url-unreachable', detail: '404' },
    });
    expect(
      await call(json(429, { code: 'rate-limited', detail: '42', retry_after: 41.2 })).result,
    ).toEqual({ ok: false, error: { code: 'rate-limited', detail: '42' } });
    expect(await call(json(429, { code: 'rate-limited' }, { 'retry-after': '30' })).result).toEqual(
      { ok: false, error: { code: 'rate-limited', detail: '30' } },
    );
    expect(await call(json(401, { code: 'unauthenticated' })).result).toMatchObject({
      error: { code: 'unauthenticated' },
    });
    // Unknown codes, a gateway's HTML page, a broken pack, no answer.
    expect(await call(json(418, { code: 'teapot' })).result).toMatchObject({
      error: { code: 'internal' },
    });
    expect(await call(new Response('<html>', { status: 502 })).result).toMatchObject({
      error: { code: 'internal' },
    });
    expect(await call(new Response('not a pack', { status: 200 })).result).toEqual({
      ok: false,
      error: { code: 'internal', detail: 'pack' },
    });
    expect(await call(new TypeError('Failed to fetch')).result).toEqual({
      ok: false,
      error: { code: 'network' },
    });
  });

  it('link roots and hosts', () => {
    expect(isLinkRoot(LINK)).toBe(true);
    expect(isLinkRoot('dist/')).toBe(false);
    expect(isLinkRoot('')).toBe(false);
    expect(linkHost(LINK)).toBe('my-app.lovable.app');
    expect(linkHost('http://host.docker.internal:4330/')).toBe('host.docker.internal:4330');
    expect(linkHost('my-app/dist/')).toBeNull();
  });
});

describe('every link error, in English and Turkish', () => {
  it('a title and a hint for each code, different in Turkish', () => {
    for (const code of LINK_ERROR_CODES) {
      for (const detail of [undefined, '30', '404']) {
        const a = en.linkErrors[code](detail);
        const b = tr.linkErrors[code](detail);
        expect(a.title.length, code).toBeGreaterThan(3);
        expect(a.hint.length, code).toBeGreaterThan(10);
        expect(b.title, code).not.toBe(a.title);
        expect(b.hint, code).not.toBe(a.hint);
      }
    }
  });

  it('says what to do', () => {
    expect(en.linkErrors['url-private']().hint).toContain(
      'Make the site public in your builder and publish again',
    );
    const hosts = en.linkErrors['url-host-not-allowed']().hint;
    for (const h of IMPORT_URL_HOSTS) expect(hosts).toContain(`*.${h}`);
    expect(hosts).toContain('download the code');
    expect(tr.linkErrors['url-host-not-allowed']().hint).toContain('*.lovable.app');
    expect(en.linkErrors['rate-limited']('45')).toEqual({
      title: 'Too many imports',
      hint: 'Try again in 45 s, or drop the built folder instead.',
    });
    expect(en.linkErrors['rate-limited']('600').hint).toContain('10 min');
    expect(tr.linkErrors['rate-limited']('45').hint).toContain('45 sn');
    expect(en.linkErrors['url-unreachable']('404').hint).toContain('It answered 404.');
    expect(en.linkErrors['url-unreachable']('no connection').hint).not.toContain('answered');
    for (const code of [
      'unauthenticated',
      'origin-not-allowed',
      'method-not-allowed',
      'internal',
      'network',
    ] as const) {
      expect(en.linkErrors[code]().title).toBe("Couldn't reach the game's server");
      expect(tr.linkErrors[code]().title).toBe('Oyunun sunucusuna ulaşılamadı');
    }
  });

  it('importErrorText picks the link catalog for a link, the import one otherwise', () => {
    expect(
      importErrorText({ status: 'error', error: { code: 'too-large' }, via: 'link' }, en).hint,
    ).toContain('publish again');
    expect(importErrorText({ status: 'error', error: { code: 'too-large' } }, en).hint).toContain(
      'build again',
    );
  });
});

describe('the link field in the drop zone', () => {
  function zone(state: ImportState, over: { lastLink?: string | null; disabled?: boolean } = {}) {
    const link = { onSubmit: vi.fn(), onCancel: vi.fn(), lastLink: over.lastLink ?? null };
    render(
      createElement(DropZone, {
        state,
        openFolder: vi.fn(),
        openZip: vi.fn(),
        onDismissError: vi.fn(),
        disabled: over.disabled ?? false,
        link,
      }),
    );
    return link;
  }

  it('a labelled URL field and Import; Enter submits what was typed', () => {
    const link = zone({ status: 'idle' });
    const input = screen.getByLabelText('…or paste the link of your published site');
    expect(input.getAttribute('type')).toBe('url');
    expect(input.getAttribute('placeholder')).toBe('https://my-app.lovable.app');
    fireEvent.change(input, { target: { value: LINK } });
    fireEvent.submit(screen.getByTestId('link-form'));
    expect(link.onSubmit).toHaveBeenCalledWith(LINK);
    fireEvent.click(screen.getByRole('button', { name: /Import$/ }));
    expect(link.onSubmit).toHaveBeenCalledTimes(2);
  });

  it('the hosts it works for, the full list on demand', () => {
    zone({ status: 'idle' });
    expect(screen.getByTestId('link-form').textContent).toContain(
      'Works with sites published on Lovable, Netlify, Vercel, GitHub Pages, Replit, Bolt…',
    );
    const toggle = screen.getByTestId('link-hosts-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('link-hosts').hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('link-hosts').hidden).toBe(false);
    expect(screen.getByTestId('link-hosts').textContent).toContain('*.lovable.app');
  });

  it('copying: "Copying your site…" (a status) with Cancel; the controls wait', () => {
    const link = zone({ status: 'reading', via: 'link' }, { lastLink: LINK });
    expect(screen.getByRole('status').textContent).toContain('Copying your site…');
    expect(screen.getByTestId<HTMLInputElement>('link-input').value).toBe(LINK);
    expect(screen.getByTestId<HTMLInputElement>('link-input').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('link-import').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('choose-folder').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('link-cancel'));
    expect(link.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('import-reading')).toBeNull();
  });

  it('a link error under the field, which it describes', () => {
    zone({ status: 'error', error: { code: 'url-private' }, via: 'link' });
    const input = screen.getByTestId('link-input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const note = screen.getByRole('alert');
    expect(screen.getByTestId('link-form').contains(note)).toBe(true);
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.some((id) => document.getElementById(id)?.contains(note))).toBe(true);
    expect(screen.getByTestId('import-error-title').textContent).toBe('That site is private');
  });

  it('a folder error stays where it was; closed imports show no field', () => {
    zone({ status: 'error', error: { code: 'not-built' } });
    expect(screen.getByTestId('link-form').contains(screen.getByRole('alert'))).toBe(false);
    expect(screen.getByTestId('link-input').getAttribute('aria-invalid')).toBeNull();
    cleanup();
    zone({ status: 'idle' }, { disabled: true });
    expect(screen.queryByTestId('link-form')).toBeNull();
  });

  it('no link import: no field', () => {
    render(
      createElement(DropZone, {
        state: { status: 'idle' },
        openFolder: vi.fn(),
        openZip: vi.fn(),
        onDismissError: vi.fn(),
      }),
    );
    expect(screen.queryByTestId('link-form')).toBeNull();
  });
});

describe('the import bar after a link', () => {
  const site = { ...fakeSite('Copied'), root: LINK, skipped: 0 };
  function bar(state: ImportState, lastLink: string | null = LINK) {
    const link = { onSubmit: vi.fn(), onCancel: vi.fn(), lastLink };
    render(
      createElement(ImportBar, {
        site,
        state,
        openFolder: vi.fn(),
        openZip: vi.fn(),
        onDismissError: vi.fn(),
        link,
      }),
    );
    return link;
  }

  it('"Copied from <host>" instead of a folder name', () => {
    bar({ status: 'idle' });
    expect(screen.getByTestId('import-summary').textContent.trim()).toMatch(
      /^Copied from my-app\.lovable\.app · 1 file · \d+ B$/,
    );
  });

  it('Import again: "Copy again from <host>" in one click, or "Paste a link…"', () => {
    const link = bar({ status: 'idle' }, 'https://other.netlify.app/');
    fireEvent.click(screen.getByTestId('import-again'));
    expect(screen.getByTestId('import-again-link').textContent).toContain(
      'Copy again from other.netlify.app',
    );
    fireEvent.click(screen.getByTestId('import-again-link'));
    expect(link.onSubmit).toHaveBeenCalledWith('https://other.netlify.app/');
    fireEvent.click(screen.getByTestId('import-again'));
    fireEvent.click(screen.getByTestId('import-again-paste'));
    const input = screen.getByTestId<HTMLInputElement>('link-input');
    expect(input.value).toBe('https://other.netlify.app/');
    fireEvent.change(input, { target: { value: 'https://new.vercel.app' } });
    fireEvent.submit(screen.getByTestId('link-form'));
    expect(link.onSubmit).toHaveBeenLastCalledWith('https://new.vercel.app');
  });

  it('nothing remembered: the copied address is offered again', () => {
    const link = bar({ status: 'idle' }, null);
    fireEvent.click(screen.getByTestId('import-again'));
    fireEvent.click(screen.getByTestId('import-again-link'));
    expect(link.onSubmit).toHaveBeenCalledWith(LINK);
  });

  it('copying from the bar: the status and Cancel; Import again waits', () => {
    const link = bar({ status: 'reading', via: 'link' });
    expect(screen.getByTestId('link-copying').textContent).toBe('Copying your site…');
    fireEvent.click(screen.getByTestId('link-cancel'));
    expect(link.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId<HTMLButtonElement>('import-again').disabled).toBe(true);
  });

  it('a link error under the bar, in Turkish too', () => {
    bar({ status: 'error', error: { code: 'rate-limited', detail: '45' }, via: 'link' });
    expect(screen.getByTestId('import-error-hint').textContent).toBe(
      'Try again in 45 s, or drop the built folder instead.',
    );
  });
});

describe('the remembered link', () => {
  it('per battle (only the current one kept) and one for /try', () => {
    rememberLink(linkScope('b1'), 'https://one.lovable.app/');
    rememberLink(linkScope(null), 'https://try.netlify.app/');
    expect(recallLink(linkScope('b1'))).toBe('https://one.lovable.app/');
    rememberLink(linkScope('b2'), 'https://two.lovable.app/');
    expect(recallLink(linkScope('b1'))).toBeNull();
    expect(recallLink(linkScope('b2'))).toBe('https://two.lovable.app/');
    expect(recallLink('try')).toBe('https://try.netlify.app/');
    expect(Object.keys(localStorage).filter((k) => k.startsWith(LINK_KEY_PREFIX))).toHaveLength(2);
  });

  it('a stored value that is not a link is ignored; blocked storage remembers nothing', () => {
    localStorage.setItem(`${LINK_KEY_PREFIX}try`, 'javascript:alert(1)');
    expect(recallLink('try')).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    expect(recallLink('try', blocked)).toBeNull();
    expect(() => {
      rememberLink('try', LINK, blocked);
    }).not.toThrow();
  });

  it('the hook starts with the remembered link of its battle', () => {
    rememberLink(linkScope(BATTLE), LINK);
    const { result } = linkHook(() => new Promise(() => undefined));
    expect(result.current.lastLink).toBe(LINK);
  });
});
